// OrderPing - server minimal
// ---------------------------------------------------------
// Ce face acest fisier:
//  - tine minte comenzile intr-o lista simpla (in memorie)
//  - ofera cateva adrese ("API") pe care pagina web le foloseste:
//      POST /api/orders                -> creeaza o comanda noua
//      GET  /api/orders                -> lista comenzilor active (pt panoul bucatariei)
//      GET  /api/orders/by-number/:n   -> gaseste o comanda dupa numarul de pe bon
//      GET  /api/orders/:id            -> starea unei comenzi (pt clientul care asteapta)
//      POST /api/orders/:id/ready      -> marcheaza "gata" + trimite notificarea reala
//      POST /api/orders/:id/done       -> marcheaza "ridicata"
//      POST /api/orders/:id/subscribe  -> telefonul clientului se "aboneaza" la notificari
//      GET  /api/vapid-public-key      -> cheia publica necesara pt notificari push
//
// NOTA IMPORTANTA: comenzile se tin in memorie (o simpla lista in RAM).
// Daca serverul reporneste (de ex. planul gratuit Render "adoarme" dupa
// inactivitate), lista se goleste. E perfect pentru un pilot/demo -
// pentru productie reala, urmatorul pas ar fi o baza de date adevarata.

const express = require('express');
const webpush = require('web-push');
const crypto = require('crypto');
const path = require('path');

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
// "Baza de date" - o lista simpla in memorie.
// Map: id comanda -> obiect comanda
const orders = new Map();

function publicOrder(o) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    createdAt: o.createdAt,
    readyAt: o.readyAt || null,
  };
}

function pruneOldOrders() {
  const now = Date.now();
  for (const [id, o] of orders) {
    const ageMs = now - o.createdAt;
    if (o.status === 'done' && ageMs > 60 * 60 * 1000) orders.delete(id); // ridicate de > 1h
    else if (ageMs > 6 * 60 * 60 * 1000) orders.delete(id); // orice comanda mai veche de 6h
  }
}
setInterval(pruneOldOrders, 10 * 60 * 1000);

// ---------------------------------------------------------
// Trimite notificarea reala (push) catre toate telefoanele
// abonate la acea comanda. Scoate din lista abonarile care
// nu mai sunt valabile (telefonul a dezinstalat/refuzat).
async function notifyOrderReady(order) {
  const payload = JSON.stringify({
    title: '🔔 Comanda ta e gata!',
    body: 'Comanda #' + order.number + ' e gata de ridicare.',
    orderId: order.id,
  });

  const stillValid = [];
  for (const sub of order.subscriptions) {
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
  order.subscriptions = stillValid;
}

// ---------------------------------------------------------
// Rute API

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/orders', (req, res) => {
  const id = crypto.randomUUID();
  const number = Math.floor(Math.random() * 900) + 100; // 100-999
  const order = {
    id,
    number,
    status: 'pending',
    createdAt: Date.now(),
    readyAt: null,
    subscriptions: [],
  };
  orders.set(id, order);
  res.status(201).json(publicOrder(order));
});

app.get('/api/orders', (req, res) => {
  const list = Array.from(orders.values())
    .filter(o => o.status !== 'done')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(publicOrder);
  res.json(list);
});

app.get('/api/orders/by-number/:number', (req, res) => {
  const num = parseInt(req.params.number, 10);
  if (Number.isNaN(num)) return res.status(400).json({ error: 'numar invalid' });

  const matches = Array.from(orders.values()).filter(o => o.number === num);
  if (matches.length === 0) return res.status(404).json({ error: 'negasita' });

  matches.sort((a, b) => b.createdAt - a.createdAt);
  const chosen = matches.find(o => o.status !== 'done') || matches[0];
  res.json(publicOrder(chosen));
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'negasita' });
  res.json(publicOrder(order));
});

app.post('/api/orders/:id/ready', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'negasita' });
  order.status = 'ready';
  order.readyAt = Date.now();
  res.json(publicOrder(order));
  // trimitem notificarea dupa ce am raspuns, ca bucataria sa nu astepte
  notifyOrderReady(order).catch(err => console.error('notifyOrderReady a esuat:', err));
});

app.post('/api/orders/:id/done', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'negasita' });
  order.status = 'done';
  order.doneAt = Date.now();
  res.json(publicOrder(order));
});

app.post('/api/orders/:id/subscribe', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'negasita' });
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'abonare invalida' });
  }
  const already = order.subscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!already) order.subscriptions.push(subscription);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('OrderPing server ruleaza pe portul ' + PORT);
});
