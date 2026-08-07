// مُنسّق التطبيق: حالة واحدة، توجيه بالهاش، وتفويض الأحداث.

import { db, getSettings, saveSettings, getRules, saveRules, exportAll, importAll } from './store.js';
import { readFileToRows, rowsToTransactions, dedupe, pickStatementSheet } from './import.js';
import { applyClassification, suggestRule, CATEGORY_MAP } from './classify.js';
import { analyze } from './analytics.js';
import { evaluate, planTerms, gapAnalysis, profileFromAnalytics, installmentOf, effectiveAPR } from './affordability.js';
import { uid, groupBy, money, monthLabel } from './util.js';
import * as V from './views.js';

const state = {
  route: 'dashboard',
  transactions: [],
  settings: null,
  rules: [],
  analysis: null,
  profile: null,
  evaluation: null,
  plan: null,
  gap: null,
  pending: null,
  importAccount: '',
  openCategory: null,
  filter: { q: '', cat: '', account: '', onlyUncat: false, onlyExcluded: false },
  finance: { amount: 100000, months: 60, annualRate: 0.0599, mode: 'flat', knownInstallment: null },
  accountsSummary: [],
  busy: false,
};

const ROUTES = {
  dashboard: { ar: 'لوحة القيادة', icon: '📊' },
  categories: { ar: 'المجالات', icon: '🧭' },
  commitments: { ar: 'الالتزامات', icon: '🔁' },
  financing: { ar: 'الملاءة والتمويل', icon: '🏦' },
  transactions: { ar: 'العمليات', icon: '📜' },
  import: { ar: 'الاستيراد', icon: '📥' },
  settings: { ar: 'الإعدادات', icon: '⚙️' },
};

// ── الإقلاع ───────────────────────────────────────────────────────────────
async function boot() {
  state.settings = await getSettings();
  state.rules = await getRules();
  const saved = await db.get('financeForm', null);
  if (saved) state.finance = { ...state.finance, ...saved };
  await reload();
  window.addEventListener('hashchange', () => { state.route = routeFromHash(); render(); });
  state.route = routeFromHash();
  document.getElementById('nav').innerHTML = Object.entries(ROUTES)
    .map(([k, v]) => `<a href="#${k}" data-route="${k}"><span>${v.icon}</span>${v.ar}</a>`).join('');
  bindEvents();
  render();
}

function routeFromHash() {
  const h = (location.hash || '').replace('#', '');
  return ROUTES[h] ? h : 'dashboard';
}

async function reload() {
  state.transactions = await db.allTx();
  applyClassification(state.transactions, state.rules);
  state.analysis = state.transactions.length ? analyze(state.transactions, state.settings) : null;
  state.accountsSummary = buildAccountsSummary(state.transactions);
  recompute();
}

function buildAccountsSummary(list) {
  const g = groupBy(list, (t) => t.account);
  return [...g.entries()].map(([account, rows]) => {
    const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
    return {
      account,
      count: rows.length,
      from: sorted[0]?.date,
      to: sorted[sorted.length - 1]?.date,
      balance: [...sorted].reverse().find((t) => isFinite(t.balance))?.balance ?? null,
    };
  });
}

/** يعيد بناء صورة الوضع المالي والحكم كلما تغيّر مُدخل. */
function recompute() {
  if (!state.analysis) { state.profile = null; state.evaluation = null; state.plan = null; return; }
  const m = state.settings.manual || {};
  const overrides = {};
  if (m.income !== '' && m.income != null) overrides.income = { p50: +m.income, p25: +m.income };
  if (m.essentials !== '' && m.essentials != null) overrides.essentials = { p50: +m.essentials, p75: +m.essentials * 1.1 };
  if (m.discretionary !== '' && m.discretionary != null) overrides.discretionary = { p50: +m.discretionary, p75: +m.discretionary * 1.25 };
  if (m.existingInstallments !== '' && m.existingInstallments != null) overrides.existingInstallments = +m.existingInstallments;
  if (m.liquidBuffer !== '' && m.liquidBuffer != null) overrides.liquidBuffer = +m.liquidBuffer;

  state.profile = profileFromAnalytics(state.analysis, overrides);

  const f = state.finance;
  let request = { amount: +f.amount || 0, months: +f.months || 1, annualRate: +f.annualRate || 0, mode: f.mode };
  // إن أدخل المستخدم قسطًا معلنًا، نستنتج منه المعدل الفعلي ونحكم على القسط الحقيقي
  if (f.knownInstallment > 0) {
    const apr = effectiveAPR({ amount: request.amount, months: request.months, installment: +f.knownInstallment });
    request = { ...request, annualRate: apr, mode: 'reducing' };
  }
  state.request = request;
  state.evaluation = evaluate(state.profile, request, state.settings.policy);
  state.plan = planTerms(state.profile, { amount: request.amount, annualRate: request.annualRate, mode: request.mode }, state.settings.policy);
  state.gap = gapAnalysis(state.profile, request, state.settings.policy);
}

// ── العرض ─────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
  const a = state.analysis;
  let html = '';
  switch (state.route) {
    case 'import': html = V.viewImport(state); break;
    case 'categories': html = V.viewCategories(a, state); break;
    case 'commitments': html = V.viewCommitments(a); break;
    case 'financing': html = V.viewFinancing(a, state); break;
    case 'transactions': html = V.viewTransactions(a, state); break;
    case 'settings': html = V.viewSettings(state, a); break;
    default: html = V.viewDashboard(a, state);
  }
  app.innerHTML = `<h1 class="page-title">${ROUTES[state.route].icon} ${ROUTES[state.route].ar}</h1>${html}`;
  app.scrollTop = 0;
  updateBanner();
}

function updateBanner() {
  const el = document.getElementById('banner');
  const a = state.analysis;
  if (!a) { el.innerHTML = ''; return; }
  el.innerHTML = `<span>${a.coverage.accounts.length} حساب · ${a.coverage.txCount} عملية ·
    ${a.coverage.from ? monthLabel(a.coverage.from) : ''} — ${a.coverage.to ? monthLabel(a.coverage.to) : ''}</span>`;
}

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ── الأحداث ───────────────────────────────────────────────────────────────
function bindEvents() {
  const app = document.getElementById('app');

  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'pick-file') { document.getElementById('file-input')?.click(); return; }
    if (action === 'go-import') { location.hash = 'import'; return; }
    if (action === 'go-categories') { location.hash = 'categories'; return; }
    if (action === 'go-tag') { state.filter = { ...state.filter, onlyUncat: true, cat: '' }; location.hash = 'transactions'; return; }
    if (action === 'go-excluded') { state.filter = { ...state.filter, onlyExcluded: true }; location.hash = 'transactions'; return; }
    if (action.startsWith('open-category')) {
      state.openCategory = el.dataset.cat || action.split(':')[1];
      if (state.route !== 'categories') location.hash = 'categories'; else render();
      return;
    }
    if (action === 'close-category') { state.openCategory = null; render(); return; }
    if (action === 'cancel-import') { state.pending = null; render(); return; }
    if (action === 'confirm-import') { await confirmImport(); return; }
    if (action === 'drop-account') { await dropAccount(el.dataset.account); return; }
    if (action === 'toggle-exclude') { await toggleExclude(el.dataset.id); return; }
    if (action === 'del-rule') { await delRule(el.dataset.id); return; }
    if (action === 'export-json') { downloadJSON(); return; }
    if (action === 'export-csv') { downloadCSV(); return; }
    if (action === 'import-json') { pickJSON(); return; }
    if (action === 'wipe') { await wipe(); return; }
  });

  app.addEventListener('change', async (e) => {
    const id = e.target.id;
    if (e.target.classList.contains('cat-select')) { await setCategory(e.target.dataset.id, e.target.value); return; }
    if (id === 'file-input') { await handleFiles(e.target.files); return; }
    if (id === 'acc-name') { state.importAccount = e.target.value; return; }

    if (id?.startsWith('f-')) { updateFinance(); return; }
    if (id === 'q' || id?.startsWith('f-c') || id === 'f-acc' || id === 'f-uncat' || id === 'f-exc') { updateFilter(); return; }
    if (id?.startsWith('p-') || id?.startsWith('a-') || id?.startsWith('m-')) { await updateSettings(); return; }
  });

  app.addEventListener('input', (e) => {
    if (e.target.id === 'q') { clearTimeout(bindEvents._q); bindEvents._q = setTimeout(updateFilter, 250); }
    if (e.target.id?.startsWith('f-')) { clearTimeout(bindEvents._f); bindEvents._f = setTimeout(updateFinance, 300); }
  });

  // السحب والإفلات
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.getElementById('dropzone')?.classList.add('over'); });
  document.addEventListener('dragleave', () => document.getElementById('dropzone')?.classList.remove('over'));
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.getElementById('dropzone')?.classList.remove('over');
    if (e.dataTransfer?.files?.length) {
      if (state.route !== 'import') { location.hash = 'import'; await nextFrame(); }
      await handleFiles(e.dataTransfer.files);
    }
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// ── الاستيراد ─────────────────────────────────────────────────────────────
async function handleFiles(files) {
  if (!files || !files.length) return;
  const password = document.getElementById('pdf-pass')?.value || '';
  const accInput = document.getElementById('acc-name')?.value?.trim();
  const collected = [];
  const warnings = [];
  let skipped = 0, balanceCheck = null, fileName = '';

  for (const file of files) {
    fileName = fileName ? `${fileName} + ${file.name}` : file.name;
    const account = accInput || guessAccountName(file.name);
    try {
      const read = await readFileToRows(file, { password });
      let rows = read.rows, details = null;
      if (read.sheets) {
        const picked = pickStatementSheet(read.sheets);
        if (picked) { rows = picked.grid; details = picked.details; }
      }
      const res = rowsToTransactions(rows, { account, source: file.name, details });
      if (!res.transactions.length) { warnings.push(`${file.name}: لم تُقرأ أي عملية.`); continue; }
      collected.push(...res.transactions);
      warnings.push(...res.warnings.map((w) => `${file.name}: ${w}`));
      skipped += res.skipped;
      balanceCheck = res.balanceCheck;
    } catch (err) {
      warnings.push(`${file.name}: ${err.message === 'PasswordException' || /password/i.test(err.message) ? 'الملف محمي بكلمة مرور — أدخلها ثم أعد المحاولة.' : err.message}`);
    }
  }

  if (!collected.length) { state.pending = null; toast(warnings[0] || 'تعذّر قراءة الملف', 'danger'); render(); return; }

  applyClassification(collected, state.rules);
  const { fresh, dups } = dedupe(collected, await db.existingHashes());
  state.pending = { fileName, transactions: collected, fresh, dups, skipped, warnings, balanceCheck };
  render();
}

function guessAccountName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  if (/ثاني|second|_b\b|b$/i.test(base)) return 'الحساب الثاني';
  return base.slice(0, 28) || 'حساب';
}

async function confirmImport() {
  if (!state.pending) return;
  const n = state.pending.fresh.length;
  if (!n) { toast('كل العمليات موجودة مسبقًا', 'warn'); state.pending = null; render(); return; }
  await db.putMany(state.pending.fresh);
  state.pending = null;
  await reload();
  toast(`أُضيفت ${n} عملية`, 'ok');
  location.hash = 'dashboard';
  render();
}

async function dropAccount(account) {
  if (!confirm(`حذف كل عمليات «${account}»؟`)) return;
  const rows = state.transactions.filter((t) => t.account === account);
  for (const r of rows) await db.remove(r.id);
  await reload();
  toast(`حُذفت ${rows.length} عملية`, 'ok');
  render();
}

// ── التصنيف والاستبعاد ────────────────────────────────────────────────────
async function setCategory(id, category) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  t.category = category;
  t.categorySource = 'user';
  await db.put(stripRuntime(t));

  // القاعدة المقترحة تعمّم الوسم على أشباهه
  const s = suggestRule(t, category);
  const exists = state.rules.find((r) => r.field === s.field && String(r.value) === String(s.value));
  if (!exists) {
    state.rules.push({ id: uid(), priority: 10, ...s });
    await saveRules(state.rules);
  }
  await reload();
  const affected = state.transactions.filter((x) => x.category === category && x.merchantKey && x.merchantKey === t.merchantKey).length;
  toast(`صُنّفت ضمن «${CATEGORY_MAP[category]?.ar}»${affected > 1 ? ` وطُبّقت على ${affected} عملية` : ''}`, 'ok');
  render();
}

async function toggleExclude(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  if (t.excludeReason === 'user') { t.excludeReason = null; t.excluded = false; }
  else { t.excluded = true; t.excludeReason = 'user'; }
  await db.put(stripRuntime(t));
  await reload();
  render();
}

/** الحقول المشتقّة تُحسب عند كل تحميل، فلا داعي لتخزينها. */
function stripRuntime(t) {
  const { type, merchant, merchantKey, city, channel, ruleId, ...keep } = t;
  return { ...keep, excluded: t.excluded, excludeReason: t.excludeReason, category: t.category, categorySource: t.categorySource };
}

async function delRule(id) {
  state.rules = state.rules.filter((r) => r.id !== id);
  await saveRules(state.rules);
  await reload();
  render();
}

// ── تحديث المدخلات ────────────────────────────────────────────────────────
function updateFinance() {
  const g = (id) => document.getElementById(id);
  state.finance = {
    amount: +g('f-amount')?.value || 0,
    months: Math.max(1, +g('f-months')?.value || 1),
    annualRate: (+g('f-rate')?.value || 0) / 100,
    mode: g('f-mode')?.value || 'flat',
    knownInstallment: +g('f-known')?.value || null,
  };
  db.set('financeForm', state.finance);
  recompute();
  render();
}

function updateFilter() {
  const g = (id) => document.getElementById(id);
  state.filter = {
    q: g('q')?.value || '',
    cat: g('f-cat')?.value || '',
    account: g('f-acc')?.value || '',
    onlyUncat: !!g('f-uncat')?.checked,
    onlyExcluded: !!g('f-exc')?.checked,
  };
  render();
}

async function updateSettings() {
  const g = (id) => document.getElementById(id);
  const numOr = (id, dflt) => { const v = g(id)?.value; return v === '' || v == null ? dflt : +v; };
  const blankOr = (id) => { const v = g(id)?.value; return v === '' || v == null ? '' : +v; };

  state.settings = await saveSettings({
    policy: {
      dbrCap: numOr('p-dbrCap', 33) / 100,
      dbrHardCap: numOr('p-dbrHardCap', 45) / 100,
      installmentShareCap: numOr('p-instShare', 25) / 100,
      comfortSurplusRatio: numOr('p-surplus', 10) / 100,
      minBufferMonths: numOr('p-buffer', 3),
      maxTerm: numOr('p-maxTerm', 72),
    },
    analysis: {
      excludeInternal: !!g('a-internal')?.checked,
      excludeReversals: !!g('a-rev')?.checked,
      excludeExtraordinary: !!g('a-extra')?.checked,
      ignoreLastPartialMonth: !!g('a-partial')?.checked,
      extraordinaryFactor: numOr('a-factor', 4),
    },
    manual: {
      income: blankOr('m-income'),
      essentials: blankOr('m-essentials'),
      discretionary: blankOr('m-discretionary'),
      existingInstallments: blankOr('m-installments'),
      liquidBuffer: blankOr('m-buffer'),
    },
  });
  await reload();
  toast('حُفظت الإعدادات', 'ok');
  render();
}

// ── البيانات ──────────────────────────────────────────────────────────────
async function downloadJSON() {
  const payload = await exportAll();
  save(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `mybudget-${today()}.json`);
}

function downloadCSV() {
  const head = ['التاريخ', 'الحساب', 'النوع', 'التاجر', 'المدينة', 'الوصف', 'المبلغ', 'الرصيد', 'المجال', 'مستبعد', 'سبب الاستبعاد', 'المرجع'];
  const lines = [head.join(',')];
  for (const t of state.transactions) {
    lines.push([t.date, t.account, t.type, t.merchant || '', t.city || '', (t.desc || '').replace(/[\n,]/g, ' '),
      t.amount, t.balance ?? '', CATEGORY_MAP[t.category]?.ar || '', t.excluded ? 'نعم' : 'لا', t.excludeReason || '', t.ref || '']
      .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
  }
  save(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `transactions-${today()}.csv`);
}

function pickJSON() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json';
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const n = await importAll(JSON.parse(await f.text()), { replace: confirm('استبدال البيانات الحالية؟ (إلغاء = دمج)') });
      state.settings = await getSettings();
      state.rules = await getRules();
      await reload();
      toast(`استُوردت ${n} عملية`, 'ok');
      render();
    } catch (err) { toast(`تعذّر الاستيراد: ${err.message}`, 'danger'); }
  };
  inp.click();
}

async function wipe() {
  if (!confirm('سيُمحى كل شيء نهائيًا. متأكد؟')) return;
  await db.clearTx();
  await saveRules([]);
  await reload();
  toast('مُسحت البيانات', 'ok');
  render();
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const today = () => new Date().toISOString().slice(0, 10);

boot().catch((e) => {
  document.getElementById('app').innerHTML = `<div class="empty"><p>تعذّر بدء التطبيق: ${e.message}</p></div>`;
  console.error(e);
});
