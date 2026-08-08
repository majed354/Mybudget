// خادم تطوير: يخدم الملفات الثابتة ويحاكي دالتَي نتلفاي في الذاكرة،
// فتُختبر دورة الدخول والمزامنة والرسائل كاملةً قبل النشر.
//
//   node tools/dev-server.mjs [port]

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8778;

const syncStore = new Map();   // id → {data, updatedAt}
const inboxStore = new Map();  // box → [messages]

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── محاكاة /api/sync ────────────────────────────────────────────────────
  if (url.pathname === '/api/sync') {
    const id = url.searchParams.get('id') || '';
    if (!/^[a-f0-9]{32,64}$/.test(id)) return json(res, { error: 'معرّف غير صالح' }, 400);
    if (req.method === 'GET') {
      const hit = syncStore.get(id);
      return json(res, hit ? { found: true, ...hit } : { found: false });
    }
    if (req.method === 'PUT') {
      const data = await readBody(req);
      const updatedAt = new Date().toISOString();
      syncStore.set(id, { data, updatedAt });
      return json(res, { ok: true, updatedAt });
    }
    if (req.method === 'DELETE') { syncStore.delete(id); return json(res, { ok: true }); }
    return json(res, { error: 'طريقة غير مدعومة' }, 405);
  }

  // ── محاكاة /api/ingest ──────────────────────────────────────────────────
  if (url.pathname === '/api/ingest') {
    const box = url.searchParams.get('box') || '';
    if (!/^[a-f0-9]{32,64}$/.test(box)) return json(res, { error: 'رمز صندوق غير صالح' }, 400);
    const items = inboxStore.get(box) || [];
    if (req.method === 'POST') {
      const raw = (await readBody(req)).trim();
      if (!raw) return json(res, { error: 'رسالة فارغة' }, 400);
      let text = raw, sender = '';
      if (raw.startsWith('{')) {
        try { const j = JSON.parse(raw); text = j.text || j.message || ''; sender = j.sender || ''; } catch { /* نص خام */ }
      }
      items.push({ id: crypto.randomUUID(), text, sender, sentAt: '', receivedAt: new Date().toISOString() });
      inboxStore.set(box, items);
      return json(res, { ok: true, queued: items.length });
    }
    if (req.method === 'GET') return json(res, { messages: items });
    if (req.method === 'DELETE') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length) inboxStore.delete(box);
      else inboxStore.set(box, items.filter((m) => !ids.includes(m.id)));
      return json(res, { ok: true, remaining: (inboxStore.get(box) || []).length });
    }
    return json(res, { error: 'طريقة غير مدعومة' }, 405);
  }

  // ── الملفات الثابتة ─────────────────────────────────────────────────────
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('لم يوجد');
  }
});

server.listen(PORT, () => console.log(`خادم التطوير: http://localhost:${PORT}  (بدالتَي المزامنة والرسائل)`));
