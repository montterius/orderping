// Service Worker - codul asta ruleaza "in fundal", separat de pagina web,
// si de-aia poate primi notificarea chiar si cand telefonul e blocat sau
// browser-ul e inchis.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '🔔 OrderPing', body: event.data ? event.data.text() : 'Comanda ta e gata!' };
  }

  var title = data.title || '🔔 OrderPing';
  var options = {
    body: data.body || 'Comanda ta e gata!',
    vibrate: [250, 120, 250, 120, 500],
    tag: data.orderId ? ('order-' + data.orderId) : undefined,
    renotify: true,
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
