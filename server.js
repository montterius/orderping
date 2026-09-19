// OrderPing - server minimal
// ---------------------------------------------------------
// Ce face acest fisier:
//  - tine minte comenzile intr-o baza de date reala (MongoDB), nu se mai pierd
//  - tine minte restaurantele care au cont (fiecare cu user + parola proprii)
//  - ofera cateva adrese ("API") pe care pagina web le foloseste:
//      POST /api/login                 -> login bucatarie (user+parola -> token)
//      POST /api/orders                -> creeaza o comanda noua (necesita login)
//      GET  /api/orders                -> lista comenzilor active ale restaurantului logat (necesita login)
//      GET  /api/restaurants           -> lista restaurantelor active (doar nume) - nefolosita de pagina clientului momentan, pastrata pt viitor
//      GET  /api/orders/by-number/:n   -> gaseste o comanda dupa numar SI restaurant (?restaurantId=...) - nefolosita de pagina clientului momentan, pastrata pt viitor
//      GET  /api/orders/:id            -> starea unei comenzi (pt clientul care asteapta)
//      POST /api/orders/:id/ready      -> marcheaza "gata" + trimite notificarea reala (necesita login)
//      POST /api/orders/:id/done       -> marcheaza "ridicata" (necesita login)
//      POST /api/orders/:id/subscribe  -> telefonul clientului se "aboneaza" la notificari
//      GET  /api/vapid-public-key      -> cheia publica necesara pt notificari push
//      GET  /api/orders/:id/qrcode.png -> imaginea cu codul QR al comenzii (scanabil)
//      POST /api/admin/restaurants           -> (doar tu) creeaza un cont nou de restaurant
//      GET  /api/admin/restaurants           -> (doar tu) lista restaurantelor
//      POST /api/admin/restaurants/:id/toggle -> (doar tu) activeaza/dezactiveaza un restaurant
//
// NOTA: comenzile si restaurantele se tin in MongoDB (baza de date persistenta),
// nu in memorie - asa ca nu se pierd cand serverul reporneste/adoarme.

const express = require('express');
const webpush = require('web-push');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// Cheile VAPID identifica site-ul tau fata de serviciile de
// notificari (Google/Mozilla/Apple). Vin din variabile de mediu
// (Environment Variables) setate pe Render - NU mai sunt scrise
// direct in cod, ca sa nu fie vizibile pe GitHub.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('LIPSESC variabilele de mediu VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Seteaza-le in Render, in sectiunea "Environment".');
} else {
  webpush.setVapidDetails(
    'mailto:montterius@gmail.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// ---------------------------------------------------------
// JWT_SECRET e folosit ca sa "semnam" biletele de login (token-urile)
// ale bucatariilor, ca sa nu poata fi falsificate. ADMIN_KEY e parola
// TA, pentru pagina secreta de administrare (/admin.html). Ambele vin
// din Environment Variables pe Render - nu sunt scrise in cod.
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!JWT_SECRET) {
  console.error('LIPSESTE variabila de mediu JWT_SECRET. Seteaz-o in Render, in sectiunea "Environment".');
}
if (!ADMIN_KEY) {
  console.error('LIPSESTE variabila de mediu ADMIN_KEY. Seteaz-o in Render, in sectiunea "Environment".');
}

// ---------------------------------------------------------
// Conectarea la baza de date (MongoDB Atlas).
// Adresa vine dintr-o variabila de mediu (Environment Variable) setata
// pe Render - NU e scrisa direct in cod, ca sa nu fie vizibila pe GitHub.
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('LIPSESTE variabila de mediu MONGODB_URI. Seteaz-o in Render, in sectiunea "Environment".');
}

let ordersCollection = null;
let restaurantsCollection = null;

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(); // foloseste baza de date din adresa (ex: "orderping")
  ordersCollection = db.collection('orders');
  restaurantsCollection = db.collection('restaurants');
  console.log('Conectat la MongoDB.');
}

function publicOrder(o, extra) {
  const out = {
    id: o._id,
    number: o.number,
    status: o.status,
    createdAt: o.createdAt,
    readyAt: o.readyAt || null,
  };
  if (extra && extra.restaurantName) out.restaurantName = extra.restaurantName;
  return out;
}

function publicRestaurant(r) {
  return {
    id: r._id.toString(),
    name: r.name,
    username: r.username,
    active: r.active !== false,
    createdAt: r.createdAt,
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
async function notifyOrderReady(order, restaurantName) {
  const payload = JSON.stringify({
    title: restaurantName ? ('🔔 Comanda de la ' + restaurantName + ' e gata!') : '🔔 Comanda ta e gata!',
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
// Autentificare bucatarie ("e nevoie sa fii logat ca sa faci asta").
// Cere un antet "Authorization: Bearer <token>" primit la login.
// Verifica si daca restaurantul e inca activ - daca a fost dezactivat
// din panoul de admin, accesul se taie imediat, chiar daca token-ul
// tehnic mai e valabil.
async function requireRestaurant(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'neautentificat' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'token_invalid' });
    }

    const restaurant = await restaurantsCollection.findOne({ _id: new ObjectId(payload.restaurantId) });
    if (!restaurant || restaurant.active === false) {
      return res.status(401).json({ error: 'cont_inactiv' });
    }

    req.restaurant = restaurant;
    next();
  } catch (err) {
    console.error('Eroare la autentificare:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
}

// Protectie pentru rutele de admin - cere antetul "x-admin-key" cu
// valoarea exacta a variabilei de mediu ADMIN_KEY. Doar tu cunosti
// aceasta cheie.
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'cheie_admin_invalida' });
  }
  next();
}

// ---------------------------------------------------------
// Rute API

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ----- Login bucatarie -----
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'date_lipsa' });
    }

    const restaurant = await restaurantsCollection.findOne({ username: username.trim() });
    if (!restaurant) return res.status(401).json({ error: 'date_gresite' });

    const ok = await bcrypt.compare(password, restaurant.passwordHash);
    if (!ok) return res.status(401).json({ error: 'date_gresite' });

    if (restaurant.active === false) {
      return res.status(401).json({ error: 'cont_inactiv' });
    }

    const token = jwt.sign({ restaurantId: restaurant._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, name: restaurant.name });
  } catch (err) {
    console.error('Eroare la login:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// ----- Comenzi (bucatarie - necesita login) -----

app.post('/api/orders', requireRestaurant, async (req, res) => {
  try {
    const order = {
      _id: crypto.randomUUID(),
      restaurantId: req.restaurant._id.toString(),
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

app.get('/api/orders', requireRestaurant, async (req, res) => {
  try {
    const list = await ordersCollection
      .find({ restaurantId: req.restaurant._id.toString(), status: { $ne: 'done' } })
      .sort({ createdAt: 1 })
      .toArray();
    res.json(list.map(publicOrder));
  } catch (err) {
    console.error('Eroare la listare comenzi:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/ready', requireRestaurant, async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id, restaurantId: req.restaurant._id.toString() });
    if (!order) return res.status(404).json({ error: 'negasita' });

    const readyAt = Date.now();
    await ordersCollection.updateOne({ _id: order._id }, { $set: { status: 'ready', readyAt } });
    res.json(publicOrder({ ...order, status: 'ready', readyAt }));

    // trimitem notificarea dupa ce am raspuns, ca bucataria sa nu astepte
    notifyOrderReady(order, req.restaurant.name).catch(err => console.error('notifyOrderReady a esuat:', err));
  } catch (err) {
    console.error('Eroare la marcarea comenzii gata:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/done', requireRestaurant, async (req, res) => {
  try {
    const doneAt = Date.now();
    const result = await ordersCollection.findOneAndUpdate(
      { _id: req.params.id, restaurantId: req.restaurant._id.toString() },
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

// ----- Comenzi (client - fara login, oricine are link-ul/codul QR) -----

// Lista restaurantelor active - publica, fara date sensibile (doar id + nume).
// NOTA: pagina clientului (public/index.html) nu mai foloseste aceasta ruta -
// acum clientul urmareste comenzile doar prin scanarea codului QR, care
// identifica deja exact comanda si restaurantul. Ramane disponibila in caz
// ca va fi nevoie de ea din nou mai tarziu.
app.get('/api/restaurants', async (req, res) => {
  try {
    const list = await restaurantsCollection
      .find({ active: { $ne: false } })
      .sort({ name: 1 })
      .toArray();
    res.json(list.map(r => ({ id: r._id.toString(), name: r.name })));
  } catch (err) {
    console.error('Eroare la listare restaurante (public):', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// NOTA: pagina clientului nu mai foloseste aceasta ruta (vezi nota de mai
// sus la /api/restaurants) - ramane disponibila pentru eventuale nevoi viitoare.
app.get('/api/orders/by-number/:number', async (req, res) => {
  try {
    const num = parseInt(req.params.number, 10);
    if (Number.isNaN(num)) return res.status(400).json({ error: 'numar invalid' });

    // Clientul trebuie sa spuna si la ce restaurant e (ales dintr-o lista in
    // pagina), altfel doua restaurante diferite ar putea avea din intamplare
    // comenzi cu acelasi numar si s-ar incurca una cu cealalta.
    const restaurantId = req.query.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: 'restaurant_lipsa' });

    // O comanda "ridicata" (status "done") e considerata inactiva/finalizata -
    // nu mai trebuie sa poata fi gasita prin cautarea manuala dupa numar.
    // Asta evita ca un numar vechi, deja incheiat, sa fie confundat cu unul nou.
    const matches = await ordersCollection
      .find({ number: num, restaurantId: restaurantId, status: { $ne: 'done' } })
      .sort({ createdAt: -1 })
      .toArray();
    if (matches.length === 0) return res.status(404).json({ error: 'negasita' });

    res.json(publicOrder(matches[0]));
  } catch (err) {
    console.error('Eroare la cautare comanda:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'negasita' });

    // Aratam si numele restaurantului, ca clientul sa stie clar "a cui" e
    // fiecare comanda (util mai ales cand urmareste mai multe comenzi deodata).
    let restaurantName = null;
    if (order.restaurantId) {
      try {
        const restaurant = await restaurantsCollection.findOne({ _id: new ObjectId(order.restaurantId) });
        if (restaurant) restaurantName = restaurant.name;
      } catch (e) { /* id invalid sau restaurant sters - ignoram, ramane fara nume */ }
    }

    res.json(publicOrder(order, { restaurantName }));
  } catch (err) {
    console.error('Eroare la citire comanda:', err);
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

// ----- Administrare restaurante (doar tu, cu ADMIN_KEY) -----

app.post('/api/admin/restaurants', requireAdmin, async (req, res) => {
  try {
    const { name, username, password } = req.body || {};
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'date_lipsa' });
    }
    const exists = await restaurantsCollection.findOne({ username: username.trim() });
    if (exists) return res.status(409).json({ error: 'user_existent' });

    const passwordHash = await bcrypt.hash(password, 10);
    const restaurant = {
      name: name.trim(),
      username: username.trim(),
      passwordHash,
      active: true,
      createdAt: Date.now(),
    };
    const result = await restaurantsCollection.insertOne(restaurant);
    restaurant._id = result.insertedId;
    res.status(201).json(publicRestaurant(restaurant));
  } catch (err) {
    console.error('Eroare la creare restaurant:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/admin/restaurants', requireAdmin, async (req, res) => {
  try {
    const list = await restaurantsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(list.map(publicRestaurant));
  } catch (err) {
    console.error('Eroare la listare restaurante:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/admin/restaurants/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const restaurant = await restaurantsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!restaurant) return res.status(404).json({ error: 'negasit' });

    const newActive = !(restaurant.active !== false);
    await restaurantsCollection.updateOne({ _id: restaurant._id }, { $set: { active: newActive } });
    res.json(publicRestaurant({ ...restaurant, active: newActive }));
  } catch (err) {
    console.error('Eroare la activare/dezactivare restaurant:', err);
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
