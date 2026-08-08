// استيراد كشوف الحساب: Excel (‎.xls/.xlsx‎) و CSV و PDF — كلها تُقرأ داخل المتصفح.

import { parseNumber, toISODate, normalizeDigits, hashTx, uid } from './util.js';

// ── قراءة الملفات إلى صفوف خام ────────────────────────────────────────────

export async function readFileToRows(file, { password } = {}) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return { rows: await readPDF(file, password), kind: 'pdf' };
  if (name.endsWith('.csv') || name.endsWith('.txt')) return { rows: await readCSV(file), kind: 'csv' };
  const sheets = await readWorkbook(file);
  const rows = Object.values(sheets).flat();
  return { rows, sheets, kind: 'excel' };
}

/** @returns {Object<string, string[][]>} كل ورقة بشبكتها. */
async function readWorkbook(file) {
  if (typeof XLSX === 'undefined') throw new Error('مكتبة قراءة Excel لم تُحمّل');
  const buf = await file.arrayBuffer();
  // codepage 1256 يعالج ملفات ‎.xls‎ القديمة التي تصدّرها البنوك السعودية بالعربية
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array', codepage: 1256, cellDates: false, raw: false });
  const out = {};
  for (const sheetName of wb.SheetNames) {
    out[sheetName] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
  }
  return out;
}

async function readCSV(file) {
  let text = await file.text();
  // إن ظهرت علامات فقدان الترميز، أعد القراءة بترميز windows-1256
  if (/�/.test(text)) {
    try { text = new TextDecoder('windows-1256').decode(await file.arrayBuffer()); } catch { /* تجاهل */ }
  }
  return parseCSV(text);
}

/** محلّل CSV يحترم علامات الاقتباس والأسطر داخل الحقول. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/** استخراج أسطر نصية من PDF مع دعم كلمة المرور، وإعادة تركيب الأعمدة حسب الإحداثيات. */
export async function readPDF(file, password) {
  const pdfjs = await import('../vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, password: password || undefined }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = new Map(); // y مقرّب → عناصر
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: item.transform[4], s: item.str });
    }
    const ys = [...lines.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const cells = lines.get(y).sort((a, b) => a.x - b.x).map((c) => c.s.trim()).filter(Boolean);
      if (cells.length) rows.push(cells);
    }
  }
  return rows;
}

// ── التعرّف على الأعمدة ───────────────────────────────────────────────────

const HEADER_PATTERNS = [
  ['hijri', /هجري/],
  ['btype', /نوع العملية/],
  ['date', /(التاريخ الميلادي|تاريخ العملية|التاريخ|date|value\s*date|posting)/i],
  ['ref', /(رقم العملية|المرجع|reference|ref)/i],
  ['debit', /(مدين|مسحوبات|debit|withdraw)/i],
  ['credit', /(دائن|مودع|إيداع|credit|deposit)/i],
  ['balance', /(الرصيد|balance)/i],
  ['desc', /(وصف العملية|البيان|الوصف|التفاصيل|description|narrative|details)/i],
  ['amount', /(المبلغ|amount)/i],
];

/**
 * كم صفًّا يُفتَّش عن صفّ العناوين.
 * كان خمسةً عند اختيار الورقة وخمسةَ عشرَ عند القراءة، وكشف الراجحي يضع
 * عنوانه في الصف السادس عشر بعد ديباجةٍ فيها اسم العميل والرصيد ومعايير
 * البحث — فكان يُرفض كاملًا: صفر عملية بلا سببٍ مفهوم للمستخدم.
 * والتوسعة آمنة: `detectHeader` يشترط كلماتِ عناوينَ لا تجتمع في صفّ بيانات.
 */
const HEADER_SCAN_ROWS = 40;

/** يحدد فهرس كل عمود من صف العناوين، أو يعيد null إن لم يكن الصف عنوانًا. */
export function detectHeader(row) {
  if (!row || row.length < 3) return null;
  const map = {};
  let hits = 0;
  row.forEach((cell, i) => {
    const c = String(cell || '').trim();
    if (!c) return;
    for (const [key, re] of HEADER_PATTERNS) {
      if (map[key] !== undefined) continue;
      if (re.test(c)) { map[key] = i; hits++; break; }
    }
  });
  const hasDate = map.date !== undefined;
  const hasValue = map.debit !== undefined || map.credit !== undefined || map.amount !== undefined;
  return hasDate && hasValue && hits >= 3 ? map : null;
}

/** استنتاج الأعمدة من البيانات نفسها حين لا يوجد صف عناوين (حالة CSV بنك البلاد). */
export function inferColumns(rows) {
  const sample = rows.slice(0, 40).filter((r) => r.length >= 4);
  if (!sample.length) return null;
  const width = mode(sample.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => sample.map((r) => String(r[i] ?? '')));
  const isDate = (arr) => arr.filter((v) => toISODate(v)).length / Math.max(1, arr.length) > 0.7;
  const isNum = (arr) => arr.filter((v) => v.trim() !== '' && parseNumber(v) !== null).length / Math.max(1, arr.length) > 0.5;
  const isSparseNum = (arr) => {
    const filled = arr.filter((v) => v.trim() !== '');
    return filled.length > 0 && filled.length < arr.length && filled.every((v) => parseNumber(v) !== null);
  };

  const map = {};
  const isHijri = (arr) => arr.filter((v) => /^\d{1,2}[-/]\d{1,2}[-/]1[34]\d\d$/.test(v.trim())).length / Math.max(1, arr.length) > 0.7;
  const dateCols = cols.map((c, i) => [i, c]).filter(([, c]) => isDate(c)).map(([i]) => i);
  const hijriCols = cols.map((c, i) => [i, c]).filter(([i, c]) => !dateCols.includes(i) && isHijri(c)).map(([i]) => i);
  if (!dateCols.length) return null;
  map.date = dateCols[0];
  if (hijriCols.length) map.hijri = hijriCols[0];
  else if (dateCols.length >= 2) { map.hijri = dateCols[0]; map.date = dateCols[1]; }

  // رقم العملية يُميَّز بنمطه (حرفان ثم أرقام) حتى لا يُخلط بعمود الوصف
  cols.forEach((c, i) => {
    if (map.ref !== undefined || dateCols.includes(i)) return;
    const hit = c.filter((v) => /^[A-Za-z]{2,4}\d{6,}$/.test(v.trim())).length;
    if (hit / Math.max(1, c.length) > 0.7) map.ref = i;
  });

  const numCols = cols.map((c, i) => [i, c]).filter(([i, c]) => !dateCols.includes(i) && (isNum(c) || isSparseNum(c))).map(([i]) => i);
  const sparse = numCols.filter((i) => isSparseNum(cols[i]));
  const dense = numCols.filter((i) => !sparse.includes(i));
  if (sparse.length >= 2) {
    // عمودان متفرقان متقابلان = مدين/دائن. المدين هو الذي تغلب عليه القيم السالبة أو الأسبق.
    const [a, b] = sparse;
    const negRatio = (i) => cols[i].filter((v) => v.trim() && parseNumber(v) < 0).length / Math.max(1, cols[i].filter((v) => v.trim()).length);
    if (negRatio(a) >= negRatio(b)) { map.debit = a; map.credit = b; } else { map.debit = b; map.credit = a; }
  } else if (numCols.length >= 2) {
    map.amount = numCols[0];
  }
  if (dense.length) map.balance = dense[dense.length - 1];

  // الوصف: العمود النصي الأغزر كلماتٍ — لا مجرّد الأطول، كيلا يُنتخب معرّفٌ طويل
  const used = new Set(Object.values(map));
  let best = -1, bestScore = 0;
  cols.forEach((c, i) => {
    if (used.has(i)) return;
    const score = c.reduce((s, v) => {
      const t = v.trim();
      if (!t || /^[A-Za-z]{2,4}\d{6,}$/.test(t) || /^[\d.,-]+$/.test(t)) return s;
      return s + t.split(/\s+/).length * 2 + (/[؀-ۿ]/.test(t) ? 3 : 0);
    }, 0) / c.length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0 && bestScore > 1) map.desc = best;
  return map.date !== undefined && (map.debit !== undefined || map.amount !== undefined) ? map : null;
}

function mode(arr) {
  const c = new Map();
  arr.forEach((x) => c.set(x, (c.get(x) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── تحويل الصفوف إلى عمليات ───────────────────────────────────────────────

/**
 * @returns {{transactions:Array, skipped:number, columns:object, warnings:string[]}}
 */
/**
 * يختار ورقة الحركات من مصنّف متعدد الأوراق، ويلتقط ورقة «التفاصيل الكاملة» إن وُجدت
 * (النسخة القابلة للتحليل من كشف بنك البلاد تحوي اسم التاجر ومدينته داخلها).
 */
export function pickStatementSheet(sheets) {
  if (!sheets) return null;
  const names = Object.keys(sheets);
  const detailsName = names.find((n) => /تفاصيل/.test(n));
  const details = new Map();
  if (detailsName) {
    const grid = sheets[detailsName];
    const head = grid[0] || [];
    const refIdx = head.findIndex((c) => /مرجع/.test(String(c)));
    const txtIdx = head.findIndex((c) => /تفاصيل/.test(String(c)));
    if (refIdx >= 0 && txtIdx >= 0) {
      for (const r of grid.slice(1)) {
        const ref = String(r[refIdx] || '').trim();
        if (ref) details.set(ref, String(r[txtIdx] || ''));
      }
    }
  }
  // ورقة الحركات = الورقة التي يتعرّف محلّل العناوين عليها وفيها أكبر عدد صفوف
  let best = null;
  for (const n of names) {
    if (n === detailsName) continue;
    const grid = sheets[n];
    const hit = grid.slice(0, HEADER_SCAN_ROWS).some((r) => detectHeader(r));
    if (!hit) continue;
    if (!best || grid.length > sheets[best].length) best = n;
  }
  if (!best) return null;
  return { name: best, grid: sheets[best], details };
}

/**
 * @returns {{transactions:Array, skipped:number, columns:object, warnings:string[]}}
 */
export function rowsToTransactions(rows, { account = 'حساب', source = '', details = null } = {}) {
  const warnings = [];
  let columns = null, startAt = 0;

  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const h = detectHeader(rows[i]);
    if (h) { columns = h; startAt = i + 1; break; }
  }
  if (!columns) {
    columns = inferColumns(rows);
    startAt = 0;
    if (columns) warnings.push('لا يوجد صف عناوين — استُنتجت الأعمدة من البيانات، فراجع العيّنة قبل الاعتماد.');
  }
  if (!columns) return { transactions: [], skipped: rows.length, columns: null, warnings: ['تعذّر التعرّف على أعمدة الكشف.'] };

  const out = [];
  let skipped = 0, seq = 0;
  for (let i = startAt; i < rows.length; i++) {
    const r = rows[i];
    const date = toISODate(cell(r, columns.date));
    if (!date) { skipped++; continue; }

    const debit = parseNumber(cell(r, columns.debit));
    const credit = parseNumber(cell(r, columns.credit));
    const amtCol = parseNumber(cell(r, columns.amount));
    let amount = null;
    if (debit != null && debit !== 0) amount = -Math.abs(debit);
    else if (credit != null && credit !== 0) amount = Math.abs(credit);
    else if (amtCol != null && amtCol !== 0) amount = amtCol;
    if (amount == null) { skipped++; continue; }

    const t = {
      id: uid(),
      seq: seq++,
      account,
      source,
      date,
      hijri: normalizeDigits(cell(r, columns.hijri)) || null,
      ref: String(cell(r, columns.ref) || '').trim() || null,
      bankType: String(cell(r, columns.btype) || '').trim() || null,
      desc: String(cell(r, columns.desc) || '').replace(/\s+/g, ' ').trim(),
      amount: round2(amount),
      balance: parseNumber(cell(r, columns.balance)),
      category: null,
      categorySource: null,
      excluded: false,
      excludeReason: null,
      linkId: null,
      note: '',
    };
    if (details && t.ref && details.has(t.ref)) t.details = details.get(t.ref);
    out.push(t);
  }

  // بصمة كل عملية: رقمها إن وُجد، وإلا ترتيب ظهور المتطابقات داخل الملف
  const occ = new Map();
  for (const t of out) {
    const base = `${t.date}|${t.amount}|${t.ref || t.desc}`;
    const n = occ.get(base) || 0;
    occ.set(base, n + 1);
    t.hash = hashTx(t, n);
  }

  // بعض البنوك تصدّر الأحدث أولًا وبعضها الأقدم، وترتيب العمليات داخل اليوم الواحد
  // لا يُستدل عليه من التاريخ. فبدل التخمين نعكس الكتلة ونحتكم إلى الأرصدة نفسها:
  // الترتيب الصحيح هو الذي يتّسق فيه فرقُ الرصيد مع مبلغ العملية.
  const asIs = verifyBalances(out);
  const reversed = out.slice().reverse();
  const rev = verifyBalances(reversed);
  const useReversed = rev.checked && asIs.checked ? rev.mismatches < asIs.mismatches
    : out.length > 1 && out[0].date > out[out.length - 1].date;
  if (useReversed) { out.length = 0; out.push(...reversed); }
  out.forEach((t, i) => { t.seq = i; });

  const balCheck = verifyBalances(out);
  if (balCheck.checked && !balCheck.ok) {
    warnings.push(`تحقّق الأرصدة: ${balCheck.mismatches} صفًّا لا يطابق فرق الرصيد المتسلسل — قد يكون في الكشف صفوف مفقودة أو ترتيب مختلف.`);
  }

  return { transactions: out, skipped, columns, warnings, balanceCheck: balCheck };
}

function cell(row, idx) { return idx === undefined || idx == null ? '' : row[idx]; }
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * تدقيق سلامة الاستيراد: هل يساوي فرق الرصيد بين كل عمليتين مبلغَ العملية؟
 * هذا برهان حسابي على أن الاستيراد لم يفقد صفًّا ولم يقلب إشارة.
 */
export function verifyBalances(list) {
  // `Number.isFinite` لا `isFinite`: العالمية تُحوّل قبل الفحص، و`null` عندها
  // صفرٌ منتهٍ. فكشفٌ بلا عمود رصيد كان يُقرأ كأن كل صفوفه برصيد صفر، فتخرج
  // فروقٌ بعدد صفوفه — إنذارُ خطأٍ كاذب في أداةٍ حجّتها تدقيق الأرصدة.
  const withBal = list.filter((t) => Number.isFinite(t.balance));
  if (withBal.length < 3) return { checked: false, ok: true, mismatches: 0, total: 0 };
  let mismatches = 0;
  for (let i = 1; i < withBal.length; i++) {
    const delta = withBal[i].balance - withBal[i - 1].balance;
    if (Math.abs(delta - withBal[i].amount) > 0.02) mismatches++;
  }
  return {
    checked: true,
    total: withBal.length - 1,
    mismatches,
    ok: mismatches / (withBal.length - 1) < 0.02,
    ratio: mismatches / (withBal.length - 1),
  };
}

/** يزيل المكرر مقابل ما هو مخزَّن أصلًا. */
export function dedupe(incoming, existingHashes) {
  const seen = new Set(existingHashes);
  const fresh = [], dups = [];
  for (const t of incoming) {
    if (seen.has(t.hash)) { dups.push(t); continue; }
    seen.add(t.hash);
    fresh.push(t);
  }
  return { fresh, dups };
}
