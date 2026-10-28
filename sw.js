// Service worker: cache shell untuk offline + terima file dari menu "Bagikan" (Web Share Target).
const VERSION = 'ygg-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'parser.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'ygg-share').map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open('ygg-share');
      const base = new URL('./share-inbox/', self.registration.scope).href;
      let i = 0;
      for (const file of form.getAll('file')) {
        if (!(file instanceof File)) continue;
        await cache.put(base + 'file-' + i++, new Response(file, { headers: { 'content-type': file.type, 'x-filename': file.name } }));
      }
      const text = form.get('text');
      if (text) await cache.put(base + 'text', new Response(String(text)));
      return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Network-first untuk shell supaya update cepat terlihat; cache sebagai cadangan offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
  );
});
