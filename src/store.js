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

export async function getSettings() {
  const s = await db.get('settings', null);
  return deepMerge(DEFAULT_SETTINGS, s || {});
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  await db.set('settings', next);
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
export async function saveRules(rules) { return db.set('rules', rules); }

// ── الحسابات ──────────────────────────────────────────────────────────────
export async function getAccounts() { return (await db.get('accounts', {})) || {}; }
export async function saveAccounts(map) { return db.set('accounts', map); }

// ── تصدير/استيراد نسخة كاملة ──────────────────────────────────────────────
export async function exportAll() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    transactions: await db.allTx(),
    settings: await getSettings(),
    rules: await getRules(),
    accounts: await getAccounts(),
  };
}

export async function importAll(payload, { replace = false } = {}) {
  if (!payload || !Array.isArray(payload.transactions)) throw new Error('ملف نسخة غير صالح');
  if (replace) await db.clearTx();
  await db.putMany(payload.transactions);
  if (payload.settings) await db.set('settings', payload.settings);
  if (payload.rules) await saveRules(payload.rules);
  if (payload.accounts) await saveAccounts(payload.accounts);
  return payload.transactions.length;
}
