// مزامنة مشفَّرة طرفًا لطرف.
//
// المبدأ: مفتاحٌ واحد لا يغادر جهازك. يُشتقّ منه بـPBKDF2 شيئان منفصلان:
//   ١) مفتاح تشفير AES-GCM — به تُشفَّر بياناتك قبل أن تغادر المتصفح.
//   ٢) معرّف التخزين — تجزئةٌ باتجاه واحد، فالخادم يعرف «أين» ولا يعرف «ماذا».
// من لا يملك المفتاح لا يستطيع فكّ شيء ولو حصل على الكتلة كاملة.

const ENDPOINT = '/api/sync';
const SALT = 'mybudget/sync/v1';
const ITERATIONS = 210000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** مفتاح عشوائي مقروء: ٣٢ محرفًا من أبجدية بلا محارف متشابهة. */
export function newSecret() {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا I O 0 1
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return chars.join('').replace(/(.{4})(?=.)/g, '$1-'); // XXXX-XXXX-…
}

function normalize(secret) {
  return String(secret || '').trim().toUpperCase().replace(/[\s-]/g, '');
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
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
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
  if (!out) throw new Error('ردٌّ غير مفهوم من خدمة المزامنة');
  if (!res.ok) throw new Error(out.error || `فشل الطلب (${res.status})`);
  return out;
}

/** يرفع نسخة مشفّرة. @returns {{updatedAt:string}} */
export async function push(secret, snapshot) {
  const { id, blob } = await encryptSnapshot(secret, snapshot);
  return call('PUT', id, blob);
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
 * دمج نسختين: العمليات اتحادٌ ببصمتها، وما وسمه المستخدم بيده لا يُدهس.
 * أما الإعدادات والقواعد فتُؤخذ من النسخة الأحدث تصديرًا.
 */
export function mergeSnapshots(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  const byHash = new Map();
  for (const t of remote.transactions || []) byHash.set(t.hash, t);
  for (const t of local.transactions || []) {
    const other = byHash.get(t.hash);
    if (!other) { byHash.set(t.hash, t); continue; }
    // الوسم اليدوي أعلى سلطة من أي تصنيف آلي، من أي جهاز جاء
    const localWins = t.categorySource === 'user' && other.categorySource !== 'user';
    byHash.set(t.hash, localWins ? t : other);
  }

  const localNewer = String(local.exportedAt || '') >= String(remote.exportedAt || '');
  const winner = localNewer ? local : remote;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    transactions: [...byHash.values()].sort((a, b) => a.date.localeCompare(b.date)),
    settings: winner.settings,
    rules: mergeRules(local.rules, remote.rules),
    accounts: { ...(remote.accounts || {}), ...(local.accounts || {}) },
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
