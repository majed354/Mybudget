// مُنسّق التطبيق: حالة واحدة، توجيه بالهاش، وتفويض الأحداث.

import { db, getSettings, saveSettings, getRules, saveRules, exportAll, importAll, requestPersistence, rememberDeleted, forgetDeleted } from './store.js';
import { readFileToRows, rowsToTransactions, dedupe, pickStatementSheet } from './import.js';
import { applyClassification, suggestRule, CATEGORY_MAP, subcategoriesFor } from './classify.js';
import { analyze, cycleSnapshot, forecastNext } from './analytics.js';
import { evaluate, planTerms, gapAnalysis, profileFromAnalytics, installmentOf, effectiveAPR } from './affordability.js';
import { uid, groupBy, money, monthLabel, APP_VERSION, todayISO, shiftCycle } from './util.js';
import * as Sync from './sync.js';
import * as Inbox from './inbox.js';
import { formOf } from './form-ids.js';
import { computeReminders, ensurePermission, fireDue } from './reminders.js';
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
  txLimit: 40,                // سقف القائمة المعروضة، يزيد بالطلب
  finance: { amount: 100000, months: 60, annualRate: 0.0599, mode: 'flat', knownInstallment: null },
  accountsSummary: [],
  storage: null,
  sync: { secret: null, lastAt: null, status: '', busy: false, foundRemote: null, remoteCount: null, size: null },
  skipSync: false,
  reminders: [],
  inbox: { boxId: null, lastAt: null, failed: [], status: '', busy: false, log: {}, waiting: 0 },
  notify: { permission: 'default', enabled: false },
  paste: null,                // لصق الرسائل الفائتة: النصّ ونتيجة تحليله
  tagging: null,              // معرّف العملية التي يُحرَّر تصنيفها
  busy: false,
};

const ROUTES = {
  dashboard: { ar: 'لوحة القيادة', short: 'الرئيسية', icon: '📊', primary: true },
  analysis: { ar: 'التحليل', short: 'التحليل', icon: '🧭', primary: true },
  transactions: { ar: 'العمليات', short: 'العمليات', icon: '📜', primary: true },
  financing: { ar: 'الملاءة والتمويل', icon: '🏦' },
  categories: { ar: 'المجالات', icon: '🧭' },
  commitments: { ar: 'الالتزامات', icon: '🔁' },
  beneficiaries: { ar: 'المستفيدون', icon: '👥' },
  import: { ar: 'الاستيراد', icon: '📥' },
  settings: { ar: 'الإعدادات', icon: '⚙️' },
};

/**
 * ثلاث شاشاتٍ تحليلية على بياناتٍ واحدة كانت ثلاث وجهاتٍ مستقلّة، وذلك
 * تقسيمُ مبرمجٍ لا تقسيمُ مستخدم. جُمعت تحت «التحليل» بمبدّلٍ داخلي، فنزلت
 * الوجهات من ثمانٍ إلى أربع — وهو الحدّ الذي يسع شريطًا سفليًّا ثابتًا بلا
 * تمريرٍ أفقي، وعليه استقرّت تطبيقات المصارف.
 */
// والملاءة معها: خدمةٌ تُسأل عند الحاجة إلى تمويل، لا سؤالَ كلِّ يوم
const ANALYSIS_TABS = [
  { id: 'categories', ar: 'المجالات' },
  { id: 'commitments', ar: 'الالتزامات' },
  { id: 'beneficiaries', ar: 'المستفيدون' },
  { id: 'financing', ar: 'الملاءة' },
];

// ── الإقلاع ───────────────────────────────────────────────────────────────
async function boot() {
  state.storage = await requestPersistence();
  state.settings = await getSettings();
  state.rules = await getRules();
  // القراءة تمرّ بـsetSyncSecret لا بـdb مباشرةً: فمن حفظ رمزًا ملتصقًا به
  // نصٌّ من الصفحة يُنقّى هنا فيعود إلى مفتاح جهازه الآخر دون أن يعيد إدخاله
  const savedSecret = await db.get('syncSecret', null);
  if (savedSecret) await setSyncSecret(savedSecret);
  state.sync.lastAt = await db.get('syncLastAt', null);
  state.skipSync = await db.get('skipSync', false);
  state.inbox.log = await db.get('inboxLog', {});
  state.notify.enabled = await db.get('notifyEnabled', false);
  state.notify.permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const saved = await db.get('financeForm', null);
  if (saved) state.finance = { ...state.finance, ...saved };
  await reload();
  window.addEventListener('hashchange', () => { state.route = routeFromHash(); render(); });
  state.route = routeFromHash();
  // شريطان من قائمةٍ واحدة: الجانبيّ على الشاشات الواسعة يعرض الوجهات كلها،
  // والسفليّ على الجوال يقتصر على الأربع الأساسية فيثبت بلا تمريرٍ أفقي.
  // والاسم القصير للسفليّ: «الملاءة» تسع الخانة، و«الملاءة والتمويل» لا تسعها.
  document.getElementById('nav').innerHTML = Object.entries(ROUTES)
    .map(([k, v]) => `<a href="#${k}" data-route="${k}" ${v.primary ? 'data-primary="1"' : ''}>
      <span>${v.icon}</span><em class="nav-full">${v.ar}</em><em class="nav-short">${v.short || v.ar}</em></a>`).join('');
  bindEvents();
  bindVersionChip();
  bindDrainButton();
  render();
  if (state.sync.secret) {
    state.inbox.boxId = await Inbox.boxIdFor(state.sync.secret);
    await refresh({ silent: true });
  }
  startAutoSync();
  checkReminders();
}

/**
 * تحديث متصل: عند فتح التطبيق، وكلما عاد إلى الواجهة، وكل دقيقة وهو ظاهر.
 * فما تسجّله على جوالك تجده على حاسبك دون أن تضغط شيئًا.
 */
function startAutoSync() {
  const tick = async () => {
    if (!state.sync.secret || document.hidden || state.sync.busy) return;
    if (Date.now() - (startAutoSync._at || 0) < 20000) return;   // لا نُرهق الشبكة
    startAutoSync._at = Date.now();
    await refresh({ silent: true });
  };
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('focus', tick);
  window.addEventListener('online', tick);
  setInterval(tick, 60000);
}

/** يسحب آخر نسخة ثم يلتقط ما وصل من رسائل البنك. */
async function refresh(opts = {}) {
  await syncPull(opts);
  await drainInbox(opts);
}

// ── رسائل البنك ───────────────────────────────────────────────────────────

/** يسحب ما وصل من إشعارات البنك ويحوّله عملياتٍ معلَّقة. */
async function drainInbox({ silent = false } = {}) {
  if (!state.sync.secret) return;
  state.inbox.busy = true;
  try {
    const { added, failed } = await Inbox.drain(state.sync.secret, { accountLabel: 'إشعارات البنك' });
    state.inbox.failed = failed;
    state.inbox.status = '';
    if (added.length) {
      const { fresh } = dedupe(added, await db.existingHashes());
      if (fresh.length) {
        await db.putMany(fresh);
        // سجلّ الحصاد: به يتأكّد المستخدم أن الأتمتة تعمل دون أن ينتظر كشفًا
        state.inbox.log = Inbox.recordDrain(state.inbox.log, todayISO(), fresh.length);
        await db.set('inboxLog', state.inbox.log);
        await reload();
        toast(`وصلت ${fresh.length} عملية من إشعارات البنك`, 'ok');
        schedulePush();
      }
    } else if (!silent) {
      toast(failed.length ? `${failed.length} رسالة لم تُفهم` : 'لا رسائل جديدة', failed.length ? 'warn' : '');
    }
    state.inbox.lastAt = new Date().toISOString();
    state.inbox.waiting = 0;   // ما فُهم أُخذ، فلا شيء ينتظر
  } catch (err) {
    state.inbox.status = err.message;
    // تعذّر السحب: نسأل الصندوق كم فيه ممّا يصير عمليةً، ليُعلَّم على الزرّ
    try { state.inbox.waiting = (await Inbox.peek(state.sync.secret)).understood; } catch { /* الشبكة نفسها منقطعة */ }
    if (!silent) toast(err.message, 'danger');
  } finally {
    state.inbox.busy = false;
    bindDrainButton.sync?.();
    render();
  }
}

/**
 * يطابق المعلَّق من الرسائل بما ورد في الكشف، فتُدمج العمليتان في واحدة.
 * بلا هذه الخطوة تُحتسب كل عملية مرتين: مرةً من الإشعار ومرةً من الكشف.
 */
async function reconcilePending() {
  const pending = state.transactions.filter((t) => t.source === 'sms' && t.status === 'pending');
  if (!pending.length) return 0;
  const booked = state.transactions.filter((t) => t.source !== 'sms');
  const { matched } = Inbox.reconcile(pending, booked);
  if (!matched.length) return 0;
  const { drop, updates } = Inbox.applyReconciliation(matched);
  for (const id of drop) await db.remove(id);
  for (const u of updates) await db.put(stripRuntime(u));
  // أخطر حذفٍ يجب أن يبقى: المعلَّقة التي طوبقت بنظيرتها في الكشف. لو عادت
  // من الجهاز الآخر لحُسب المبلغ مرتين — مرةً من الرسالة ومرةً من الكشف.
  await rememberDeleted(pending.filter((p) => drop.has(p.id)).map((p) => p.hash));
  await reload();
  return drop.size;
}

// ── التذكيرات ─────────────────────────────────────────────────────────────
async function checkReminders() {
  state.reminders = computeReminders(state.analysis);
  if (!state.notify.enabled || !state.reminders.length) return;
  const today = todayISO();
  const log = await db.get('notifyLog', { date: '', ids: [] });
  const shown = log.date === today ? log.ids : [];
  const fired = await fireDue(state.reminders, shown);
  if (fired.length) await db.set('notifyLog', { date: today, ids: [...shown, ...fired] });
}

async function toggleNotifications() {
  if (state.notify.enabled) {
    state.notify.enabled = false;
    await db.set('notifyEnabled', false);
    toast('أُوقفت التنبيهات', 'warn');
  } else {
    const perm = await ensurePermission();
    state.notify.permission = perm;
    if (perm !== 'granted') {
      toast(perm === 'denied' ? 'التنبيهات محظورة في إعدادات المتصفح' : 'لم يُمنح الإذن', 'danger');
    } else {
      state.notify.enabled = true;
      await db.set('notifyEnabled', true);
      toast('فُعّلت التنبيهات', 'ok');
      await checkReminders();
    }
  }
  render();
}

// ── المزامنة ──────────────────────────────────────────────────────────────

/**
 * ينشر ملخّص أداة الشاشة بعد كل إعادة حساب — بتأخيرٍ يمنع النشر المتكرر.
 * ولا يُنشر شيء ما لم يُفعّله المستخدم صراحةً: هذا الطريق الوحيد الذي يخرج
 * منه رقمٌ بلا تشفير، فلا يُفتح بالسهو ولا بالافتراض.
 */
function publishWidget() {
  const w = state.settings?.widget;
  if (!w?.enabled || !w.token || !state.month) return;
  clearTimeout(publishWidget._t);
  publishWidget._t = setTimeout(async () => {
    try {
      await Sync.publishWidget(w.token, Sync.widgetSummary(state.month));
      state.widgetAt = new Date().toISOString();
    } catch (err) {
      state.widgetError = err.message;
    }
    bindDrainButton.sync?.();
    if (state.route === 'settings') render();
  }, 1500);
}

/** يرفع نسخة مشفّرة بعد كل تغيير، بتأخير يمنع الرفع المتكرر. */
function schedulePush() {
  if (!state.sync.secret) return;
  clearTimeout(schedulePush._t);
  schedulePush._t = setTimeout(() => syncPush({ silent: true }), 2500);
}

async function syncPush({ silent = false } = {}) {
  if (!state.sync.secret) return;
  state.sync.busy = true;
  try {
    const out = await Sync.push(state.sync.secret, await exportAll());
    state.sync.lastAt = out.updatedAt;
    state.sync.status = '';
    state.sync.size = out.size;
    // ما رُفع الآن هو ما على الجهاز، فيتساوى العدّادان دون انتظار سحبةٍ لاحقة
    state.sync.remoteCount = state.transactions.length;
    syncPush._lastError = '';
    await db.set('syncLastAt', out.updatedAt);
    if (!silent) toast('رُفعت نسخة مشفّرة', 'ok');
  } catch (err) {
    // فشلُ الرفع يعني أن الخادم بقي على نسخةٍ قديمة وأن جهازك الآخر لن يرى
    // شيئًا. ابتلاعُه في المسار التلقائي هو ما أبقى المزامنة معطَّلة بلا أثر
    // ظاهر: كان الخطأ يُسجَّل في شاشة الإعدادات وحدها ولا ينبّه أحدًا.
    // فنُنبّه ولو كان المسار صامتًا، ولا نكرّر التنبيه ما دام الخطأ نفسه.
    state.sync.status = err.message;
    const repeated = syncPush._lastError === err.message;
    syncPush._lastError = err.message;
    if (!silent || !repeated) toast(`تعذّر رفع نسختك: ${err.message}`, 'danger');
  } finally {
    state.sync.busy = false;
    bindDrainButton.sync?.();
    if (state.route === 'settings') render();
  }
}

async function syncPull({ silent = false } = {}) {
  if (!state.sync.secret) return;
  state.sync.busy = true;
  let pushAfter = false;
  try {
    const local = await exportAll();
    const out = await Sync.pull(state.sync.secret);

    const plan = Sync.planSync(local, out.found ? out.snapshot : null);
    pushAfter = plan.push;
    state.sync.foundRemote = out.found;
    state.sync.remoteCount = out.found ? (out.snapshot.transactions || []).length : 0;

    // لا «return» هنا: الرفع يجري بعد الـfinally، والخروج المبكر يقفز فوقه
    if (!out.found) {
      state.sync.status = '';
      if (!silent && !pushAfter) {
        toast('لا توجد نسخة على الخادم لهذا الرمز بعد', 'warn');
      }
    } else {
      const { merged, added } = plan;
      await importAll(merged, { replace: true });
      state.settings = await getSettings();
      state.rules = await getRules();
      state.sync.lastAt = out.updatedAt;
      state.sync.status = '';
      await db.set('syncLastAt', out.updatedAt);
      await reload();
      if (!silent || added > 0) toast(added > 0 ? `وصلت ${added} عملية من جهاز آخر` : 'بياناتك محدَّثة', 'ok');
    }
  } catch (err) {
    state.sync.status = err.message;
    if (!silent) toast(err.message, 'danger');
  } finally {
    state.sync.busy = false;
    render();
  }
  if (pushAfter) {
    await syncPush({ silent: true });
    state.sync.remoteCount = state.transactions.length;
    bindDrainButton.sync?.();
    if (state.route === 'settings') render();
  }
}

/**
 * تبديل رمز الدخول دون مسح شيء.
 * الرمز مفتاحُ التشفير نفسه، فمن انكشف رمزه انكشف بابُ بياناته — ولم يكن
 * لتبديله سبيلٌ إلا «تسجيل الخروج» الذي يمحو النسخة المحلية. والترتيب هنا
 * مقصود: يُرفع تحت الجديد أولًا، فإن فشل الرفع عاد الرمز القديم كما كان
 * ولم تُمسّ الخزانة القديمة — فلا يبقى المستخدم بلا نسخةٍ على الخادم.
 */
async function rotateSecret() {
  if (!state.sync.secret) return;
  if (!confirm('تبديل رمز الدخول؟ يُنشأ رمزٌ جديد وتُرفع بياناتك تحته، ثم تُمحى النسخة القديمة من الخادم. وستحتاج إلى إدخال الرمز الجديد في أجهزتك الأخرى.')) return;
  const old = state.sync.secret;
  await setSyncSecret(Sync.newSecret());
  await syncPush({ silent: true });
  if (state.sync.status) {
    await setSyncSecret(old);
    toast(`لم يُبدَّل الرمز: ${state.sync.status}`, 'danger');
    render();
    return;
  }
  try { await Sync.remove(old); } catch { /* تبقى الخزانة القديمة، ولا يفتحها إلا من يملك رمزها */ }
  toast('بُدّل الرمز — أدخله الآن في أجهزتك الأخرى', 'ok');
  render();
}

async function setSyncSecret(secret) {
  // يُحفظ في صورته النقية المقروءة، فلا يبقى في التخزين نصٌّ لُصق معه
  state.sync.secret = secret ? Sync.format(secret) : null;
  await db.set('syncSecret', state.sync.secret);
  state.sync.fp = state.sync.secret ? await Sync.fingerprint(state.sync.secret) : '';
  state.inbox.boxId = state.sync.secret ? await Inbox.boxIdFor(state.sync.secret) : null;
}

function routeFromHash() {
  const h = (location.hash || '').replace('#', '');
  return ROUTES[h] ? h : 'dashboard';
}

async function reload() {
  state.transactions = await db.allTx();
  applyClassification(state.transactions, state.rules, state.settings?.ownAccounts);
  state.analysis = state.transactions.length ? analyze(state.transactions, state.settings) : null;
  state.accountsSummary = buildAccountsSummary(state.transactions);
  state.reminders = computeReminders(state.analysis);
  // الدورة المعروضة قد تكون سابقةً يتصفّحها المستخدم، والحسابُ واحد
  const startDay = Number(state.settings?.budget?.cycleStartDay) || 1;
  const opts = { today: todayISO(), limit: +state.settings?.budget?.monthlyLimit || null, startDay };
  state.month = state.analysis ? cycleSnapshot(state.analysis, opts) : null;
  state.viewCycle = state.analysis && state.cycleKey
    ? cycleSnapshot(state.analysis, { ...opts, key: state.cycleKey })
    : state.month;
  state.forecast = state.analysis ? forecastNext(state.analysis, { ...opts, planned: state.settings?.budget?.planned || [] }) : null;
  publishWidget();
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

/**
 * زرٌّ واحد في الترويسة يُتمّ الدورة كلها: يسحب نسختك من الخادم، ويلتقط
 * رسائل مصرفك، ويرفع ما تغيّر.
 *
 * وكان كلٌّ من هذه في موضع: المزامنة في قاع الإعدادات خلف بطاقةٍ مطويّة،
 * والرسائل في بطاقةٍ أخرى. وفعلٌ يُكرَّر في اليوم مرات لا يُدفن خلف نقرتين
 * وبحثٍ عن قسم — ولا يُفرَّق على زرّين وهو في ذهن صاحبه فعلٌ واحد: «حدّثني».
 *
 * وعليه علامةٌ حين ينتظر شيء: رسائل في الصندوق تصير عمليات، أو عدد الخادم
 * يخالف عدد الجهاز. ولا تُحتسب فيها رموزُ التحقّق ولا ما لم يُفهم — علامةٌ
 * لا تزول بالضغط أسوأ من لا علامة.
 */
function bindDrainButton() {
  const el = document.getElementById('drain');
  if (!el) return;
  const paint = () => {
    el.hidden = !state.sync.secret;             // بلا رمزٍ لا صندوق ولا مزامنة
    const waiting = state.inbox.waiting || 0;
    const drifted = state.sync.remoteCount != null && state.sync.remoteCount !== state.transactions.length;
    const n = waiting || (drifted ? 1 : 0);
    el.classList.toggle('has-badge', n > 0);
    el.dataset.badge = waiting > 9 ? '٩+' : waiting > 0 ? String(waiting) : '!';
    el.classList.toggle('sync-err', !!state.sync.status);
  };
  bindDrainButton.sync = paint;
  paint();
  el.addEventListener('click', async () => {
    if (el.classList.contains('busy')) return;
    el.classList.add('busy');
    // الترتيب مقصود: نسحب أوّلًا لئلّا ندهس ما رفعه جهازٌ آخر، ثم نلتقط
    // الرسائل، ثم يُرفع ما استجدّ — و`syncPull` يرفع بنفسه متى لزم.
    await refresh({ silent: false });
    el.classList.remove('busy');
    paint();
  });
}

/**
 * رقم النسخة زرُّ تحديث.
 * أكثرُ ما أربك استعمال هذا التطبيق شيفرةٌ قديمة على الجهاز: يُصلَح العطب
 * وتبقى الصفحة على وحدات الأمس، فيُرى العطب مُصلَحًا وهو ظاهر. فالرقم
 * ظاهرٌ ليُعرف، وزرٌّ ليُصلَح — ولا يُكتفى بفحص العامل: يُحمَّل على كل حال،
 * فالشيفرة تُطلب من الشبكة أولًا، والتحميل يضمن أحدثها بلا انتظار.
 */
function bindVersionChip() {
  const el = document.getElementById('ver');
  if (!el) return;
  el.textContent = `${APP_VERSION} ⟳`;
  el.addEventListener('click', async () => {
    el.classList.add('checking');
    el.textContent = 'جارٍ التحديث…';
    try { await (await navigator.serviceWorker?.getRegistration?.())?.update(); } catch { /* الشبكة قد تنقطع */ }
    location.reload();
  });
}

/**
 * يُعلِم الشاشة الحالية في الشريط، ويُمرّره إليها إن كانت خارجه.
 * على الجوال شريط التنقّل أضيق من عناصره (٥٨٦ بكسل في ٣٧٥)، فكانت الشاشة
 * المفتوحة تقع خارج المرأى — قيست «الإعدادات» عند س = −١٩٦ — فلا يعرف
 * المستخدم أين هو. والتمرير يؤجَّل إلى ما بعد الرسم: نداؤه أثناءه يسبق
 * اتّساع الشريط بالخطوط والأيقونات، فلا يجد ما يُمرّره.
 */
function markActiveNav() {
  document.querySelectorAll('.head-actions a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === state.route);
  });
  const links = document.querySelectorAll('#nav a');
  let current = null;
  links.forEach((a) => {
    // الشاشات التحليلية الثلاث تُضيء «التحليل» لأنها صارت أقسامًا فيه
    const on = a.dataset.route === state.route
      || (a.dataset.route === 'analysis' && ANALYSIS_TABS.some((t) => t.id === state.route));
    a.classList.toggle('active', on);
    a.setAttribute('aria-current', on ? 'page' : 'false');
    if (on) current = a;
  });
  if (!current) return;
  const bring = () => {
    const nav = current.parentElement;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;   // لا حاجة على الشاشات الواسعة
    // لا scrollIntoView: يخطئ مع أوّل عنصرٍ في حاوية RTL فيدفعه خارج الشاشة
    // (قيس عند س = ٥٠٤). ولا scrollBy: نداؤه مرتين يجمع الإزاحتين فيتجاوز.
    // نحسب هدفًا مطلقًا؛ وهو ثابتٌ أثناء التمرير نفسه لأن ما يزيد في
    // scrollLeft ينقص مثله من موضع العنصر، فتكرار النداء يستقرّ ولا يتراكم.
    const navBox = nav.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    const delta = (box.left + box.width / 2) - (navBox.left + navBox.width / 2);
    if (Math.abs(delta) < 1) return;
    // فوريٌّ لا ناعم: التمرير الناعم تُحرّكه إطاراتُ الرسم، والمتصفح يجمّدها
    // والتبويب مخفيّ — جُرّب فبقي scrollLeft صفرًا رغم صحّة الهدف. وهذه
    // مزامنة موضعٍ لا حركة يقصدها المستخدم، فالفورية أصحّ وأمتن.
    nav.scrollTo({ left: nav.scrollLeft + delta, behavior: 'instant' });
  };
  bring();
  // شبكة أمان: عند أول رسم قد لا يكون الشريط اتّسع بخطوطه وأيقوناته بعد.
  // ولا نعتمد requestAnimationFrame: المتصفح يجمّده والتبويب مخفيّ — وقد
  // يُفتح التطبيق من تنبيهٍ وهو كذلك — فيبقى الشريط على شاشةٍ غير الحالية.
  setTimeout(bring, 0);
}

// ── العرض ─────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  markActiveNav();
  const a = state.analysis;
  // بلا رمز دخول ولا اختيارٍ صريح للعمل محليًا: البوابة أولًا
  if (!state.sync.secret && !state.skipSync) {
    app.innerHTML = V.viewGate(state);
    document.getElementById('banner').innerHTML = '';
    document.getElementById('gate-code')?.focus();
    return;
  }
  // «التحليل» ليس شاشةً بذاته بل غلافٌ لأقسامه الثلاثة، وقسمُه المفتوح هو
  // المسار نفسه — فتبقى الروابط القديمة (#categories…) عاملةً كما كانت.
  const inAnalysis = state.route === 'analysis' || ANALYSIS_TABS.some((t) => t.id === state.route);
  const section = state.route === 'analysis' ? ANALYSIS_TABS[0].id : state.route;

  let html = '';
  switch (section) {
    case 'import': html = V.viewImport(state); break;
    case 'categories': html = V.viewCategories(a, state); break;
    case 'commitments': html = V.viewCommitments(a); break;
    case 'beneficiaries': html = V.viewBeneficiaries(a); break;
    case 'financing': html = V.viewFinancing(a, state); break;
    case 'transactions': html = V.viewTransactions(a, state); break;
    case 'settings': html = V.viewSettings(state, a); break;
    default: html = V.viewDashboard(a, state);
  }
  state.widgetUrl = state.settings?.widget?.token ? Sync.widgetUrl(state.settings.widget.token) : '';
  const head = inAnalysis ? ROUTES.analysis : ROUTES[state.route];
  const tabs = inAnalysis ? V.segmented(ANALYSIS_TABS, section) : '';
  app.innerHTML = `<h1 class="page-title">${head.icon} ${head.ar}</h1>${tabs}${html}`;
  restoreFolds(app);
  app.scrollTop = 0;
  updateBanner();
}

/**
 * يُعيد فتح ما كان مفتوحًا من البطاقات المطويّة.
 * الرسم يعيد بناء الشجرة، فتُغلق البطاقات كلها ويفقد المستخدم موضعه: يضغط
 * زرًّا داخل بطاقةٍ فتنطوي أمامه ومعها نتيجةُ ما ضغط.
 */
const openFolds = new Set();
function restoreFolds(root) {
  root.querySelectorAll('details.fold').forEach((d) => {
    const key = d.dataset.fold;
    if (!key) return;
    if (d.open) openFolds.add(key);            // ما فُتح بالبناء يُسجَّل
    else if (openFolds.has(key)) d.open = true;
    d.addEventListener('toggle', () => {
      if (d.open) openFolds.add(key); else openFolds.delete(key);
    });
  });
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
    if (action === 'widget-on') {
      if (!confirm('تفعيل أداة الشاشة؟\n\nيُرفع ملخّصٌ مجمَّع — ما صُرف والحدّ والمتبقي والتوفير وأكبر ثلاثة مجالات وآخر عملية — بلا تشفير، خلف رمزٍ عشوائي لا يُخمَّن.\n\nولا يُرفع شيء من قائمة عملياتك ولا أرصدتك ولا أرقام حساباتك. وتستطيع إبطاله في أي وقت.')) return;
      const token = Sync.newWidgetToken();
      state.settings = await saveSettings({ widget: { token, enabled: true } });
      publishWidget();
      toast('فُعّلت الأداة — انسخ الرابط إلى Scriptable', 'ok');
      render();
      return;
    }
    if (action === 'widget-off') {
      const token = state.settings?.widget?.token;
      if (!confirm('إبطال أداة الشاشة؟ يُمحى الملخّص من الخادم ويبطل رمزه.')) return;
      try { if (token) await Sync.revokeWidget(token); } catch { /* الرمز يبطل عندنا على كل حال */ }
      state.settings = await saveSettings({ widget: { token: '', enabled: false } });
      state.widgetAt = null;
      toast('أُبطلت الأداة ومُحي ملخّصها', 'warn');
      render();
      return;
    }
    if (action === 'widget-copy-url') {
      await navigator.clipboard.writeText(Sync.widgetUrl(state.settings?.widget?.token || ''));
      toast('نُسخ الرابط', 'ok');
      return;
    }
    if (action === 'widget-copy-script') {
      await navigator.clipboard.writeText(V.scriptableSource(Sync.widgetUrl(state.settings?.widget?.token || '')));
      toast('نُسخ السكربت — الصقه في Scriptable', 'ok');
      return;
    }
    if (action === 'cycle-prev' || action === 'cycle-next') {
      const cur = state.viewCycle?.key || state.month?.key;
      if (!cur) return;
      const next = shiftCycle(cur, action === 'cycle-prev' ? -1 : 1);
      // لا تُتجاوَز الدورة الجارية: ما بعدها لم يقع بعد
      state.cycleKey = next > (state.month?.key || next) ? null : next;
      await reload();
      render();
      return;
    }
    if (action === 'plan-add') {
      const label = (document.getElementById('plan-label')?.value || '').trim().slice(0, 40);
      const amount = Number(document.getElementById('plan-amount')?.value) || 0;
      if (!amount) { toast('أدخل مبلغ البند', 'warn'); return; }
      const planned = [...(state.settings.budget?.planned || []), { id: uid(), label: label || 'بند', amount, cycle: state.forecast?.key }];
      state.settings = await saveSettings({ budget: { planned } });
      await reload();
      toast('أُضيف إلى توقّع الدورة القادمة', 'ok');
      schedulePush();
      render();
      return;
    }
    if (action === 'plan-del') {
      const planned = (state.settings.budget?.planned || []).filter((p) => p.id !== el.dataset.id);
      state.settings = await saveSettings({ budget: { planned } });
      await reload();
      schedulePush();
      render();
      return;
    }
    if (action === 'tag-open') { state.tagging = el.dataset.id; render(); return; }
    if (action === 'tag-cancel') { state.tagging = null; render(); return; }
    if (action === 'tag-save') { await saveTag(el.dataset.id); return; }
    if (action === 'paste-open') { state.paste = state.paste || { text: '', result: null }; render(); return; }
    if (action === 'paste-clear') { state.paste = { text: '', result: null }; render(); return; }
    if (action === 'paste-parse') {
      const text = document.getElementById('paste-text')?.value || '';
      const { added, failed } = Inbox.parsePasted(text, { today: todayISO() });
      // المكرر يُكشف بالبصمة قبل العرض، فلا يُعتمد ما هو موجود أصلًا
      const { fresh, dups } = dedupe(added, await db.existingHashes());
      state.paste = { text, result: { added, failed, fresh, dups } };
      render();
      return;
    }
    if (action === 'paste-commit') {
      const fresh = state.paste?.result?.fresh || [];
      if (!fresh.length) return;
      await db.putMany(fresh);
      await forgetDeleted(fresh.map((t) => t.hash));
      state.inbox.log = Inbox.recordDrain(state.inbox.log, todayISO(), fresh.length);
      await db.set('inboxLog', state.inbox.log);
      state.paste = { text: '', result: null };
      await reload();
      const merged = await reconcilePending();
      if (merged) toast(`طُوبقت ${merged} عملية بنظيرتها في الكشف`, 'ok');
      toast(`أُضيفت ${fresh.length} عملية`, 'ok');
      schedulePush();
      render();
      return;
    }
    if (action === 'copy-failed') {
      // بنصّها كاملًا وبمرسِلها: هذان ما يلزمان لإضافة شكلٍ إلى المحلّل
      const txt = (state.inbox.failed || [])
        .map((m, n) => `── ${n + 1} ── [${m.sender || 'بلا مرسِل'}] ${m.reason || ''}\n${m.text || ''}`)
        .join('\n\n');
      await navigator.clipboard.writeText(txt);
      toast(`نُسخت ${state.inbox.failed.length} رسالة`, 'ok');
      return;
    }
    if (action === 'go-tx') { location.hash = 'transactions'; return; }
    if (action === 'go-settings') { location.hash = 'settings'; return; }
    if (action === 'go-analysis') { location.hash = 'categories'; return; }
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
    if (action === 'toggle-own') { await toggleOwn(el.dataset.kind, el.dataset.key); return; }
    if (action === 'gate-new') {
      await setSyncSecret(Sync.newSecret());
      await syncPush();
      await db.set('skipSync', false);
      state.skipSync = false;
      render();
      return;
    }
    if (action === 'gate-skip') {
      state.skipSync = true;
      await db.set('skipSync', true);
      render();
      return;
    }
    if (action === 'sign-out') {
      if (!confirm('تسجيل الخروج من هذا الجهاز؟ ستُمحى النسخة المحلية، وتبقى نسختك المشفّرة على الخادم وتعود بإدخال الرمز.')) return;
      await setSyncSecret(null);
      await db.clearTx();
      await saveRules([]);
      state.rules = [];
      await db.set('skipSync', false);
      state.skipSync = false;
      await reload();
      toast('سُجّل الخروج', 'warn');
      render();
      return;
    }
    if (action === 'inbox-drain') { await drainInbox(); return; }
    if (action === 'inbox-clear') {
      if (!confirm('مسح كل ما في صندوق الرسائل على الخادم؟')) return;
      try { await Inbox.clearInbox(state.sync.secret); state.inbox.failed = []; toast('مُسح الصندوق', 'ok'); }
      catch (err) { toast(err.message, 'danger'); }
      render();
      return;
    }
    if (action === 'inbox-copy-url') {
      await navigator.clipboard.writeText(`${location.origin}/api/ingest?box=${state.inbox.boxId}`);
      toast('نُسخ رابط الإيداع — ضعه في الاختصار', 'ok');
      return;
    }
    if (action === 'reconcile') {
      const n = await reconcilePending();
      toast(n ? `طُوبقت ${n} عملية` : 'لا يوجد ما يُطابَق', n ? 'ok' : '');
      return;
    }
    if (action === 'notify-toggle') { await toggleNotifications(); return; }
    if (action === 'sync-enable') { await setSyncSecret(Sync.newSecret()); await syncPush(); render(); return; }
    if (action === 'sync-link') {
      const k = prompt('ألصق مفتاح المزامنة من جهازك الآخر:');
      if (!k) return;
      await setSyncSecret(k.trim());
      await syncPull();
      return;
    }
    if (action === 'sync-push') { await syncPush(); return; }
    if (action === 'sync-pull') { await syncPull(); return; }
    if (action === 'sync-copy') {
      await navigator.clipboard.writeText(state.sync.secret || '');
      toast('نُسخ المفتاح — احفظه في مكان آمن', 'ok');
      return;
    }
    if (action === 'sync-off') {
      if (!confirm('إيقاف المزامنة على هذا الجهاز؟ البيانات المحلية تبقى كما هي.')) return;
      await setSyncSecret(null);
      toast('أُوقفت المزامنة', 'warn');
      render();
      return;
    }
    if (action === 'tx-more') {
      state.txLimit = (state.txLimit || V.TX_PAGE) + V.TX_PAGE;
      render();
      // الإبقاء على موضع القراءة: الدفعة الجديدة تُضاف أسفل ما كان يقرؤه
      el.scrollIntoView?.({ block: 'center' });
      return;
    }
    if (action === 'sync-rotate') { await rotateSecret(); return; }
    if (action === 'export-json') { downloadJSON(); return; }
    if (action === 'export-csv') { downloadCSV(); return; }
    if (action === 'import-json') { pickJSON(); return; }
    if (action === 'wipe') { await wipe(); return; }
  });

  app.addEventListener('submit', async (e) => {
    if (e.target.dataset.action !== 'gate-login') return;
    e.preventDefault();
    const code = document.getElementById('gate-code')?.value?.trim();
    // الرمز ٣٢ محرفًا بالضبط. ومن لصق معه نصًّا من الصفحة تُنقّيه الطبقة
    // الأدنى؛ وإنما يُردّ هنا الناقصُ والمكسور، بنصٍّ يقول ما الخلل تحديدًا.
    if (!Sync.looksLikeSecret(code)) {
      const n = String(code || '').replace(/[^A-Za-z0-9]/g, '').length;
      state.sync.status = n
        ? `الرمز غير مكتمل — ٣٢ محرفًا، وقرأنا ${n}. انسخه كاملًا من شاشة الإعدادات في جهازك الآخر.`
        : 'أدخل رمز الدخول أولًا';
      render();
      return;
    }
    await setSyncSecret(code);
    await db.set('skipSync', false);
    state.skipSync = false;
    await refresh();
    if (state.sync.status) { await setSyncSecret(null); render(); return; }
    if (state.sync.foundRemote === false && state.transactions.length === 0) {
      toast(`دخلتَ، ولا نسخة على الخادم لهذا الرمز. بصمته ${state.sync.fp} — قارِنها ببصمة جهازك الآخر في الإعدادات: إن اختلفتا فالرمزان مختلفان، وإن تطابقتا فاضغط «حدّث الآن» هناك.`, 'warn');
    } else {
      toast(`أهلًا بك — ${state.transactions.length} عملية`, 'ok');
    }
    render();
  });

  app.addEventListener('change', async (e) => {
    const id = e.target.id;
    if (e.target.classList.contains('cat-select')) { await setCategory(e.target.dataset.id, e.target.value); return; }
    if (id === 'file-input') { await handleFiles(e.target.files); return; }
    if (id === 'acc-name') { state.importAccount = e.target.value; return; }

    // التوجيه بالعضوية الصريحة لا بالبادئة: راجع src/form-ids.js
    const form = formOf(id);
    if (form === 'finance') { updateFinance(); return; }
    if (form === 'filter') { updateFilter(); return; }
    if (form === 'settings') { await updateSettings(); return; }
  });

  app.addEventListener('input', (e) => {
    const form = formOf(e.target.id);
    if (e.target.id === 'q') { clearTimeout(bindEvents._q); bindEvents._q = setTimeout(updateFilter, 250); }
    if (form === 'finance') { clearTimeout(bindEvents._f); bindEvents._f = setTimeout(updateFinance, 300); }
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

  // المعاينة تُظهر ما ستراه بعد الاعتماد تمامًا: قواعدك ووسمُ حساباتك مطبَّقة
  applyClassification(collected, state.rules, state.settings?.ownAccounts);
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
  // الاستيراد قصدٌ صريح يرفع أي شاهد حذفٍ سابق على هذه العمليات
  await forgetDeleted(state.pending.fresh.map((t) => t.hash));
  state.pending = null;
  await reload();
  const merged = await reconcilePending();
  if (merged) toast(`طُوبقت ${merged} عملية معلَّقة بنظيرتها في الكشف`, 'ok');
  toast(`أُضيفت ${n} عملية`, 'ok');
  schedulePush();
  location.hash = 'dashboard';
  render();
}

async function dropAccount(account) {
  if (!confirm(`حذف كل عمليات «${account}»؟`)) return;
  const rows = state.transactions.filter((t) => t.account === account);
  for (const r of rows) await db.remove(r.id);
  // بلا شاهدٍ على الحذف يُعيدها الجهاز الآخر في أول مزامنة
  await rememberDeleted(rows.map((r) => r.hash));
  await reload();
  toast(`حُذفت ${rows.length} عملية`, 'ok');
  render();
}

// ── التصنيف والاستبعاد ────────────────────────────────────────────────────
/**
 * يحفظ تصنيف المحل: مجالًا وصنفًا فرعيًّا، ويُنشئ به قاعدةً تلتقط كل شراءٍ
 * من المحلّ نفسه — الماضي والقادم. فالوسم مرةً واحدة لا في كل عملية.
 *
 * والصنف الفرعي الجديد يُحفظ في الإعدادات ليُقترح في المرات التالية، فلا
 * يُكتب الاسم الواحد بوجوهٍ شتّى («عصائر» و«عصير» و«محل عصير») فتتفرّق
 * أرقامُ بابٍ واحد.
 */
async function saveTag(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  const category = document.getElementById('tag-cat')?.value || t.category || 'other';
  const subcategory = (document.getElementById('tag-sub')?.value || '').trim().slice(0, 40);

  if (subcategory) {
    const known = subcategoriesFor(category, state.settings?.subcategories || {});
    if (!known.includes(subcategory)) {
      const map = { ...(state.settings.subcategories || {}) };
      map[category] = [...(map[category] || []), subcategory];
      state.settings = await saveSettings({ subcategories: map });
    }
  }

  // «غير محسوب» قرارُ المستخدم، وسببه `user` — وهو وحده ما لا يدهسه
  // محرّك الاستبعاد في كل إعادة حساب، فيثبت قراره على ما قرّر.
  const excluded = !!document.getElementById('tag-exclude')?.checked;
  t.userExcluded = excluded;
  t.excluded = excluded;
  t.excludeReason = excluded ? 'user' : null;

  t.category = category;
  t.subcategory = subcategory;
  t.categorySource = 'user';
  await db.put(stripRuntime(t));

  // القاعدة تحمل الاثنين، فيرثهما كل شراءٍ من المحلّ نفسه
  const s = suggestRule(t, category, subcategory);
  const at = state.rules.findIndex((r) => r.field === s.field && String(r.value) === String(s.value));
  if (at >= 0) state.rules[at] = { ...state.rules[at], ...s };
  else state.rules.push({ id: uid(), priority: 10, ...s });
  await saveRules(state.rules);

  state.tagging = null;
  await reload();
  const affected = state.transactions.filter((x) => x.ruleId === (state.rules[at >= 0 ? at : state.rules.length - 1]?.id)).length;
  toast(`${CATEGORY_MAP[category]?.ar}${subcategory ? ` · ${subcategory}` : ''}${affected > 1 ? ` — طُبّق على ${affected} عملية` : ''}`, 'ok');
  schedulePush();
  render();
}

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
  schedulePush();
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

/** يسم مستفيدًا بأنه حساب المستخدم (أو يرجع عن ذلك)، فيسري على كل عملياته. */
async function toggleOwn(kind, key) {
  const own = { ibans: [], merchants: [], ...(state.settings.ownAccounts || {}) };
  const field = kind === 'iban' ? 'ibans' : 'merchants';
  const set = new Set(own[field]);
  const adding = !set.has(key);
  if (adding) set.add(key); else set.delete(key);
  own[field] = [...set];
  state.settings = await saveSettings({ ownAccounts: own });
  await reload();
  const hit = state.transactions.filter((t) => (kind === 'iban' ? t.beneficiaryIban === key : t.merchantKey === key));
  const total = hit.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);
  toast(adding
    ? `استُبعدت ${hit.length} عملية بمجموع ${money(total)} — نقلُ مال لا صرف`
    : `أُعيدت ${hit.length} عملية إلى حساب الصرف`, adding ? 'ok' : 'warn');
  schedulePush();
  render();
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
  // كل تغيير مرشِّح يبدأ قائمةً جديدة، فلا يُورَّث سقفُ القائمة السابقة
  state.txLimit = V.TX_PAGE;
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
    budget: {
      monthlyLimit: blankOr('b-limit'),
      cycleStartDay: Math.min(28, Math.max(1, numOr('b-start', 1))),
      planned: state.settings?.budget?.planned || [],
    },
    analysis: {
      excludeInternal: !!g('a-internal')?.checked,
      excludeReversals: !!g('a-rev')?.checked,
      excludeExtraordinary: !!g('a-extra')?.checked,
      ignoreLastPartialMonth: !!g('a-partial')?.checked,
      extraordinaryFactor: numOr('a-factor', 4),
      ownTransfersSpendUntil: (g('a-own-until')?.value || '').trim(),
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
  schedulePush();
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
const today = () => todayISO();

boot().catch((e) => {
  document.getElementById('app').innerHTML = `<div class="empty"><p>تعذّر بدء التطبيق: ${e.message}</p></div>`;
  console.error(e);
});
