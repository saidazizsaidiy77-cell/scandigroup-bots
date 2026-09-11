/* ZELTA ERP — "telefonga o'rnatiladigan" rejim uchun xizmat ishchisi.
 *
 * Vazifasi ikkitasi, ko'p emas:
 *   1. Brauzer ilovani o'rnatishga ruxsat berishi uchun ro'yxatdan o'tish.
 *   2. Internet uzilganda brauzerning "sahifa ochilmadi" ekrani emas,
 *      o'zimizning tushunarli yozuvimiz chiqishi.
 *
 * Bu OFFLINE REJIM EMAS. Har bir amal (o'tkazish, saqlash) serverga
 * so'rov — internetsiz ular baribir ishlamaydi. Shuning uchun /api/ ga
 * hech qachon aralashmaymiz: keshdan eski javob berish — noto'g'ri
 * ma'lumot ko'rsatish demak, bu uzilishdan battar.
 *
 * Strategiya: avval tarmoq, keyin kesh. Ya'ni internet bor bo'lsa xodim
 * DOIMO eng yangi kodni oladi — deploy qilingandan keyin hech kim
 * brauzerini tozalab o'tirmaydi.
 */
const CACHE = 'zelta-v1';
const SHELL = ['/', '/style.css', '/app.js', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})          // bitta fayl yetib kelmasa ham o'rnatish buzilmasin
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const OFFLINE = `<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Internet yo'q</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#f5f6f8;color:#1a1c1f;
padding:48px 24px;text-align:center}h1{font-size:18px;margin-bottom:8px}
p{color:#6e757d}button{margin-top:24px;padding:12px 22px;border:0;border-radius:12px;
background:#1a1c1f;color:#fff;font:inherit}</style></head><body>
<h1>Internet yo'q</h1><p>ZELTA ERP ma'lumotni serverdan oladi.<br>
Ulanishni tekshiring va qayta urining.</p>
<button onclick="location.reload()">Qayta urinish</button></body></html>`;

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // ma'lumot hech qachon keshdan emas

  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate')
          return new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        return Response.error();
      }),
  );
});
