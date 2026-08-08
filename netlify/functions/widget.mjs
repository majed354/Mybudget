// ملخّص أداة الشاشة — الطريق الوحيد الذي يخرج منه رقمٌ بلا تشفير.
//
// أداةُ شاشة الآيفون لا تستطيع فكّ تشفيرك: لا `crypto.subtle` في بيئتها،
// واشتقاق مفتاحك ٢١٠ ألف دورة لا تحتمله أداةٌ لها ثوانٍ. فاختار صاحب النسخة
// أن يخرج ملخّصٌ مجمَّع خلف رمزٍ عشوائي لا يُخمَّن.
//
// وهذه الدالة تحرس ذلك القرار بنفسها: لا تقبل إلا الحقول المسمّاة أدناه.
// فلو أخطأ التطبيق يومًا وأرسل عمليةً أو اسم تاجر، رُدّ الطلب — الحارس هنا
// لا هناك، لأن ما يُنشر بلا تشفير يجب ألّا يتّسع بسهو.

import { getStore } from '@netlify/blobs';
import { validateSummary } from '../../src/widget-schema.js';

const TOKEN_RE = /^[a-f0-9]{32,64}$/;
const MAX_BYTES = 2048;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // أداة الشاشة تقرأ من خارج المتصفح، فالقراءة مفتوحة على الرمز وحده
      'access-control-allow-origin': '*',
    },
  });

export default async (req) => {
  const t = new URL(req.url).searchParams.get('t') || '';
  if (!TOKEN_RE.test(t)) return json({ error: 'رمز غير صالح' }, 400);

  const store = getStore({ name: 'mybudget-widget', consistency: 'strong' });

  try {
    if (req.method === 'GET') {
      const hit = await store.get(t, { type: 'json' });
      if (!hit) return json({ found: false });
      return json({ found: true, ...hit });
    }

    if (req.method === 'PUT') {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json({ error: 'الحجم يتجاوز الحد' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'جسم غير صالح' }, 400); }
      const bad = validateSummary(body);
      if (bad) return json({ error: bad }, 400);
      await store.setJSON(t, body);
      return json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await store.delete(t);
      return json({ ok: true });
    }
  } catch (err) {
    return json({ error: `تعذّر الوصول: ${err.message}` }, 500);
  }

  return json({ error: 'طريقة غير مدعومة' }, 405);
};

export const config = { path: '/api/widget' };
