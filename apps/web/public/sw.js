// MASCLI service worker (docs/adr/0014): shows device notifications and opens the record.
// It deliberately has no fetch handler: project data is never cached on the device.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'MASCLI', body: event.data ? event.data.text() : '' };
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(
    self.registration.showNotification(String(data.title || 'MASCLI'), {
      body: String(data.body || ''),
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: url,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      if (open) return open.navigate(target.href).then((w) => (w ?? open).focus());
      return self.clients.openWindow(target.href);
    }),
  );
});
