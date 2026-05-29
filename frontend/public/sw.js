/*
 * Reflect service worker — push receiver ONLY.
 *
 * Deliberately NOT a PWA cache: it never intercepts fetch, so it can't serve
 * stale app bundles or interfere with the SPA. Its sole job is to show
 * care-loop reminder notifications and route clicks back into the app.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || 'Reflect';
  const options = {
    body: data.body || '',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag: data.tag || undefined,
    // Reminders are low-urgency — don't vibrate aggressively.
    silent: false,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an existing tab (and navigate it) if one is open; else open new.
      for (const client of wins) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try {
              client.navigate(url);
            } catch (e) {
              /* cross-origin or unsupported — ignore */
            }
          }
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    }),
  );
});
