// OrderPing - server minimal
// ---------------------------------------------------------
// Ce face acest fisier:
//  - tine minte comenzile intr-o baza de date reala (MongoDB), nu se mai pierd
//  - ofera cateva adrese ("API") pe care pagina web le foloseste:
//      POST /api/orders                -> creeaza o comanda noua
//      GET  /api/orders                -> lista comenzilor active (pt panoul bucatariei)
//      GET  /api/orders/by-number/:n   -> gaseste o comanda dupa numarul de pe bon
//      GET  /api/orders/:id            -> starea unei comenzi (pt clientul care asteapta)
//      POST /api/orders/:id/ready      -> marcheaza "gata" + trimite notificarea reala
//      POST /api/orders/:id/done       -> marcheaza "ridicata"
//      POST /api/orders/:id/subscribe  -> telefonul clientului se "aboneaza" la notificari
//      GET  /api/vapid-public-key      -> cheia publica necesara pt notificari push
//      GET  /api/orders/:id/qrcode.png -> imaginea cu codul QR al comenzii (scanabil)
//
// NOTA: comenzile se tin acum in MongoDB (baza de date persistenta), nu mai
// in memorie - asa ca nu se pierd cand serverul reporneste/adoarme.

const express = require('express');
const webpush = require('web-push');
const crypto = require('crypto');
const path = require('path');
const { MongoClient } = require('mongodb');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// Cheile VAPID identifica site-ul tau fata de serviciile de
// notificari (Google/Mozilla/Apple). Sunt generate o singura data.
// TODO pentru mai tarziu: muta-le in variabile de mediu (Environment
// Variables) din panoul Render, in loc sa stea direct in cod.
const VAPID_PUBLIC_KEY = 'BPCiNh34_u2lJWchRdzlUe0pKzh6uAjPLtqLj0t_NfufdaSbs-6Hf85KrkS1pepJpafGPgKeB5sjMtYTqPaeR_g';
const VAPID_PRIVATE_KEY = 'v5sss1G-24k6DtCC69BWCyuzOzTbPiuw4ktTBpvCams';

webpush.setVapidDetails(
  'mailto:montterius@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ---------------------------------------------------------
// Conectarea la baza de date (MongoDB Atlas).
// Adresa vine dintr-o variabila de mediu (Environment Variable) setata
// pe Render - NU e scrisa direct in cod, ca sa nu fie vizibila pe GitHub.
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('LIPSESTE variabila de mediu MONGODB_URI. Seteaz-o in Render, in sectiunea "Environment".');
}

let ordersCollection = null;

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(); // foloseste baza de date din adresa (ex: "orderping")
  ordersCollection = db.collection('orders');
  console.log('Conectat la MongoDB.');
}

function publicOrder(o) {
  return {
    id: o._id,
    number: o.number,
    status: o.status,
    createdAt: o.createdAt,
    readyAt: o.readyAt || null,
  };
}

async function pruneOldOrders() {
  const now = Date.now();
  try {
    await ordersCollection.deleteMany({
      $or: [
        { status: 'done', doneAt: { $lt: now - 60 * 60 * 1000 } }, // ridicate de > 1h
        { createdAt: { $lt: now - 6 * 60 * 60 * 1000 } }, // orice comanda mai veche de 6h
      ],
    });
  } catch (err) {
    console.error('Eroare la stergerea comenzilor vechi:', err);
  }
}

// ---------------------------------------------------------
// Trimite notificarea reala (push) catre toate telefoanele
// abonate la acea comanda. Scoate din lista abonarile care
// nu mai sunt valabile (telefonul a dezinstalat/refuzat).
async function notifyOrderReady(order) {
  const payload = JSON.stringify({
    title: '🔔 Comanda ta e gata!',
    body: 'Comanda #' + order.number + ' e gata de ridicare.',
    orderId: order._id,
  });

  const stillValid = [];
  for (const sub of order.subscriptions || []) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // abonare expirata/invalida - o eliminam din lista
      } else {
        console.error('Eroare la trimiterea notificarii push:', code, err && err.body);
        stillValid.push(sub); // eroare trecatoare - o pastram, mai incercam data viitoare
      }
    }
  }
  await ordersCollection.updateOne({ _id: order._id }, { $set: { subscriptions: stillValid } });
}

// ---------------------------------------------------------
// Rute API

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/orders', async (req, res) => {
  try {
    const order = {
      _id: crypto.randomUUID(),
      number: Math.floor(Math.random() * 900) + 100, // 100-999
      status: 'pending',
      createdAt: Date.now(),
      readyAt: null,
      subscriptions: [],
    };
    await ordersCollection.insertOne(order);
    res.status(201).json(publicOrder(order));
  } catch (err) {
    console.error('Eroare la creare comanda:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const list = await ordersCollection
      .find({ status: { $ne: 'done' } })
      .sort({ createdAt: 1 })
      .toArray();
    res.json(list.map(publicOrder));
  } catch (err) {
    console.error('Eroare la listare comenzi:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/orders/by-number/:number', async (req, res) => {
  try {
    const num = parseInt(req.params.number, 10);
    if (Number.isNaN(num)) return res.status(400).json({ error: 'numar invalid' });

    const matches = await ordersCollection.find({ number: num }).sort({ createdAt: -1 }).toArray();
    if (matches.length === 0) return res.status(404).json({ error: 'negasita' });

    const chosen = matches.find(o => o.status !== 'done') || matches[0];
    res.json(publicOrder(chosen));
  } catch (err) {
    console.error('Eroare la cautare comanda:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'negasita' });
    res.json(publicOrder(order));
  } catch (err) {
    console.error('Eroare la citire comanda:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/ready', async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'negasita' });

    const readyAt = Date.now();
    await ordersCollection.updateOne({ _id: order._id }, { $set: { status: 'ready', readyAt } });
    res.json(publicOrder({ ...order, status: 'ready', readyAt }));

    // trimitem notificarea dupa ce am raspuns, ca bucataria sa nu astepte
    notifyOrderReady(order).catch(err => console.error('notifyOrderReady a esuat:', err));
  } catch (err) {
    console.error('Eroare la marcarea comenzii gata:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/done', async (req, res) => {
  try {
    const doneAt = Date.now();
    const result = await ordersCollection.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { status: 'done', doneAt } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'negasita' });
    res.json(publicOrder(result));
  } catch (err) {
    console.error('Eroare la marcarea comenzii ridicata:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// Genereaza "din mers" imaginea codului QR pentru o comanda. Codul QR
// contine adresa site-ului + numarul comenzii (?order=...), deci atunci
// cand clientul il scaneaza cu telefonul, e dus direct la ecranul de
// urmarire a comenzii lui, fara sa mai introduca manual niciun cod.
app.get('/api/orders/:id/qrcode.png', async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).end();

    const baseUrl = req.protocol + '://' + req.get('host');
    const trackingUrl = baseUrl + '/?order=' + order._id;

    res.set('Content-Type', 'image/png');
    await QRCode.toFileStream(res, trackingUrl, { width: 240, margin: 1 });
  } catch (err) {
    console.error('Eroare la generare cod QR:', err);
    res.status(500).end();
  }
});

app.post('/api/orders/:id/subscribe', async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'negasita' });

    const subscription = req.body && req.body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'abonare invalida' });
    }
    const already = (order.subscriptions || []).some(s => s.endpoint === subscription.endpoint);
    if (!already) {
      await ordersCollection.updateOne({ _id: order._id }, { $push: { subscriptions: subscription } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Eroare la abonare:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// ---------------------------------------------------------
// Pornirea serverului - ne conectam intai la baza de date,
// abia apoi incepem sa raspundem la cereri.
const PORT = process.env.PORT || 3000;

connectToDatabase()
  .then(() => {
    setInterval(pruneOldOrders, 10 * 60 * 1000);
    app.listen(PORT, () => {
      console.log('OrderPing server ruleaza pe portul ' + PORT);
    });
  })
  .catch(err => {
    console.error('Nu m-am putut conecta la baza de date:', err);
    process.exit(1);
  });
