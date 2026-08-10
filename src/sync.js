// مزامنة مشفَّرة طرفًا لطرف.
//
// المبدأ: مفتاحٌ واحد لا يغادر جهازك. يُشتقّ منه بـPBKDF2 شيئان منفصلان:
//   ١) مفتاح تشفير AES-GCM — به تُشفَّر بياناتك قبل أن تغادر المتصفح.
//   ٢) معرّف التخزين — تجزئةٌ باتجاه واحد، فالخادم يعرف «أين» ولا يعرف «ماذا».
// من لا يملك المفتاح لا يستطيع فكّ شيء ولو حصل على الكتلة كاملة.

import { SUMMARY_V } from './widget-schema.js';

const ENDPOINT = '/api/sync';
const SALT = 'mybudget/sync/v1';
const ITERATIONS = 210000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا I O 0 1
export const SECRET_LENGTH = 32;

/** مفتاح عشوائي مقروء: ٣٢ محرفًا من أبجدية بلا محارف متشابهة. */
export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return format(chars.join(''));
}

/** يعيد الرمز إلى صورته المقروءة: XXXX-XXXX-… */
export function format(secret) {
  const clean = pick(secret);
  return clean.length === SECRET_LENGTH ? clean.replace(/(.{4})(?=.)/g, '$1-') : String(secret || '');
}

const pick = (s) => [...String(s || '').toUpperCase()].filter((c) => ALPHABET.includes(c)).join('');

/** هل يشبه ما أُدخل رمزًا كاملًا؟ */
export function looksLikeSecret(secret) { return pick(secret).length === SECRET_LENGTH; }

/**
 * تنقية الرمز قبل اشتقاق المفتاح.
 *
 * الفخّ الذي عطّل جوال المستخدم: الرمز يُلصق أحيانًا ومعه نصٌّ من الصفحة
 * («…‎-XXXX دخول أنشئ رمزًا جديدًا تابع على هذا الجهاز فقط…»)، وكان
 * التطبيق يشتقّ المفتاح من النصّ كاملًا فيخرج مفتاحٌ غير مفتاح الجهاز
 * الآخر — فيجد الجوال خزانةً فارغة ويظن المستخدم أن المزامنة معطوبة.
 * وأبجدية الرمز لاتينية، والنصّ الملتصق عربي، فالانتقاء يستخرج الرمز نقيًّا.
 * وإن لم تُخرج التنقية ٣٢ محرفًا بالضبط تُركت الصيغة القديمة كما هي، لئلا
 * يتغيّر مفتاح من كان رمزه بصيغةٍ أخرى.
 */
export function canonical(secret) {
  const raw = String(secret || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const picked = pick(secret);
  return picked.length === SECRET_LENGTH ? picked : raw;
}
const normalize = canonical;

/** بصمةٌ قصيرة من معرّف التخزين: تُقارَن بالعين بين جهازين ليُعلم أهما على رمزٍ واحد. */
export async function fingerprint(secret) {
  if (!secret) return '';
  const { id } = await derive(secret);
  return id.slice(0, 6);
}

async function derive(secret) {
  const material = await crypto.subtle.importKey('raw', enc.encode(normalize(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    material, 512,
  ));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const idDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32, 64)));
  return { key, id: hex(idDigest).slice(0, 48) };
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * ترميز البايتات نصًّا قبل btoa — على دفعات، لا بنشرها وسائطَ دفعةً واحدة.
 *
 * الفخّ الذي كلّف هذا المشروع مزامنته كلها: `String.fromCharCode(...bytes)`
 * يمرّر كل بايت وسيطًا مستقلًّا، ولعدد الوسائط سقفٌ في المكدّس (~١٢٤ ألف في
 * V8، وأقلّ في سفاري). نسخة المستخدم الحقيقية ١٬٠٧٨٬٤٨٨ بايت، فكان الرفع
 * يرمي RangeError في كل مرة — والخادم يبقى فارغًا، والجهاز الثاني لا يجد شيئًا.
 * لم تكشفه الاختبارات لأنها كلها بنسخٍ من عشرات البايتات.
 * ٣٢ ألفًا للدفعة: دون سقف الوسائط في كل المتصفحات بهامشٍ واسع.
 */
const b64 = (bytes) => {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
};

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSnapshot(secret, snapshot) {
  const { key, id } = await derive(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(snapshot));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { id, blob: `v1.${b64(iv)}.${b64(cipher)}` };
}

export async function decryptSnapshot(secret, blob) {
  const [version, ivB64, dataB64] = String(blob).split('.');
  if (version !== 'v1' || !ivB64 || !dataB64) throw new Error('صيغة الكتلة غير معروفة');
  const { key } = await derive(secret);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(dataB64));
  } catch {
    throw new Error('تعذّر فكّ التشفير — تأكّد من مفتاح المزامنة');
  }
  return JSON.parse(dec.decode(plain));
}

async function call(method, id, body) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}?id=${id}`, {
      method,
      body,
      headers: body ? { 'content-type': 'text/plain' } : undefined,
    });
  } catch {
    throw new Error('تعذّر الوصول إلى خدمة المزامنة — تحقّق من الاتصال');
  }
  // خادم ثابت (كخادم التطوير المحلي) لا يعرف الدالة، فيردّ 404 أو 405 أو 501
  if ([404, 405, 501].includes(res.status)) {
    throw new Error('خدمة المزامنة غير متاحة على هذا النطاق — تعمل بعد النشر على نتلفاي');
  }
  const out = await res.json().catch(() => null);
  // ردٌّ بلا JSON يأتي غالبًا من طبقة الاستضافة لا من الدالة (رفضُ حجمٍ مثلًا)،
  // فنُظهر رمز الحالة ليكون الخطأ قابلًا للتشخيص بدل «غير مفهوم» المبهمة
  if (!out) throw new Error(`ردٌّ غير مفهوم من خدمة المزامنة (${res.status})`);
  if (!res.ok) throw new Error(out.error || `فشل الطلب (${res.status})`);
  return out;
}

/** يرفع نسخة مشفّرة. @returns {{updatedAt:string, size:number}} */
export async function push(secret, snapshot) {
  const { id, blob } = await encryptSnapshot(secret, snapshot);
  const out = await call('PUT', id, blob);
  return { ...out, size: blob.length };
}

/** يسحب النسخة المخزَّنة ويفكّها. @returns {{found:boolean, snapshot?:object, updatedAt?:string}} */
export async function pull(secret) {
  const { id } = await derive(secret);
  const out = await call('GET', id);
  if (!out.found) return { found: false };
  return { found: true, snapshot: await decryptSnapshot(secret, out.data), updatedAt: out.updatedAt };
}

export async function remove(secret) {
  const { id } = await derive(secret);
  return call('DELETE', id);
}

/**
 * دمج نسختين: العمليات اتحادٌ ببصمتها، وما وسمه المستخدم بيده لا يُدهس،
 * وما حُذف على أحد الجهازين لا يعود من الآخر.
 * أما الإعدادات فتُؤخذ من النسخة الأحدث تغييرًا — لا تصديرًا.
 */
export function mergeSnapshots(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  // سجلّ الحذف يتّحد من الطرفين: شاهدٌ من أيّ جهازٍ يكفي
  const deleted = { ...(remote.deleted || {}), ...(local.deleted || {}) };

  const byHash = new Map();
  for (const t of remote.transactions || []) byHash.set(t.hash, t);
  for (const t of local.transactions || []) {
    const other = byHash.get(t.hash);
    if (!other) { byHash.set(t.hash, t); continue; }
    // الوسم اليدوي أعلى سلطة من أي تصنيف آلي، من أي جهاز جاء
    const localWins = t.categorySource === 'user' && other.categorySource !== 'user';
    byHash.set(t.hash, localWins ? t : other);
  }
  for (const h of Object.keys(deleted)) byHash.delete(h);

  // الختم الصحيح هو لحظة تغيير الإعدادات، لا لحظة تصدير النسخة: الثانية
  // تُختم في كل تصدير فتجعل المحلّي أحدثَ أبدًا، فلا يصل شيءٌ من الجهاز الآخر.
  //
  // ويُقاس بابًا بابًا لا بابًا واحدًا: الختم الواحد كان يمنح إعدادات صاحبه
  // السيادةَ كلَّها، فمن غيّر بابًا على جهازٍ ورث سيادةَ ما لم يُغيّره — فتعود
  // قيمةٌ قديمة من بابٍ آخر فتنقض ما ضُبط على الجهاز الثاني.
  // ومن لم يبعث خرائط أختام فجهازُه على نسخةٍ أقدم: يُحمل ختمُه الواحد على
  // أبوابه كلها كما كان، فلا ينكسر ولا يُظلم.
  const stampsOf = (x) => {
    const m = x?.settingsStamps;
    if (m && typeof m === 'object' && !Array.isArray(m)) return m;
    const one = String(x?.settingsAt || x?.exportedAt || '');
    return one ? { '*': one } : {};
  };
  const ls = stampsOf(local), rs = stampsOf(remote);
  const at = (m, sec) => String(m[sec] ?? m['*'] ?? '');

  const settings = {};
  for (const sec of new Set([...Object.keys(local.settings || {}), ...Object.keys(remote.settings || {})])) {
    const inL = !!local.settings && sec in local.settings;
    const inR = !!remote.settings && sec in remote.settings;
    // بابٌ عند طرفٍ دون الآخر يُؤخذ كما هو: غيابُه ليس حذفًا بل قِدَم نسخة
    if (!inL) { settings[sec] = remote.settings[sec]; continue; }
    if (!inR) { settings[sec] = local.settings[sec]; continue; }
    settings[sec] = at(ls, sec) >= at(rs, sec) ? local.settings[sec] : remote.settings[sec];
  }

  const stamps = {};
  for (const k of new Set([...Object.keys(ls), ...Object.keys(rs)])) {
    stamps[k] = at(ls, k) >= at(rs, k) ? at(ls, k) : at(rs, k);
  }
  const newest = Object.values(stamps).sort().pop() || null;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settingsAt: newest,
    settingsStamps: stamps,
    transactions: [...byHash.values()].sort((a, b) => a.date.localeCompare(b.date)),
    settings,
    rules: mergeRules(local.rules, remote.rules),
    accounts: { ...(remote.accounts || {}), ...(local.accounts || {}) },
    deleted,
  };
}

/**
 * يقرّر ما يلزم فعله ليتطابق الجهاز والخادم.
 * الحالة التي تُنسى عادةً: جهازٌ ممتلئ وخادمٌ فارغ — إن لم يُرفع منه شيء
 * بقي الجهاز الثاني لا يجد بيانات مهما أدخل الرمز.
 * @returns {{merged, push:boolean, added:number}}
 */
export function planSync(local, remote) {
  const localCount = local?.transactions?.length || 0;
  if (!remote) return { merged: local, push: localCount > 0, added: 0 };
  const merged = mergeSnapshots(local, remote);
  const remoteCount = remote.transactions?.length || 0;
  // العدد وحده لا يكفي دليلًا على التطابق: قد يحذف الجهاز عمليةً ويضيف أخرى
  // فيتساوى العددان بينما شاهد الحذف لم يبلغ الخادم بعد فتعود المحذوفة.
  const newTombstones = Object.keys(merged.deleted || {}).length !== Object.keys(remote.deleted || {}).length;
  return {
    merged,
    push: merged.transactions.length !== remoteCount || newTombstones,
    added: merged.transactions.length - localCount,
  };
}

function mergeRules(a = [], b = []) {
  const seen = new Map();
  for (const r of [...b, ...a]) {
    const key = `${r.field}|${r.op}|${r.value}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

// ── ملخّص أداة الشاشة ─────────────────────────────────────────────────────
/**
 * الطريق الوحيد الذي يخرج منه رقمٌ بلا تشفير، وباختيارٍ صريح من صاحب النسخة.
 *
 * أداة شاشة الآيفون لا تستطيع فكّ التشفير: لا `crypto.subtle` في بيئتها،
 * واشتقاق المفتاح ٢١٠ ألف دورة لا تحتمله أداةٌ لها ثوانٍ معدودة. فإمّا ملخّصٌ
 * مقروء، وإمّا لا أداة.
 *
 * ورمزه مستقلٌّ عن مفتاح المزامنة عمدًا — عشوائيٌّ لا مشتقّ — فإبطالُه لا
 * يمسّ مزامنتك، ولا يُستدلّ منه على مفتاحك.
 */
const WIDGET_ENDPOINT = '/api/widget';

export function newWidgetToken() {
  return hex(crypto.getRandomValues(new Uint8Array(24)));   // ٤٨ محرفًا
}

export function widgetUrl(token) {
  return `${location.origin}${WIDGET_ENDPOINT}?t=${token}`;
}

export async function publishWidget(token, summary) {
  const res = await fetch(widgetUrl(token), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(summary),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error || `فشل النشر (${res.status})`);
  return out;
}

export async function revokeWidget(token) {
  const res = await fetch(widgetUrl(token), { method: 'DELETE' });
  if (!res.ok) throw new Error(`فشل الإلغاء (${res.status})`);
  return true;
}

/** يبني الملخّص من صورة الشهر — مجمَّعٌ فقط، بلا قائمة عمليات ولا أرصدة. */
export function widgetSummary(m, at = new Date().toISOString()) {
  if (!m) return null;
  const r2 = (x) => Math.round((x || 0) * 100) / 100;
  return {
    v: SUMMARY_V,
    month: m.key,
    day: m.day,
    daysInMonth: m.daysInMonth,
    spent: r2(m.spent),
    limit: r2(m.limit),
    remaining: r2(m.remaining),
    saved: r2(m.saved),
    income: r2(m.income),
    pace: r2(m.pace),
    projected: r2(m.projected),
    todaySpent: r2(m.todaySpent),
    dayLimit: r2(m.today?.limit),
    weekSpent: r2(m.week?.spent),
    weekLimit: r2(m.week?.limit),
    todayCount: m.todayCount || 0,
    monthCount: m.monthCount || 0,
    top: (m.top || []).slice(0, 3).map((c) => ({ n: String(c.ar).slice(0, 40), a: r2(c.amount) })),
    last: m.last ? { n: String(m.last.name).trim().slice(0, 28), a: r2(m.last.amount), d: m.last.date } : null,
    at,
  };
}
