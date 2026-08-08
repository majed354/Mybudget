// صندوق وارد مؤقّت لرسائل البنك.
//
// الهاتف يودع نصّ الرسالة هنا، والتطبيق يسحبه عند أول فتح فيُمسح من فوره.
// وما لم يُسحب يُمسح تلقائيًا بعد مهلة قصيرة — فالصندوق ممرّ لا مستودع.
//
// الرمز (box) يُشتقّ في المتصفح من مفتاح المزامنة بدالة اتجاه واحد، فلا يكشف
// المفتاح، ولا يمكن لمن لا يعرفه أن يكتب في صندوقك أو يقرأه.

import { getStore } from '@netlify/blobs';
import { SENSITIVE_RE, foldArabic } from '../../src/sms-formats.js';

const BOX_RE = /^[a-f0-9]{32,64}$/;
const MAX_MESSAGE = 4000;      // رسالة بنكية لا تتجاوز هذا بحال
const MAX_QUEUE = 500;         // سقف يمنع تضخّم الصندوق
const TTL_HOURS = 72;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fresh = (items) => {
  const cutoff = Date.now() - TTL_HOURS * 3600 * 1000;
  return items.filter((m) => Date.parse(m.receivedAt) >= cutoff);
};

export default async (req) => {
  const url = new URL(req.url);
  const box = url.searchParams.get('box') || '';
  if (!BOX_RE.test(box)) return json({ error: 'رمز صندوق غير صالح' }, 400);

  // الاتساق القوي ضروري هنا: الجوال يودع ثم يسحب التطبيق بعد ثوانٍ، ومع
  // الاتساق المؤجَّل الافتراضي قد تعود القراءة فارغة فتضيع العملية.
  const store = getStore({ name: 'mybudget-inbox', consistency: 'strong' });

  try {
    // ── إيداع رسالة (من الهاتف) ──────────────────────────────────────────
    if (req.method === 'POST') {
      const raw = (await req.text()).trim();
      if (!raw) return json({ error: 'رسالة فارغة' }, 400);
      if (raw.length > MAX_MESSAGE) return json({ error: 'الرسالة أطول من الحد' }, 413);

      let text = raw, sender = '', sentAt = '';
      // يقبل نصًّا صريحًا أو JSON فيه {text, sender, sentAt}
      if (raw.startsWith('{')) {
        try {
          const j = JSON.parse(raw);
          text = String(j.text || j.message || '').trim();
          sender = String(j.sender || j.from || '').slice(0, 40);
          sentAt = String(j.sentAt || '').slice(0, 40);
        } catch { /* يبقى النصّ كما ورد */ }
      }
      if (!text) return json({ error: 'لا يوجد نصّ' }, 400);

      // رمز التحقّق لا يُخزَّن أصلًا — لا يُحفظ ليُراجَع ولا لِيُمحى بمهلته.
      // فالأتمتة تمرّر كل ما يصل من المصرف، ومنه رمزٌ يفتح الحساب متى سجّل
      // صاحبه الدخول. وردُّه في المتصفح لا يكفي: يكون قد بلغ الخادم وأقام.
      // ويُردّ بنجاحٍ لا بخطأ، لئلّا تُظهر أتمتة الجوال إنذارًا في كل مرة.
      if (SENSITIVE_RE.test(foldArabic(text))) return json({ ok: true, stored: false, reason: 'رسالة رمز تحقّق' });

      const items = fresh((await store.get(box, { type: 'json' })) || []);
      items.push({ id: crypto.randomUUID(), text, sender, sentAt, receivedAt: new Date().toISOString() });
      await store.setJSON(box, items.slice(-MAX_QUEUE));
      return json({ ok: true, queued: items.length });
    }

    // ── سحب ما تجمّع (من التطبيق) ────────────────────────────────────────
    if (req.method === 'GET') {
      const items = fresh((await store.get(box, { type: 'json' })) || []);
      return json({ messages: items });
    }

    // ── مسح ما سُحب ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (!ids.length) { await store.delete(box); return json({ ok: true, cleared: 'all' }); }
      const items = fresh((await store.get(box, { type: 'json' })) || []);
      const keep = items.filter((m) => !ids.includes(m.id));
      if (keep.length) await store.setJSON(box, keep); else await store.delete(box);
      return json({ ok: true, remaining: keep.length });
    }
  } catch (err) {
    return json({ error: `تعذّر الوصول إلى الصندوق: ${err.message}` }, 500);
  }

  return json({ error: 'طريقة غير مدعومة' }, 405);
};

export const config = { path: '/api/ingest' };
