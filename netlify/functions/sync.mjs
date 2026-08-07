// نقطة المزامنة: تخزّن كتلةً مشفَّرة لا تفهمها، وتُعيدها كما هي.
//
// الخادم لا يرى مفتاحك ولا كلمة سرّك ولا رقمًا واحدًا من كشوفك: التشفير وفكّه
// يجريان في متصفحك، وما يصل إلى هنا نصٌّ مشفَّر (AES-GCM) ومعرّفٌ مشتقٌّ من
// المفتاح بدالة اتجاه واحد — فلا يمكن استنتاج المفتاح منه.

import { getStore } from '@netlify/blobs';

const ID_RE = /^[a-f0-9]{32,64}$/;
const MAX_BYTES = 8 * 1024 * 1024; // سقف يمنع إساءة الاستعمال

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!ID_RE.test(id)) return json({ error: 'معرّف غير صالح' }, 400);

  const store = getStore('mybudget-sync');

  try {
    if (req.method === 'GET') {
      const hit = await store.getWithMetadata(id, { type: 'text' });
      if (!hit) return json({ found: false });
      return json({ found: true, data: hit.data, updatedAt: hit.metadata?.updatedAt || null });
    }

    if (req.method === 'PUT') {
      const body = await req.text();
      if (!body) return json({ error: 'لا يوجد محتوى' }, 400);
      if (body.length > MAX_BYTES) return json({ error: 'الحجم يتجاوز الحد' }, 413);
      const updatedAt = new Date().toISOString();
      await store.set(id, body, { metadata: { updatedAt } });
      return json({ ok: true, updatedAt });
    }

    if (req.method === 'DELETE') {
      await store.delete(id);
      return json({ ok: true });
    }
  } catch (err) {
    return json({ error: `تعذّرت المزامنة: ${err.message}` }, 500);
  }

  return json({ error: 'طريقة غير مدعومة' }, 405);
};

export const config = { path: '/api/sync' };
