// تخزين محلي بالكامل داخل المتصفح (IndexedDB). لا يغادر أي رقم جهازك.

const DB_NAME = 'mybudget';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tx')) {
        const s = db.createObjectStore('tx', { keyPath: 'id' });
        s.createIndex('hash', 'hash', { unique: false });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * يطلب من المتصفح تثبيت التخزين.
 * بعض المتصفحات — وسفاري على الجوال خاصةً — تُخلي تخزين المواقع تلقائيًا
 * بعد فترة من عدم الاستخدام. هذا الطلب يجعل البيانات «دائمة» فلا تُمحى
 * إلا بفعل المستخدم. لا يُمنح دائمًا، ولذلك تبقى النسخة المصدَّرة هي الضمان.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  try {
    const already = await navigator.storage.persisted();
    const persisted = already || await navigator.storage.persist();
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : {};
    return { supported: true, persisted, usage: est.usage, quota: est.quota };
  } catch {
    return { supported: true, persisted: false };
  }
}

export const db = {
  async allTx() {
    const s = await tx('tx');
    const rows = await wrap(s.getAll());
    return rows.sort((a, b) => (a.date === b.date ? (a.seq || 0) - (b.seq || 0) : a.date.localeCompare(b.date)));
  },

  async putMany(rows) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const t = database.transaction('tx', 'readwrite');
      const s = t.objectStore('tx');
      rows.forEach((r) => s.put(r));
      t.oncomplete = () => resolve(rows.length);
      t.onerror = () => reject(t.error);
    });
  },

  async put(row) { const s = await tx('tx', 'readwrite'); return wrap(s.put(row)); },
  async remove(id) { const s = await tx('tx', 'readwrite'); return wrap(s.delete(id)); },

  async clearTx() { const s = await tx('tx', 'readwrite'); return wrap(s.clear()); },

  async existingHashes() {
    const rows = await this.allTx();
    return new Set(rows.map((r) => r.hash));
  },

  async get(key, dflt = null) {
    const s = await tx('kv');
    const v = await wrap(s.get(key));
    return v === undefined ? dflt : v;
  },
  async set(key, value) { const s = await tx('kv', 'readwrite'); return wrap(s.put(value, key)); },
};

// ── الإعدادات ─────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
  policy: {
    dbrCap: 0.33,
    dbrHardCap: 0.45,
    installmentShareCap: 0.25,
    comfortSurplusRatio: 0.10,
    minBufferMonths: 3,
    maxTerm: 72,
    minTerm: 6,
  },
  // حسابات المستخدم ومحافظه لدى جهات أخرى: ما يذهب إليها نقلُ مالٍ لا صرف
  ownAccounts: { ibans: [], merchants: [] },
  manual: {                 // تجاوزات يدوية على صورة الوضع المالي
    income: '', essentials: '', discretionary: '', existingInstallments: '', liquidBuffer: '',
  },
  analysis: {
    excludeInternal: true,      // استبعاد التحويل بين حساباتي
    excludeReversals: true,     // استبعاد العمليات المرتجعة
    excludeExtraordinary: true, // استبعاد الدفعات الاستثنائية (تمويل، مبالغ ضخمة لمرة واحدة)
    extraordinaryFactor: 4,     // ما تجاوز 4× وسيط الشهر يُعرض للمراجعة
    ignoreLastPartialMonth: true,
  },
  ui: { theme: 'auto' },
};

/**
 * ختمُ آخر تغييرٍ فعلي في الإعدادات والقواعد والحسابات.
 * الدمج كان يرجّح بـ`exportedAt`، وهو يُختم لحظةَ التصدير — فالنسخة المحلية
 * أحدثُ دائمًا بحكم التعريف، فلا يصل الجهازَ شيءٌ ممّا ضبطتَه على الآخر:
 * وسمُ حساباتك، وسقوفُ سياستك، وقواعدُك. فنختم لحظةَ الحفظ لا لحظة التصدير.
 */
export async function touchSettings() { return db.set('settingsAt', new Date().toISOString()); }
export async function getSettingsAt() { return db.get('settingsAt', null); }

export async function getSettings() {
  const s = await db.get('settings', null);
  return deepMerge(DEFAULT_SETTINGS, s || {});
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  await db.set('settings', next);
  await touchSettings();
  return next;
}

export function deepMerge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && a[k] !== null && !Array.isArray(a[k])) {
      out[k] = deepMerge(a[k], v);
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── قواعد التصنيف التي يبنيها المستخدم ────────────────────────────────────
export async function getRules() { return (await db.get('rules', [])) || []; }
export async function saveRules(rules) { await db.set('rules', rules); return touchSettings(); }

// ── الحسابات ──────────────────────────────────────────────────────────────
export async function getAccounts() { return (await db.get('accounts', {})) || {}; }
export async function saveAccounts(map) { await db.set('accounts', map); return touchSettings(); }

// ── شواهد الحذف ───────────────────────────────────────────────────────────
/**
 * ما حذفتَه يجب أن يبقى محذوفًا.
 * الدمج اتحادٌ بالبصمة، فلولا شاهدٌ على الحذف لعادت العملية من الجهاز الآخر:
 * وأخطرُ صورةٍ لذلك أن تُطابَق عمليةٌ معلَّقة من رسالة البنك بنظيرتها في
 * الكشف فتُحذف المعلَّقة، ثم يعيدها الجهاز الآخر — فيُحتسب المبلغ مرتين.
 * ولا يكبر السجلّ بلا حدّ: يُقلَّم ما جاوز ١٨٠ يومًا.
 */
const TOMBSTONE_DAYS = 180;

export async function getDeleted() { return (await db.get('deleted', {})) || {}; }

export async function rememberDeleted(hashes) {
  const list = [...hashes].filter(Boolean);
  if (!list.length) return;
  const map = await getDeleted();
  const now = new Date().toISOString();
  for (const h of list) map[h] = now;
  return db.set('deleted', pruneDeleted(map));
}

/**
 * يرفع شاهد الحذف عمّا استُورد من جديد.
 * الاستيراد فعلٌ صريح من المستخدم، فهو أعلى من شاهدٍ قديم: بلا هذا الرفع
 * لَاختفت العملية بعد أول مزامنة، ولَبدا أن الاستيراد ابتلعها.
 */
export async function forgetDeleted(hashes) {
  const list = [...hashes].filter(Boolean);
  if (!list.length) return;
  const map = await getDeleted();
  let touched = false;
  for (const h of list) if (h in map) { delete map[h]; touched = true; }
  if (touched) await db.set('deleted', map);
}

export function pruneDeleted(map, now = Date.now()) {
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  const out = {};
  for (const [h, at] of Object.entries(map || {})) {
    if (Date.parse(at) >= cutoff) out[h] = at;
  }
  return out;
}

// ── تصدير/استيراد نسخة كاملة ──────────────────────────────────────────────
export async function exportAll() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settingsAt: await getSettingsAt(),
    transactions: await db.allTx(),
    settings: await getSettings(),
    rules: await getRules(),
    accounts: await getAccounts(),
    deleted: await getDeleted(),
  };
}

export async function importAll(payload, { replace = false } = {}) {
  if (!payload || !Array.isArray(payload.transactions)) throw new Error('ملف نسخة غير صالح');
  if (replace) await db.clearTx();
  await db.putMany(payload.transactions);
  if (payload.settings) await db.set('settings', payload.settings);
  if (payload.rules) await db.set('rules', payload.rules);
  if (payload.accounts) await db.set('accounts', payload.accounts);
  if (payload.deleted) await db.set('deleted', pruneDeleted(payload.deleted));
  // ختم النسخة الواردة يُنقل كما هو: لو خُتم بالآن لبدا الجهاز أحدثَ ممّا هو
  // في كل دمجٍ تالٍ، فعاد العطب الذي أُصلح — وغياب الختم يعني «لا نعلم».
  if (payload.settingsAt) await db.set('settingsAt', payload.settingsAt);
  return payload.transactions.length;
}
