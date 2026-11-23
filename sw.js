'use strict';
const BUILD = 'bbb8f6c0';

const SHELL = 'shell-' + BUILD;
const AUDIO = 'audio-v1';
const FILES = ['./', 'style.css', 'app.js', 'manifest.json', 'app.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => e.waitUntil((async () => {
  const cache = await caches.open(SHELL);
  await cache.addAll(FILES.map(url => new Request(url, { cache: 'reload' })));
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith('shell-') && name !== SHELL) await caches.delete(name);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.origin === location.origin) e.respondWith(answer(e.request, url));
});

async function answer(req, url) {
  if (url.pathname.endsWith('.m4a')) {
    const hit = await (await caches.open(AUDIO)).match(url.href);
    if (!hit) return fetch(req);
    return req.headers.has('range') ? slice(hit, req.headers.get('range')) : hit;
  }
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true });
  return hit || fetch(req);
}

// Safari asks for audio in byte ranges and plays nothing if it is handed the whole file back.
async function slice(resp, header) {
  const blob = await resp.blob(), size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  let start = 0, end = size - 1;
  if (m && m[1]) {
    start = +m[1];
    if (m[2]) end = Math.min(+m[2], end);
  } else if (m && m[2]) {
    start = Math.max(0, size - m[2]);
  }
  if (!m || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'audio/mp4',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
