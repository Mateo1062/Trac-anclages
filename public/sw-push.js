// Gestion des notifications push (rappels de factures) — importé dans le service
// worker généré par vite-plugin-pwa via workbox.importScripts (voir vite.config.js).
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) { data = { title: "Traç'Anclage", body: event.data ? event.data.text() : '' } }
  event.waitUntil(
    self.registration.showNotification(data.title || "Traç'Anclage", {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
