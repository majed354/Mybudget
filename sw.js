// عامل الخدمة: يجعل التطبيق يفتح دون إنترنت، ويعرض التنبيهات.

const CACHE = 'mybudget-v37';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './assets/app.css',
  './src/main.js', './src/util.js', './src/store.js', './src/import.js',
  './src/classify.js', './src/analytics.js', './src/affordability.js',
  './src/charts.js', './src/views.js', './src/sync.js',
  './src/inbox.js', './src/sms-formats.js', './src/reminders.js',
  './vendor/xlsx.full.min.js', './vendor/pdf.mjs', './vendor/pdf.worker.mjs',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // المزامنة لا تُخزَّن أبدًا — بيانات حيّة
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // الشبكة أولًا للمستند كي يصل التحديث، والذاكرة احتياطًا عند انقطاعها
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  // المكتبات المرفقة والأيقونات لا تتغيّر: تُقدَّم من المخزن فورًا.
  // أما شيفرة التطبيق فمن الشبكة أولًا، والمخزن احتياطٌ عند انقطاعها —
  // إذ لا يُحتمل في أداة مالية أن يعمل المستخدم على منطقٍ قديم بعد التحديث.
  const immutable = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/assets/icons/');

  if (immutable) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetchAndCache(e.request)));
    return;
  }
  e.respondWith(fetchAndCache(e.request).catch(() => caches.match(e.request)));
});

function fetchAndCache(request) {
  return fetch(request).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
    }
    return res;
  });
}

// تنبيه يطلبه التطبيق (تذكير بموعد قسط أو راتب أو استيراد كشف)
self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type !== 'notify') return;
  self.registration.showNotification(m.title || 'ميزانيتي', {
    body: m.body || '',
    icon: './assets/icons/icon-192.png',
    badge: './assets/icons/icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    tag: m.tag || 'mybudget',
    data: { url: m.url || './index.html' },
  });
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || './index.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow(target);
  }));
});
