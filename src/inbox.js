// طبقة الرسائل: من إشعار البنك إلى عملية «معلَّقة» تظهر في اللوحة فورًا،
// ثم تُطابَق بنظيرتها حين يُستورد الكشف فتصير «مؤكَّدة».

import { normalizeDigits, parseNumber, toISODate, uid, hashTx } from './util.js';
import {
  detectBank, foldArabic, KIND_RULES, AMOUNT_FIELDS, FEE_RE, BALANCE_RE,
  FOREIGN_RE, PARTY_FIELDS, CARD_FIELDS, REF_RE, COUNTRY_RE, DATE_PATTERNS, SELF_PARTY_RE,
  PROMO_SENDER_RE, PROMO_TEXT_RE,
} from './sms-formats.js';

const ENDPOINT = '/api/ingest';
const SALT = 'mybudget/inbox/v1';

const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * رمز الصندوق يُشتقّ من مفتاح المزامنة بملحٍ مختلف عن ملح المزامنة،
 * فمن عرف رمز الصندوق لا يستطيع الوصول إلى نسختك المشفَّرة ولا العكس.
 */
export async function boxIdFor(secret) {
  const key = String(secret || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const material = await crypto.subtle.importKey('raw', enc.encode(key), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: 120000, hash: 'SHA-256' }, material, 256,
  );
  return hex(new Uint8Array(bits)).slice(0, 48);
}

// ── تحليل رسالة البنك ─────────────────────────────────────────────────────
// راجع src/sms-formats.js: هناك تُوصَف أشكال البلاد والراجحي وstc bank.

// الترتيب مقصود: الأخصّ قبل الأعمّ. «إيداع راتب» راتبٌ لا إيداعًا نقديًّا،
// و«استرداد مشتريات» ردٌّ لا شراءً، و«سداد قسط» قسطٌ لا فاتورة.
/**
 * @returns {{ok:boolean, reason?:string, bank, kind, amount, fee, merchant, self,
 *            date, time, balance, card, ref, foreign}}
 */
export function parseBankSMS(text, { today = new Date().toISOString().slice(0, 10), sender = '' } = {}) {
  const raw = normalizeDigits(String(text || ''));
  if (!raw.trim()) return { ok: false, reason: 'رسالة فارغة' };
  // الإعلان يُردّ من عنوانه: المصرف يرسل عروضه من مرسِلٍ منتهٍ بـ`-AD`
  if (PROMO_SENDER_RE.test(String(sender || ''))) return { ok: false, reason: 'رسالة إعلانية لا عملية' };

  // نطابق على نصٍّ مُوحَّد الرسم، ونقتطع الأسماء من الأصل بالمواضع نفسها
  const F = foldArabic(raw);
  const bank = detectBank(F, sender);

  let kind = null;
  for (const [re, k] of KIND_RULES) if (re.test(F)) { kind = k; break; }

  // ── المبلغ ──
  let amount = null, tag = null;
  for (const f of AMOUNT_FIELDS) {
    const m = F.match(f.re);
    const v = parseNumber(m?.[1]);
    if (v != null && v > 0) { amount = v; tag = f.tag; break; }
  }
  if (amount == null) return { ok: false, reason: 'لم يُعثر على مبلغ', bank: bank?.id, kind };
  // رقمٌ عائم في نصٍّ تسويقي ليس مبلغَ عملية. الإشعار الصحيح يسمّي حقله
  // («مبلغ»، «إجمالي المبلغ المستحق»، «ب:»)؛ فإن لم يُسمَّ وكانت اللغة لغة
  // عرضٍ فهو رقم إغراءٍ لا خصم — ولا يُقيَّد على حساب المستخدم.
  if (tag === 'loose' && PROMO_TEXT_RE.test(F)) {
    return { ok: false, reason: 'رسالة إعلانية لا عملية', bank: bank?.id, kind };
  }

  const foreign = F.match(FOREIGN_RE)?.[1] || null;
  // شراء بعملة أجنبية: الرقم الظاهر بالدولار، والمخصوم هو الإجمالي بالريال
  if (foreign && tag !== 'total') {
    return { ok: false, reason: `مبلغ بعملة ${foreign} بلا إجمالي بالريال`, bank: bank?.id, kind };
  }

  const fee = parseNumber(F.match(FEE_RE)?.[1]) || 0;
  // الرسوم تُخصم مع المبلغ، إلا أن يكون الرقم إجماليًا فهي داخلة فيه أصلًا
  const charged = tag === 'total' ? amount : amount + fee;

  // ── الطرف الآخر ──
  let merchant = '', self = false;
  for (const re of PARTY_FIELDS) {
    const m = F.match(re);
    if (!m || !m[1]) continue;
    const at = m.index + m[0].indexOf(m[1]);
    const value = raw.slice(at, at + m[1].length).trim().replace(/[.،,;]+$/, '');
    if (!value || /^\d+$/.test(value)) continue;   // «من:0007» رقم حساب لا اسمًا
    self = SELF_PARTY_RE.test(foldArabic(value));
    merchant = value;
    break;
  }

  // ── التاريخ ──
  let date = null, time = '';
  for (const d of DATE_PATTERNS) {
    const m = F.match(d.re);
    if (!m) continue;
    date = d.order === 'ymd'
      ? toISODate(`${m[1]}-${m[2]}-${m[3]}`)
      : toISODate(`${m[1]}/${m[2]}/${m[3]}`);
    time = m[4] || '';
    if (date) break;
  }

  if (!kind) return { ok: false, reason: 'نوع العملية غير معروف', bank: bank?.id, amount: charged };

  return {
    ok: true,
    bank: bank?.id || null,
    bankAr: bank?.ar || '',
    kind,
    amount: Math.round(charged * 100) / 100,
    fee,
    foreign,
    merchant,
    self,
    date: date || today,
    time,
    balance: parseNumber(F.match(BALANCE_RE)?.[1]),
    card: firstMatch(F, CARD_FIELDS),
    ref: raw.match(REF_RE)?.[1] || null,
    country: F.match(COUNTRY_RE)?.[1] || '',
  };
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return '';
}

const CREDIT_KINDS = new Set(['cash_in', 'salary', 'transfer_in', 'refund']);
// تسديد بطاقتك من حسابك نقلُ مالٍ لا إنفاقٌ جديد — الإنفاق سُجّل يوم الشراء
const INTERNAL_KINDS = new Set(['card_payment']);
/**
 * الحوالة إلى حسابك تُستبعد… إلا أن تكون أمرًا مستديمًا.
 * فالمبلغ الذي يخرج كل شهر في موعده إلى حسابٍ مخصَّص (إيجار، مدرسة، ادخار
 * ملزِم) مالٌ مرصود لا فائضٌ متاح؛ ولو استُبعد لأوهم المحرّك أن لديك سعةً
 * ليست لك. فيبقى محسوبًا حتى تصنّفه بنفسك.
 */
const EARMARKED_KINDS = new Set(['standing_order']);

/** يحوّل رسالة محلَّلة إلى عملية معلَّقة تُعرض في اللوحة. */
export function smsToTransaction(parsed, msg, accountLabel = 'من الرسائل') {
  const signed = CREDIT_KINDS.has(parsed.kind) ? parsed.amount : -parsed.amount;
  const isInternal = INTERNAL_KINDS.has(parsed.kind)
    || (parsed.self && !EARMARKED_KINDS.has(parsed.kind));
  const t = {
    id: uid(),
    seq: 0,
    account: parsed.card ? `${accountLabel} ••${parsed.card}` : accountLabel,
    source: 'sms',
    status: 'pending',
    date: parsed.date,
    time: parsed.time || null,
    bankType: null,
    desc: (msg?.text || '').slice(0, 300),
    details: msg?.text || '',
    merchantHint: parsed.merchant || '',
    smsKind: parsed.kind,
    bank: parsed.bankAr || parsed.bank || '',
    ref: parsed.ref || null,
    excluded: isInternal,
    excludeReason: isInternal ? 'internal' : null,
    amount: Math.round(signed * 100) / 100,
    balance: parsed.balance ?? null,
    category: null,
    categorySource: null,
    linkId: null,
    note: '',
    smsId: msg?.id || null,
  };
  t.hash = hashTx({ ...t, ref: `sms:${msg?.id || t.id}` });
  return t;
}

// ── الصندوق ───────────────────────────────────────────────────────────────

async function call(method, box, body, extra = '') {
  let res;
  try {
    res = await fetch(`${ENDPOINT}?box=${box}${extra}`, {
      method, body, headers: body ? { 'content-type': 'text/plain' } : undefined,
    });
  } catch {
    throw new Error('تعذّر الوصول إلى صندوق الرسائل');
  }
  if ([404, 405, 501].includes(res.status)) throw new Error('صندوق الرسائل غير متاح على هذا النطاق');
  const out = await res.json().catch(() => null);
  if (!out) throw new Error('ردٌّ غير مفهوم من صندوق الرسائل');
  if (!res.ok) throw new Error(out.error || `فشل الطلب (${res.status})`);
  return out;
}

/**
 * يسحب ما وصل، يحوّله عملياتٍ معلَّقة، ثم يمسحه من الخادم.
 * @returns {{added:Array, failed:Array}}
 */
export async function drain(secret, { accountLabel } = {}) {
  const box = await boxIdFor(secret);
  const { messages = [] } = await call('GET', box);
  if (!messages.length) return { added: [], failed: [] };

  const added = [], failed = [], done = [];
  for (const m of messages) {
    const parsed = parseBankSMS(m.text, { today: (m.receivedAt || '').slice(0, 10) || undefined, sender: m.sender });
    if (parsed.ok) added.push(smsToTransaction(parsed, m, accountLabel));
    else failed.push({ ...m, reason: parsed.reason });
    done.push(m.id);
  }
  // لا نمسح ما لم يُفهم: يبقى ليُراجَع، ويُمسح بمهلته
  const clear = added.map((t) => t.smsId).filter(Boolean);
  if (clear.length) await call('DELETE', box, null, `&ids=${clear.join(',')}`);
  return { added, failed };
}

export async function clearInbox(secret) {
  return call('DELETE', await boxIdFor(secret));
}

// ── المطابقة بين المعلَّق والمؤكَّد ────────────────────────────────────────

/** تشابه اسمين بعد التطبيع — لا يُشترط، لكنه يرجّح عند التساوي. */
export function nameSimilarity(a, b) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z؀-ۿ0-9]+/g, ' ').trim();
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

/**
 * يطابق العمليات المعلَّقة (من الرسائل) بنظيراتها المؤكَّدة (من الكشف).
 * المعيار: المبلغ متقارب، والتاريخ ضمن ثلاثة أيام، واتجاه المبلغ واحد.
 * @returns {{matched:Array<{pending, booked, score}>, unmatched:Array}}
 */
export function reconcile(pending, booked, { days = 3, tolerance = 0.005 } = {}) {
  const used = new Set();
  const matched = [], unmatched = [];

  for (const p of pending) {
    let best = null, bestScore = 0;
    for (const b of booked) {
      if (used.has(b.id) || b.source === 'sms') continue;
      if (Math.sign(b.amount) !== Math.sign(p.amount)) continue;
      const diff = Math.abs(Math.abs(b.amount) - Math.abs(p.amount));
      if (diff > Math.max(0.5, Math.abs(p.amount) * tolerance)) continue;
      const gap = Math.abs(Date.parse(b.date) - Date.parse(p.date)) / 86400000;
      if (gap > days) continue;

      // كلما قلّ الفارق في المبلغ واليوم، وزاد تشابه الاسم، ارتفعت الثقة
      const score = 1 - diff / Math.max(1, Math.abs(p.amount))
        + (1 - gap / (days + 1))
        + nameSimilarity(p.merchantHint, b.merchant || b.desc) * 1.5;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best) { used.add(best.id); matched.push({ pending: p, booked: best, score: bestScore }); }
    else unmatched.push(p);
  }
  return { matched, unmatched };
}

/**
 * يدمج نتيجة المطابقة: تُحذف المعلَّقة ويُنقل إليها ما تعلّمناه (وسم المستخدم).
 * @returns {{keep:Array, drop:Set<string>}}
 */
export function applyReconciliation(matched) {
  const drop = new Set();
  const updates = [];
  for (const { pending, booked } of matched) {
    drop.add(pending.id);
    // الوسم اليدوي الذي وضعتَه على العملية المعلَّقة ينتقل إلى المؤكَّدة
    if (pending.categorySource === 'user' && booked.categorySource !== 'user') {
      updates.push({ ...booked, category: pending.category, categorySource: 'user' });
    }
  }
  return { drop, updates };
}
