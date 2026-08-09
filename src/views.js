// واجهات العرض — كل دالة تُعيد HTML، والتفاعل يمرّ عبر data-action.

import { money, num, pct, monthLabel, dateLabel, escapeHTML, APP_VERSION, todayISO } from './util.js';
import { donut, hbars, monthlyChart, stackedBar, gauge, sparkline } from './charts.js';
import { CATEGORIES, CATEGORY_MAP, TYPES, subcategoriesFor } from './classify.js';
import { VERDICT, VERDICT_AR, installmentOf, effectiveAPR } from './affordability.js';
import { lastDays } from './inbox.js';

const GROUP_COLORS = { 'ملتزم': '#6366f1', 'شبه ثابت': '#f59e0b', 'مرن': '#e11d48', 'غامض': '#94a3b8', 'ادخار': '#0d9488' };

// ── مكوّنات صغيرة ─────────────────────────────────────────────────────────
function kpi(label, value, { sub = '', tone = '', hint = '' } = {}) {
  return `<div class="kpi ${tone}" ${hint ? `title="${escapeHTML(hint)}"` : ''}>
    <div class="kpi-label">${escapeHTML(label)}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function card(title, body, { actions = '', cls = '' } = {}) {
  // عنوانٌ فارغ = لا ترويسة: تكرار عنوان الشاشة داخل بطاقتها الوحيدة يأكل
  // من الشاشة الصغيرة بلا فائدة
  return `<section class="card ${cls}">
    ${title ? `<header class="card-head"><h2>${escapeHTML(title)}</h2>${actions}</header>` : ''}
    <div class="card-body">${body}</div>
  </section>`;
}

/**
 * بطاقة تُفتح بالطلب. لشاشةٍ أقسامُها ثمانية — قيست الإعدادات ٦٫٥ شاشة تمرير
 * على الجوال — الطيّ يجعل الأقسام كلها في مرأى واحد، فيُختار المقصود بنقرة
 * بدل البحث عنه بالتمرير. و`<details>` أصلٌ في المتصفح: يعمل بلا شيفرة،
 * ويبقى قابلًا للبحث بـCtrl+F، وتفتحه قارئات الشاشة.
 */
function foldable(title, body, { open = false, hint = '' } = {}) {
  // مفتاحٌ ثابت من العنوان: الرسم يعيد بناء الشجرة فتُغلق البطاقات كلها،
  // فيفقد المستخدم موضعه كلما تغيّر شيء — يضغط «حلّلها» فينطوي القسم أمامه.
  return `<details class="card fold" data-fold="${escapeHTML(title)}" ${open ? 'open' : ''}>
    <summary class="card-head"><h2>${escapeHTML(title)}</h2>${hint ? `<span class="hint">${escapeHTML(hint)}</span>` : ''}</summary>
    <div class="card-body">${body}</div>
  </details>`;
}

function empty(msg, action = '') {
  return `<div class="empty"><p>${escapeHTML(msg)}</p>${action}</div>`;
}

// ── ٠) بوابة الدخول ───────────────────────────────────────────────────────
// رمزٌ واحد هو الدخول والمفتاح معًا: يفتح بياناتك على أي جهاز، وتحته يجري
// اشتقاق مفتاح التشفير ومعرّف التخزين — ولا يعرف المستخدم من ذلك شيئًا.

export function viewGate(state) {
  const hasLocal = state.transactions.length > 0;
  return `<div class="gate">
    <div class="gate-card">
      <div class="gate-mark">﷼</div>
      <h2>${hasLocal ? 'زامِن بياناتك مع أجهزتك' : 'ادخل إلى ميزانيتك'}</h2>
      <p class="muted">${hasLocal
        ? `لديك ${num(state.transactions.length)} عملية على هذا الجهاز. أنشئ رمزًا لترفعها مشفَّرة وتفتحها من جوالك.`
        : 'أدخل رمزك إن كان لديك واحد، أو أنشئ رمزًا جديدًا. الرمز نفسه هو مفتاح التشفير — لا نملكه ولا نستطيع قراءة بياناتك.'}</p>

      <form class="gate-form" data-action="gate-login">
        <input id="gate-code" type="text" inputmode="latin" autocomplete="one-time-code"
          placeholder="XXXX-XXXX-XXXX-…" value="" spellcheck="false">
        <button class="btn primary" type="submit" ${state.sync?.busy ? 'disabled' : ''}>
          ${state.sync?.busy ? 'جارٍ…' : 'دخول'}</button>
      </form>
      ${state.sync?.status ? `<p class="gate-error">${escapeHTML(state.sync.status)}</p>` : ''}

      <div class="gate-alt">
        <button class="btn" data-action="gate-new">${hasLocal ? 'أنشئ رمزًا وارفع بياناتي' : 'أنشئ رمزًا جديدًا'}</button>
        <button class="btn ghost" data-action="gate-skip">تابع على هذا الجهاز فقط</button>
      </div>
      <p class="hint">🔒 التشفير يجري في متصفحك. الخادم يخزّن نصًّا مشفَّرًا لا يفهمه، ولا يمكن استرجاع بياناتك إن فقدت الرمز.</p>
    </div>
  </div>`;
}

// ── ١) الاستيراد ──────────────────────────────────────────────────────────
export function viewImport(state) {
  const p = state.pending;
  return `
  <div class="grid">
    ${card('استيراد كشف حساب', `
      <div class="dropzone" id="dropzone" data-action="pick-file">
        <div class="dz-icon">📄</div>
        <p><strong>أفلت ملف الكشف هنا</strong> أو اضغط للاختيار</p>
        <p class="muted">Excel (‎.xlsx/.xls‎) أو CSV أو PDF — تُقرأ داخل متصفحك ولا تُرفع لأي خادم.</p>
        <input type="file" id="file-input" accept=".xlsx,.xls,.csv,.pdf" multiple hidden>
      </div>
      <div class="row gap">
        <label class="field"><span>اسم الحساب</span>
          <input id="acc-name" type="text" placeholder="مثال: الحساب الرئيسي" value="${escapeHTML(state.importAccount || '')}">
        </label>
        <label class="field"><span>كلمة مرور الـPDF (إن وُجدت)</span>
          <input id="pdf-pass" type="password" placeholder="تبقى في جهازك" autocomplete="off">
        </label>
      </div>
      <p class="hint">أفضل ملف: «النسخة القابلة للتحليل» من كشف بنك البلاد — فيها ورقة «التفاصيل الكاملة» التي تحمل اسم التاجر ومدينته، وبها يصير تصنيف المجالات آليًا.</p>
    `)}
    ${p ? importPreview(p) : ''}
    ${state.accountsSummary?.length ? card('الحسابات المحمّلة', `
      <table class="table">
        <thead><tr><th>الحساب</th><th>العمليات</th><th>من</th><th>إلى</th><th>آخر رصيد</th><th></th></tr></thead>
        <tbody>${state.accountsSummary.map((a) => `<tr>
          <td>${escapeHTML(a.account)}</td><td>${num(a.count)}</td>
          <td>${dateLabel(a.from)}</td><td>${dateLabel(a.to)}</td>
          <td class="ltr">${money(a.balance)}</td>
          <td><button class="btn tiny danger" data-action="drop-account" data-account="${escapeHTML(a.account)}">حذف</button></td>
        </tr>`).join('')}</tbody>
      </table>`) : ''}
  </div>`;
}

function importPreview(p) {
  const bc = p.balanceCheck || {};
  const ok = !bc.checked || bc.ok;
  return card(`معاينة: ${p.fileName}`, `
    <div class="row wrap gap">
      ${kpi('عمليات مقروءة', num(p.transactions.length))}
      ${kpi('جديدة', num(p.fresh.length), { tone: 'ok' })}
      ${kpi('مكررة (ستُتجاهل)', num(p.dups.length), { tone: p.dups.length ? 'warn' : '' })}
      ${kpi('صفوف متجاوَزة', num(p.skipped))}
      ${kpi('تدقيق الأرصدة', ok ? '✔ متسق' : `✖ ${num(bc.mismatches)} فرق`, {
        tone: ok ? 'ok' : 'danger',
        hint: 'يقارن فرق الرصيد بين كل عمليتين بمبلغ العملية — دليل حسابي على سلامة القراءة.',
      })}
    </div>
    ${p.warnings.length ? `<ul class="warnings">${p.warnings.map((w) => `<li>${escapeHTML(w)}</li>`).join('')}</ul>` : ''}
    <table class="table compact">
      <thead><tr><th>التاريخ</th><th>النوع</th><th>الوصف</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
      <tbody>${p.transactions.slice(0, 8).map((t) => `<tr>
        <td class="ltr">${dateLabel(t.date)}</td>
        <td>${escapeHTML(t.bankType || '')}</td>
        <td class="desc">${escapeHTML((t.desc || '').slice(0, 70))}</td>
        <td class="ltr ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td>
        <td class="ltr muted">${money(t.balance)}</td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="row gap end">
      <button class="btn" data-action="cancel-import">إلغاء</button>
      <button class="btn primary" data-action="confirm-import">اعتماد ${num(p.fresh.length)} عملية</button>
    </div>
  `, { cls: 'preview' });
}

/**
 * توقّع الدورة القادمة: المعتاد + ما تعرفه أنت.
 * المتوسط وحده يكذب على من يعرف أن أمامه رسومًا دراسية أو سفرًا — والتطبيق
 * لا يعلمه وأنت تعلمه. فالمعرفتان تُجمعان قبل أن تبدأ الدورة لا بعدها.
 */
function forecastCard(f) {
  if (!f) return '';
  const tight = f.over > 0;
  return `<details class="card fold" ${tight ? 'open' : ''}>
    <summary class="card-head"><h2>الدورة القادمة · ${escapeHTML(monthLabel(f.key))}</h2>
      <span class="hint ${tight ? 'danger-text' : 'pos'}">${tight ? `متوقَّع تجاوز ${money(f.over, { round: true })}` : `متّسع ${money(f.headroom, { round: true })}`}</span>
    </summary>
    <div class="card-body">
      <p class="hint">${escapeHTML(dateLabel(f.from))} — ${escapeHTML(dateLabel(f.to))}</p>
      <table class="table compact">
        <tbody>
          <tr><td>المعتاد (وسيط صرفك)</td><td class="ltr">${money(f.usual, { round: true })}</td></tr>
          <tr><td>بنودٌ تعرفها أنت</td><td class="ltr">${money(f.extra, { round: true })}</td></tr>
          <tr><td><strong>الاستهلاك المتوقَّع</strong></td><td class="ltr"><strong>${money(f.expected, { round: true })}</strong></td></tr>
          <tr><td>الحدّ</td><td class="ltr">${money(f.limit, { round: true })}</td></tr>
          <tr><td>ما يبقى لكل يوم بعد المخطَّط</td><td class="ltr"><strong>${money(f.dailyAllowance, { round: true })}</strong></td></tr>
        </tbody>
      </table>
      ${f.planned.length ? `<ul class="planned">${f.planned.map((p) => `<li>
        <span>${escapeHTML(p.label || 'بند')}</span>
        <span class="ltr">${money(p.amount, { round: true })}</span>
        <button class="btn tiny danger" data-action="plan-del" data-id="${escapeHTML(p.id)}">حذف</button>
      </li>`).join('')}</ul>` : '<p class="hint">لا بنود مخطَّطة بعد.</p>'}
      <div class="row wrap gap mt">
        <label class="field"><span>بند متوقَّع</span><input id="plan-label" placeholder="مثال: رسوم دراسية"></label>
        <label class="field"><span>مبلغه</span><input id="plan-amount" type="number" lang="en" step="any" placeholder="4000"></label>
        <button class="btn primary" data-action="plan-add">أضِفه</button>
      </div>
    </div>
  </details>`;
}

/**
 * تفصيل الربع: أين ذهب صرفُه، وعملياته.
 * الرقم يقول «تجاوزت»، والتفصيل يقول «بماذا» — وبه وحده يُصحَّح السلوك.
 */
function quarterDetail(w, state) {
  const rows = (state.analysis?.list || [])
    .filter((t) => !t.excluded && t.amount < 0 && t.date >= w.from && t.date <= w.to)
    .sort((a, b) => a.amount - b.amount);

  const byCat = new Map();
  for (const t of rows) byCat.set(t.category || 'other', (byCat.get(t.category || 'other') || 0) - t.amount);
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const total = rows.reduce((s, t) => s - t.amount, 0);

  return `<li class="q-detail">
    <div class="qd-top">
      <div>
        <div class="kpi-label">صُرف في الربع ${num(w.i)}</div>
        <div class="qd-amount ltr ${w.over ? 'neg' : ''}">${money(total, { round: true })}</div>
        <div class="kpi-sub">${num(rows.length)} عملية · من حدٍّ ${money(w.limit, { round: true })}</div>
      </div>
      <div class="qd-days">${escapeHTML(dateLabel(w.from))}<br>${escapeHTML(dateLabel(w.to))}</div>
    </div>

    ${top.length ? `<div class="qd-cats">${top.map(([id, amt]) => `<div class="qd-cat">
      <span>${escapeHTML(CATEGORY_MAP[id]?.ar || id)}</span>
      <b class="ltr">${money(amt, { round: true })}</b>
      <span class="muted">${pct(total ? amt / total : 0, 0)}</span>
    </div>`).join('')}</div>` : '<p class="hint">لا صرف في هذا الربع.</p>'}

    ${rows.length ? `<div class="qd-top5"><div class="kpi-label">أكبر عملياته</div>
      ${rows.slice(0, 4).map((t) => `<div class="qd-tx">
        <span class="qd-tx-name">${escapeHTML(t.merchant || t.merchantHint || (t.desc || '').slice(0, 28))}</span>
        <span class="ltr">${money(-t.amount, { round: true })}</span>
      </div>`).join('')}</div>` : ''}

    ${rows.length > 4 ? `<button class="btn tiny wide" data-action="quarter-all" data-from="${w.from}" data-to="${w.to}">
      كل عمليات الربع (${num(rows.length)}) ←</button>` : ''}
  </li>`;
}

/**
 * علامةٌ على الحال: التشجيع يُبقي المستخدم على العادة، والرقم وحده أصمّ.
 * ولا تُمنح إلا على ما انقضى أو على وتيرةٍ حقيقية — فمدحٌ في أول اليوم
 * على صرفٍ لم يقع بعدُ يفقد معناه سريعًا.
 */
/**
 * سلّمُ الوتيرة: خمس درجات، لكلٍّ رمزٌ ولونٌ وعبارة.
 *
 * سهمان أخضران لمن دبَّر، وسهمٌ لمن انضبط، ونقطةٌ صفراء لمن بلغ الحافّة،
 * وسهمٌ أحمر لمن تجاوز، وسهمان لمن بَعُد عن حدّه. وهو نفسه في أداة الشاشة،
 * فلا يرى صاحب النسخة حكمين مختلفين على حالٍ واحدة.
 *
 * والعبارة مشدودةٌ إلى الدرجة لا إلى المزاج: عبارةٌ مشجّعة فوق رقمٍ
 * متجاوزٍ تُفسد الأداة كلَّها، ويسقط معها الرقمُ الصادق الذي بجانبها.
 * وتُنتقى بيوم الدورة لا بالعشوائية، فلا ترتجف كلما أُعيد الرسم.
 */
const PACE_LADDER = [
  { max: 0.70, m: '▲▲', cls: 'good', s: ['تدبيرٌ ممتاز', 'إمساكٌ حسن', 'دون المعتاد بكثير'] },
  { max: 0.95, m: '▲', cls: 'good', s: ['على المسار', 'منضبطٌ حتى الآن', 'سِر على هذا'] },
  { max: 1.05, m: '●', cls: 'ok', s: ['على الحافّة', 'وتيرتُك تقارب حدَّك'] },
  { max: 1.30, m: '▼', cls: 'warn', s: ['فوق المعتاد، خفِّف', 'تجاوزتَ وتيرتك'] },
  { max: Infinity, m: '▼▼', cls: 'bad', s: ['أوقف غير الضروري', 'الصرف بعيدٌ عن حدّك'] },
];

export function paceGrade(pace, day = 0) {
  const r = Number.isFinite(pace) ? pace : 0;
  const g = PACE_LADDER.find((x) => r <= x.max) || PACE_LADDER[PACE_LADDER.length - 1];
  return { mark: g.m, cls: g.cls, say: g.s[Math.abs(Math.trunc(day)) % g.s.length] };
}

function mark(over, pace) {
  // تجاوزُ الحدّ لا يُغتفر بوتيرةٍ حسنة: يُحطّ إلى درجة التجاوز على الأقلّ
  const g = paceGrade(over ? Math.max(pace || 0, 1.06) : pace);
  return `<span class="mk ${g.cls}" title="${g.say}">${g.mark}</span>`;
}

/** شريطٌ صغير لأفقٍ واحد: اليوم أو الأسبوع. */
function miniBar(label, h, tone) {
  const fill = Math.min(100, Math.max(0, h.usedShare * 100));
  const over = h.remaining < 0;
  return `<div class="mini-bar">
    <div class="mb-head"><span>${mark(h.remaining < 0, h.pace)} ${escapeHTML(label)}</span>
      <span class="ltr ${over ? 'neg' : ''}">${money(h.spent, { round: true })} <span class="muted">من ${money(h.limit, { round: true })}</span></span></div>
    <div class="meter sm"><div class="meter-fill ${over ? 'over' : tone}" style="width:${fill}%"></div></div>
  </div>`;
}

/**
 * صدر اللوحة: الشهر الجاري وحده — كم صُرف، وكم بقي من الحدّ، وكم وُفِّر،
 * وأين ذهب أكثره. هذه أسئلة اليوم، وما دونها تاريخٌ يُراجَع عند الحاجة.
 *
 * والشريط يحمل علامتين لا واحدة: ما صُرف، وما كان يُفترض صرفُه حتى اليوم لو
 * وُزّع الحدّ على أيام الشهر. فمن رأى الشريط دون العلامة عرف أنه في سعة،
 * ومن رآه فوقها عرف أنه أسرع من حدّه ولو بقي في الحدّ رصيد.
 */
function monthCard(m, state) {
  if (!m) return '';
  const over = m.remaining < 0;
  const vg = paceGrade(m.pace, m.day);
  const tone = over ? 'danger' : m.pace > 1.05 ? 'warn' : 'ok';
  const fill = Math.min(100, Math.max(0, m.usedShare * 100));
  const markAt = Math.min(100, (m.day / m.daysInMonth) * 100);

  return `<section class="card month-card ${tone}">
    <div class="card-body">
      <div class="cycle-nav">
        <button class="btn tiny" data-action="cycle-prev" title="الدورة السابقة">‹</button>
        <span>${escapeHTML(monthLabel(m.key))} <span class="muted">${escapeHTML(dateLabel(m.from))} — ${escapeHTML(dateLabel(m.to))}</span></span>
        <button class="btn tiny" data-action="cycle-next" ${m.isCurrent ? 'disabled' : ''} title="الدورة التالية">›</button>
      </div>
      <div class="month-head">
        <div>
          <div class="kpi-label">${m.isCurrent ? 'صُرف هذه الدورة' : 'صُرف في دورة'} · ${escapeHTML(monthLabel(m.key))}</div>
          <div class="month-spent">${money(m.spent, { round: true })}</div>
        </div>
        <div class="month-remain">
          <div class="kpi-label">${over ? 'تجاوزتَ الحدّ بـ' : 'بقي من الحدّ'}</div>
          <div class="month-remain-value ${over ? 'neg' : 'pos'}">${money(Math.abs(m.remaining), { round: true })}</div>
          <div class="kpi-sub">من ${money(m.limit, { round: true })}${m.limitIsDerived ? ' (مُشتقّ)' : ''}</div>
        </div>
      </div>

      <div class="meter" role="img" aria-label="استُهلك ${pct(m.usedShare)} من حدّ الشهر في اليوم ${m.day} من ${m.daysInMonth}">
        <div class="meter-fill" style="width:${fill}%"></div>
        <div class="meter-mark" style="inset-inline-start:${markAt}%" title="ما كان يُفترض صرفُه حتى اليوم"></div>
      </div>
      <p class="hint">اليوم ${num(m.day)} من ${num(m.daysInMonth)} · استُهلك ${pct(m.usedShare)} من الحدّ
        · <strong class="mk ${vg.cls}">${vg.mark} ${vg.say}</strong>
        · بهذه الوتيرة تنهي الشهر عند <strong>${money(m.projected, { round: true })}</strong>${m.overBy > 0 ? ` — بتجاوزٍ قدره ${money(m.overBy, { round: true })}` : ''}</p>

      ${m.isCurrent && m.today && m.week ? `<div class="horizons">
        ${miniBar('اليوم', m.today, m.today.pace > 1.05 ? 'warn' : 'ok')}
        ${miniBar(`الربع ${num(m.week.index || 1)}`, m.week, m.week.pace > 1.05 ? 'warn' : 'ok')}
      </div>` : ''}

      ${m.weeks?.length ? `<h3>أرباع الدورة</h3>
      <ul class="weeks">${m.weeks.map((w) => `<li class="${w.isCurrent ? 'now' : w.isPast ? 'past' : 'future'} ${state?.openQuarter === w.i ? 'open' : ''}"
        data-action="quarter-open" data-q="${w.i}" role="button" tabindex="0" title="اضغط لترى عمليات هذا الربع">
        <span class="wk-no">${w.isCurrent ? '◆' : w.isPast ? mark(w.over, w.spent / w.limit) : '○'} الربع ${num(w.i)}</span>
        <span class="wk-days">${escapeHTML(dateLabel(w.from).slice(0, 5))} — ${escapeHTML(dateLabel(w.to).slice(0, 5))}</span>
        <span class="meter sm"><span class="meter-fill ${w.over ? 'over' : w.isPast || w.isCurrent ? 'ok' : 'idle'}"
          style="width:${Math.min(100, Math.max(0, w.usedShare * 100))}%"></span></span>
        <span class="wk-amount ltr ${w.over ? 'neg' : ''}">${money(w.spent, { round: true })}</span>
        <span class="wk-cap ltr muted">${money(w.limit, { round: true })}</span>
      </li>
      ${state?.openQuarter === w.i ? quarterDetail(w, state) : ''}`).join('')}</ul>` : ''}

      <div class="month-grid">
        <div class="mini">
          <div class="kpi-label">وُفِّر هذا الشهر</div>
          <div class="mini-value ${m.saved >= 0 ? 'pos' : 'neg'}">${money(m.saved, { round: true })}</div>
          <div class="kpi-sub">${m.savedShare == null ? 'لا دخل مسجَّل بعد' : `${pct(m.savedShare)} من دخل الشهر`}</div>
        </div>
        <div class="mini">
          <div class="kpi-label">دخل الشهر</div>
          <div class="mini-value">${money(m.income, { round: true })}</div>
        </div>
      </div>

      ${m.top.length ? `<h3>أين ذهب أكثره</h3>
        <ul class="top-cats">${m.top.map((c) => `<li>
          <span class="tc-name">${escapeHTML(c.ar)}</span>
          <span class="tc-bar"><i style="width:${Math.round(c.share * 100)}%"></i></span>
          <span class="tc-amount ltr">${money(c.amount, { round: true })}</span>
          <span class="tc-share">${pct(c.share, 0)}</span>
        </li>`).join('')}</ul>` : ''}

      <div class="row gap wrap mt">
        <button class="btn tiny" data-action="go-settings">اضبط الحدّ الشهري</button>
        <button class="btn tiny" data-action="go-analysis">كل المجالات</button>
      </div>
    </div>
  </section>`;
}

// ── ٢) لوحة القيادة ───────────────────────────────────────────────────────
export function viewDashboard(a, state) {
  if (!a) return empty('لا توجد بيانات بعد.', '<button class="btn primary" data-action="go-import">ابدأ بالاستيراد</button>');
  const surplus = a.income.median - a.spend.median;
  const trendUp = a.spend.trend > 0;

  const groups = ['ملتزم', 'شبه ثابت', 'مرن', 'غامض'].map((g) => ({
    label: g,
    color: GROUP_COLORS[g],
    value: a.categories.filter((c) => c.group === g).reduce((s, c) => s + c.monthlyAvg, 0),
  })).filter((x) => x.value > 0);

  const alerts = [];
  if (a.coverage.ambiguousShare > 0.20) {
    alerts.push(`<li class="warn"><strong>${pct(a.coverage.ambiguousShare)} من صرفك «غامض» (${money(a.coverage.ambiguousAmount)}):</strong> سحب نقدي وتحويلات لأشخاص وغير مصنّف.
      يُحتسب اليوم إنفاقًا مرنًا، فيقسو حكم الأريحية. <button class="btn tiny" data-action="go-tag">صنّفه</button> — إن كان ادخارًا أو التزامًا فسيتغيّر الحكم جوهريًا.</li>`);
  } else if (a.coverage.uncategorizedShare > 0.10) {
    alerts.push(`<li class="warn"><strong>${pct(a.coverage.uncategorizedShare)} من صرفك غير مصنّف (${money(a.coverage.uncategorizedAmount)}).</strong> <button class="btn tiny" data-action="go-tag">صنّفه الآن</button> لتدقّ نتيجة الملاءة.</li>`);
  }
  if (a.excluded.internal.length) alerts.push(`<li>استُبعد ${num(a.excluded.internal.length)} تحويلًا بين حساباتك — نقلُ مالٍ لا صرف.</li>`);
  if (a.excluded.reversal.length) alerts.push(`<li>استُبعدت ${num(a.excluded.reversal.length)} عملية مرتجعة (صادرة ثم مرتدّة بالمبلغ نفسه).</li>`);
  if (a.excluded.extraordinary.length) alerts.push(`<li>استُبعدت ${num(a.excluded.extraordinary.length)} دفعة استثنائية (صرف تمويل أو مبلغ ضخم لمرة واحدة). <button class="btn tiny" data-action="go-excluded">راجعها</button></li>`);
  if (a.coverage.solid < 3) alerts.push(`<li class="warn">عدد الأشهر المكتملة ${num(a.coverage.solid)} فقط — النتائج تقديرية حتى تتوفر ثلاثة أشهر فأكثر.</li>`);

  // آخر ما وقع، في صدر الشاشة: هذا سؤال اللحظة — «هل سُجّل شرائي؟» — ولا
  // يجيبه متوسطٌ ولا وسيط. والقائمة كاملةٌ خلف زرّ، فلا تُزاحم اللوحة.
  // ومتى تصفّح دورةً ماضية فآخرُ عملياتها هي المقصودة لا آخر ما وقع مطلقًا:
  // بطاقةٌ تعرض أغسطس وقائمةٌ تحتها تعرض أكتوبر تناقضٌ يُربك لا يُفيد.
  const vc = state.viewCycle;
  const inView = vc && !vc.isCurrent
    ? (a.list || []).filter((t) => t.date >= vc.from && t.date <= vc.to)
    : (a.list || []);
  const latest = inView.slice()
    .sort((x, y) => (x.date === y.date ? (x.seq || 0) - (y.seq || 0) : x.date.localeCompare(y.date)))
    .reverse().slice(0, 5);

  return `
  <div class="grid">
    ${monthCard(state.viewCycle || state.month, state)}
    ${forecastCard(state.forecast)}

    ${latest.length ? card(vc && !vc.isCurrent ? `آخر عمليات ${monthLabel(vc.key)}` : 'آخر خمس عمليات', txTable(latest, { state }), {
      actions: '<button class="btn tiny" data-action="go-tx">كل العمليات</button>',
    }) : ''}

    <div class="kpi-row">
      ${kpi('الدخل الشهري المتكرر', money(a.income.median, { round: true }), { sub: a.income.salary ? `راتب ${money(a.income.salary.amount, { round: true })} يوم ${num(a.income.salary.day)}` : 'مُستنتج من الوارد المتكرر', tone: 'ok' })}
      ${kpi('متوسط الصرف الشهري', money(a.spend.median, { round: true }), { sub: `الربيع الأعلى ${money(a.spend.p75, { round: true })}`, tone: '' })}
      ${kpi('الفائض الشهري', money(surplus, { round: true }), { sub: `معدل الادخار ${pct(a.savingsRate)}`, tone: surplus > 0 ? 'ok' : 'danger' })}
      ${kpi('اتجاه الصرف', `${trendUp ? '▲' : '▼'} ${money(Math.abs(a.spend.trend), { round: true })}`, { sub: 'شهريًا', tone: trendUp ? 'warn' : 'ok', hint: 'ميل الاتجاه الخطي للصرف عبر الأشهر المكتملة' })}
      ${kpi('تذبذب الصرف', pct(a.spend.cv), { sub: a.spend.cv < 0.2 ? 'ثابت نسبيًا' : 'متقلّب', tone: a.spend.cv < 0.2 ? 'ok' : 'warn' })}
      ${kpi('السيولة المرصودة', money(a.liquidBuffer, { round: true }), { sub: `${num(a.coverage.accounts.length)} حساب` })}
    </div>

    ${alerts.length ? `<div class="alerts"><ul>${alerts.join('')}</ul></div>` : ''}

    ${card('الصرف الشهري مقابل الدخل', monthlyChart(a.months, {
      incomeSeries: a.months.map((m) => {
        const hit = a.income.monthly.find((x) => x.key === m.key);
        return hit ? hit.amount : 0;
      }),
    }) + `<p class="legend"><span class="sw" style="background:var(--accent)"></span> صرف
      <span class="sw line"></span> دخل متكرر
      ${a.months.some((m) => m.partial) ? '<span class="muted">— الشهر المخطّط ناقص التغطية ولا يدخل في المتوسطات</span>' : ''}</p>`)}

    <div class="two-col">
      ${card('أين يذهب المال؟', `
        <div class="donut-wrap">
          ${donut(a.categories.slice(0, 8).map((c) => ({ label: c.ar, value: c.total, color: c.color })), {
            center: { top: money(a.spend.median, { round: true, bare: true }), bottom: 'وسيط شهري' },
          })}
          <ul class="legend-list">${a.categories.slice(0, 8).map((c) => `
            <li data-action="open-category" data-cat="${c.id}">
              <span class="sw" style="background:${c.color}"></span>
              <span class="lg-name">${escapeHTML(c.ar)}</span>
              <span class="lg-val">${money(c.monthlyAvg, { round: true })}</span>
              <span class="lg-share">${pct(c.share, 0)}</span>
            </li>`).join('')}</ul>
        </div>`, { actions: '<button class="btn tiny" data-action="go-categories">التفصيل</button>' })}

      ${card('بنية الإنفاق', `
        ${stackedBar(groups)}
        <table class="table compact mt">
          <tbody>${groups.map((g) => `<tr>
            <td><span class="sw" style="background:${g.color}"></span> ${escapeHTML(g.label)}</td>
            <td class="ltr">${money(g.value, { round: true })}</td>
            <td class="ltr muted">${pct(g.value / (groups.reduce((s, x) => s + x.value, 0) || 1), 0)}</td>
          </tr>`).join('')}</tbody>
        </table>
        <p class="hint">«الملتزم» و«شبه الثابت» هما ما لا يسهل تقليصه — وعليهما يقوم اختبار الأريحية. أما «الغامض» فسحب نقدي وتحويلات لم تُصنَّف بعد.</p>
      `)}
    </div>

    ${card('أعلى عشرة تجار', a.merchants.length ? hbars(a.merchants.slice(0, 10).map((m) => ({
      label: m.name || 'غير معروف',
      value: m.total,
      color: CATEGORY_MAP[m.category]?.color,
      sub: `${num(m.count)} عملية`,
    })), { valueFmt: (v) => money(v, { round: true }) }) : empty('لم يُستخرج اسم تاجر — استخدم «النسخة القابلة للتحليل» من الكشف.'))}
  </div>`;
}

// ── ٣) المجالات ───────────────────────────────────────────────────────────
export function viewCategories(a, state) {
  if (!a) return empty('لا توجد بيانات.');
  const cats = a.categories;
  return `<div class="grid">
    ${card('المجالات مرتّبة بالأثر الشهري', hbars(cats.map((c) => ({
      label: c.ar, value: c.monthlyAvg, color: c.color, sub: `${num(c.count)} عملية`, onclick: `open-category:${c.id}`,
    })), { valueFmt: (v) => money(v, { round: true }) }))}

    ${card('جدول المجالات', `<table class="table">
      <thead><tr><th>المجال</th><th>الطبيعة</th><th>متوسط شهري</th><th>الإجمالي</th><th>النسبة</th><th>الاتجاه</th><th>المسار</th></tr></thead>
      <tbody>${cats.map((c) => `<tr data-action="open-category" data-cat="${c.id}">
        <td><span class="sw" style="background:${c.color}"></span> ${escapeHTML(c.ar)}</td>
        <td><span class="tag ${c.group === 'مرن' ? 'flex' : c.group === 'غامض' ? 'amb' : 'fixed'}">${escapeHTML(c.group)}</span></td>
        <td class="ltr">${money(c.monthlyAvg, { round: true })}</td>
        <td class="ltr">${money(c.total, { round: true })}</td>
        <td class="ltr">${pct(c.share, 1)}</td>
        <td class="ltr ${c.trend > 0 ? 'neg' : 'pos'}">${c.trend > 0 ? '▲' : '▼'} ${money(Math.abs(c.trend), { round: true })}</td>
        <td>${sparkline(c.series, { color: c.color })}</td>
      </tr>`).join('')}</tbody></table>`)}

    ${state.openCategory ? categoryDetail(a, state.openCategory) : ''}
  </div>`;
}

function categoryDetail(a, catId) {
  const c = a.categories.find((x) => x.id === catId);
  if (!c) return '';
  const rows = a.list.filter((t) => !t.excluded && t.amount < 0 && (t.category || 'other') === catId)
    .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, 40);
  const merch = a.merchants.filter((m) => m.category === catId).slice(0, 8);
  return card(`تفصيل: ${c.ar}`, `
    <div class="row wrap gap">
      ${kpi('متوسط شهري', money(c.monthlyAvg, { round: true }))}
      ${kpi('الإجمالي', money(c.total, { round: true }))}
      ${kpi('عدد العمليات', num(c.count))}
      ${kpi('متوسط العملية', money(c.total / (c.count || 1), { round: true }))}
    </div>
    ${merch.length ? `<h3>أبرز التجار</h3>${hbars(merch.map((m) => ({ label: m.name, value: m.total, color: c.color })), { valueFmt: (v) => money(v, { round: true }) })}` : ''}
    <h3>أكبر العمليات</h3>
    ${txTable(rows)}
  `, { actions: '<button class="btn tiny" data-action="close-category">إغلاق</button>' });
}

// ── ٤) الالتزامات ─────────────────────────────────────────────────────────
export function viewCommitments(a) {
  if (!a) return empty('لا توجد بيانات.');
  const rec = a.recurring;
  const totalRec = rec.reduce((s, r) => s + r.amount, 0);
  return `<div class="grid">
    <div class="kpi-row">
      ${kpi('التزامات دورية مرصودة', money(totalRec, { round: true }), { sub: `${num(rec.length)} بندًا متكررًا` })}
      ${kpi('أقساط تمويل قائمة', money(a.existingInstallments, { round: true }), { tone: a.existingInstallments ? 'warn' : 'ok' })}
      ${kpi('نسبة الالتزام من الدخل', pct(a.income.median ? totalRec / a.income.median : 0), {})}
      ${kpi('الدخل غير المتكرر', money(a.income.oneOffTotal, { round: true }), { sub: `${num(a.income.oneOffCount)} دفعة — لا تُحتسب دخلًا`, tone: 'warn' })}
    </div>

    ${card('البنود المتكررة', rec.length ? `<table class="table">
      <thead><tr><th>البند</th><th>النوع</th><th>المجال</th><th>المبلغ</th><th>التكرار</th><th>اليوم</th><th>الثبات</th></tr></thead>
      <tbody>${rec.map((r) => `<tr>
        <td>${escapeHTML(r.label)}</td>
        <td>${TYPES[r.type]?.icon || ''} ${escapeHTML(TYPES[r.type]?.ar || r.type)}</td>
        <td>${escapeHTML(CATEGORY_MAP[r.category]?.ar || '—')}</td>
        <td class="ltr">${money(r.amount)}</td>
        <td>${num(r.months)} شهر / ${num(r.count)} مرة</td>
        <td class="ltr">${num(r.day)}</td>
        <td><span class="tag ${r.variation < 0.05 ? 'fixed' : 'flex'}">${r.variation < 0.05 ? 'ثابت' : `±${pct(r.variation, 0)}`}</span></td>
      </tr>`).join('')}</tbody></table>` : empty('لم تُرصد بنود متكررة بعد (تحتاج ثلاثة أشهر فأكثر).'))}

    ${card('مصادر الدخل', `
      ${a.income.salary ? `<p class="lead">الراتب: <strong>${money(a.income.salary.amount)}</strong> — يوم ${num(a.income.salary.day)} تقريبًا، رُصد ${num(a.income.salary.count)} مرة.</p>` : '<p class="lead">لم يُرصد راتب صريح؛ اعتُمد الوارد المتكرر.</p>'}
      <table class="table compact">
        <thead><tr><th>الشهر</th><th>دخل متكرر</th></tr></thead>
        <tbody>${a.income.monthly.map((m) => `<tr><td>${monthLabel(m.key)}</td><td class="ltr">${money(m.amount)}</td></tr>`).join('')}</tbody>
      </table>
      ${a.income.oneOff.length ? `<h3>وارد غير متكرر (مستبعد من حساب الدخل)</h3>${txTable(a.income.oneOff)}` : ''}
    `)}
  </div>`;
}

// ── ٥) المستفيدون ─────────────────────────────────────────────────────────
export function viewBeneficiaries(a) {
  if (!a) return empty('لا توجد بيانات.');
  const rows = a.beneficiaries;
  if (!rows.length) return empty('لا توجد حوالات صادرة في الكشف.');
  const own = rows.filter((b) => b.isOwn);
  const spend = rows.filter((b) => !b.isOwn);

  const table = (list, ownMode) => `<table class="table">
    <thead><tr><th>المستفيد</th><th>الغرض المذكور</th><th>العدد</th><th>الإجمالي</th><th>المدة</th><th></th></tr></thead>
    <tbody>${list.map((b) => `<tr>
      <td class="ltr ben">${escapeHTML(b.label)}
        ${b.twoWay ? '<span class="tag ok" title="يرد منه إليك مال أيضًا — قرينة على أنه حسابك">⇄ يرد منه</span>' : ''}
        ${b.kind === 'merchant' ? '<span class="tag amb">محفظة</span>' : ''}</td>
      <td>${b.purposes.length ? b.purposes.map((p) => `<span class="tag">${escapeHTML(p)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
      <td class="ltr">${num(b.count)}</td>
      <td class="ltr">${money(b.total)}</td>
      <td class="ltr muted nowrap">${dateLabel(b.first)} → ${dateLabel(b.last)}</td>
      <td><button class="btn tiny ${ownMode ? '' : 'primary'}" data-action="toggle-own" data-kind="${b.kind}" data-key="${escapeHTML(b.raw)}">
        ${ownMode ? '↩ أعِده صرفًا' : 'هذا حسابي'}</button></td>
    </tr>`).join('')}</tbody></table>`;

  return `<div class="grid">
    ${card('لماذا هذه الشاشة؟', `<p class="lead">الحوالة الصادرة قد تكون صرفًا حقيقيًا، وقد تكون نقلَ مالٍ إلى حسابك أو محفظتك لدى جهة أخرى.
      البنك لا يفرّق بينهما، والفرق يقلب حكم الملاءة رأسًا على عقب.
      وسمُك المستفيدَ مرة واحدة يسري على كل عملياته السابقة واللاحقة.</p>
      <p class="hint">علامة «⇄ يرد منه» تعني أن مالًا وردك من الآيبان نفسه — قرينة قوية على أنه حسابك. أما «شخصي في بنك آخر» فالكشف يذكره صراحةً وقد استُبعد تلقائيًا.</p>`)}

    ${own.length ? card(`موسومة بأنها حساباتك — ${money(own.reduce((s, b) => s + b.total, 0))}`, table(own, true), { cls: 'own' }) : ''}
    ${card(`تُحتسب صرفًا — ${num(spend.length)} جهة، ${money(spend.reduce((s, b) => s + b.total, 0))}`, table(spend, false))}
  </div>`;
}

// ── ٦) محرّك الملاءة ──────────────────────────────────────────────────────
export function viewFinancing(a, state) {
  if (!a) return empty('استورد كشفًا أولًا ليقيس المحرّك أريحيتك من إنفاقك الفعلي.', '<button class="btn primary" data-action="go-import">استيراد</button>');
  const f = state.finance;
  const ev = state.evaluation;
  const plan = state.plan;
  if (!ev) return empty('جارٍ الحساب…');

  const tone = ev.verdict === VERDICT.COMFORTABLE ? 'ok' : ev.verdict === VERDICT.TIGHT ? 'warn' : 'danger';
  const p = state.profile;

  return `<div class="grid">
    ${card('طلب التمويل', `
      <div class="row wrap gap">
        <label class="field"><span>المبلغ المطلوب</span>
          <input id="f-amount" lang="en" type="number" min="1000" step="1000" value="${f.amount}"></label>
        <label class="field"><span>المدة (شهر)</span>
          <input id="f-months" lang="en" type="number" min="6" max="120" step="1" value="${f.months}"></label>
        <label class="field"><span>نسبة الربح السنوية ٪</span>
          <input id="f-rate" lang="en" type="number" min="0" max="40" step="0.05" value="${(f.annualRate * 100).toFixed(2)}"></label>
        <label class="field"><span>طريقة الاحتساب</span>
          <select id="f-mode">
            <option value="flat" ${f.mode === 'flat' ? 'selected' : ''}>نسبة ثابتة على أصل المبلغ</option>
            <option value="reducing" ${f.mode === 'reducing' ? 'selected' : ''}>على الرصيد المتناقص</option>
          </select></label>
      </div>
      <div class="row wrap gap">
        <label class="field"><span>القسط المعلن (اختياري)</span>
          <input id="f-known" lang="en" type="number" min="0" step="10" value="${f.knownInstallment || ''}" placeholder="إن كان لديك عرض بقسط محدد"></label>
        <div class="field static"><span>القسط المحتسب</span><strong class="big ltr">${money(ev.installment)}</strong></div>
        <div class="field static"><span>إجمالي المسدَّد</span><strong class="ltr">${money(ev.totalCost)}</strong></div>
        <div class="field static"><span>كلفة الربح</span><strong class="ltr">${money(ev.profitCost)}</strong>
          ${f.mode === 'flat' ? `<em class="muted">≈ ${pct(effectiveAPR({ amount: f.amount, months: f.months, installment: ev.installment }))} فعلي</em>` : ''}</div>
      </div>
    `)}

    ${card('الحكم', `
      <div class="verdict ${tone}">
        <div class="verdict-gauge">${gauge(ev.score, { label: 'درجة الأريحية' })}</div>
        <div class="verdict-body">
          <div class="verdict-title">${escapeHTML(ev.verdictAr)}</div>
          <p class="verdict-lead">
            قسط ${money(ev.installment)} على دخل ${money(p.income.p50, { round: true })}،
            يترك فائضًا شهريًا قدره <strong>${money(ev.baseSurplus, { round: true })}</strong>
            بعد إنفاقك المرصود، و<strong>${money(ev.stressSurplus, { round: true })}</strong> في اختبار الضغط.
          </p>
          ${ev.stressBefore < 0 ? `<p class="verdict-note">تنبيه: في شهرٍ مرتفع الإنفاق بدخلٍ متحفظ، ميزانيتك تنقص
            <strong>${money(Math.abs(ev.stressBefore), { round: true })}</strong> <em>قبل</em> هذا التمويل أصلًا —
            أي أن أشهرك المرتفعة تُغطّى اليوم من وارد غير متكرر لا من الراتب. لذلك لا يعبر أي مبلغ حارسَ الضغط.</p>` : ''}
          <div class="checks">${ev.checks.map((c) => `
            <div class="check ${c.pass ? 'pass' : 'fail'}"><span>${c.pass ? '✔' : '✖'}</span> ${escapeHTML(c.msg)}</div>`).join('')}</div>
        </div>
      </div>
      <div class="row wrap gap mt">
        ${kpi('نسبة الاستقطاع', pct(ev.dbr), { sub: `السقف ${pct(ev.policy.dbrCap, 0)}`, tone: ev.dbr <= ev.policy.dbrCap ? 'ok' : 'danger' })}
        ${kpi('القسط من الدخل', pct(ev.instShare), { sub: `السقف ${pct(ev.policy.installmentShareCap, 0)}` })}
        ${kpi('القسط من الفائض الحالي', isFinite(ev.burdenOfSurplus) ? pct(ev.burdenOfSurplus) : '—', { sub: `فائضك اليوم ${money(ev.surplusBefore, { round: true })}`, tone: ev.burdenOfSurplus > 0.7 ? 'danger' : ev.burdenOfSurplus > 0.5 ? 'warn' : 'ok' })}
        ${kpi('تغطية الاحتياطي', `${num(ev.bufferMonths, 1)} شهر`, { sub: `الموصى به ${num(ev.policy.minBufferMonths)}`, tone: ev.bufferMonths >= ev.policy.minBufferMonths ? 'ok' : 'warn' })}
      </div>
      ${state.gap && state.gap.needed !== 0 ? `<div class="advice">
        ${state.gap.needed ? `<p>لتصير الحالة <strong>مريحة</strong> عند هذا المبلغ والمدة، يلزم تحرير <strong>${money(state.gap.needed)}</strong> شهريًا من إنفاقك المرن.</p>` : ''}
        ${state.gap.amountForComfort ? `<p>أو خفض المبلغ إلى <strong>${money(state.gap.amountForComfort)}</strong> بالمدة نفسها.</p>` : ''}
      </div>` : ''}
    `)}

    ${plan ? card('أنسب مدى', `
      ${plan.range ? `<p class="lead">
        بالمبلغ المطلوب (${money(f.amount, { round: true })}) يكون النطاق ${plan.level === VERDICT.COMFORTABLE ? '<strong>المريح</strong>' : '<strong>المقبول مع ضغط</strong>'}
        من <strong>${num(plan.range[0])}</strong> إلى <strong>${num(plan.range[1])}</strong> شهرًا،
        والأنسب <strong>${num(plan.best.months)} شهرًا</strong> بقسط ${money(plan.best.installment)} —
        لأنها أقصر مدة تحقّق الأريحية، فتقلّ كلفة الربح (${money(plan.best.profit, { round: true })}).
      </p>` : `<p class="lead danger-text">لا توجد مدة ضمن ${num(plan.rows[plan.rows.length - 1].months)} شهرًا يصير عندها هذا المبلغ ملائمًا.</p>`}
      <div class="row wrap gap">
        ${kpi('أقصى مبلغ بأريحية', money(plan.maxComfortableAmount, { round: true }), { tone: 'ok', sub: `بمدة ${num(ev.policy.maxTerm)} شهرًا` })}
        ${kpi('أقصى مبلغ مع ضغط', money(plan.maxTightAmount, { round: true }), { tone: 'warn' })}
      </div>
      <table class="table compact mt">
        <thead><tr><th>المدة</th><th>القسط</th><th>الفائض بعده</th><th>تحت الضغط</th><th>الاستقطاع</th><th>كلفة الربح</th><th>الحكم</th></tr></thead>
        <tbody>${termRows(plan)}</tbody>
      </table>
    `) : ''}

    ${card('الأساس الذي بُني عليه الحكم', `
      <p class="hint">هذه الأرقام مستخرجة من كشوفك، ويمكنك تجاوز أيٍّ منها يدويًا من الإعدادات.</p>
      <table class="table compact">
        <tbody>
          <tr><td>الدخل الشهري المتكرر (وسيط)</td><td class="ltr">${money(p.income.p50)}</td></tr>
          <tr><td>الدخل في السيناريو المتحفظ</td><td class="ltr">${money(p.income.p25)}</td></tr>
          <tr><td>إنفاق ملتزم وشبه ثابت</td><td class="ltr">${money(p.essentials.p50)} <span class="muted">(مرتفع: ${money(p.essentials.p75)})</span></td></tr>
          <tr><td>إنفاق مرن وغامض</td><td class="ltr">${money(p.discretionary.p50)} <span class="muted">(مرتفع: ${money(p.discretionary.p75)})</span></td></tr>
          <tr><td>أقساط قائمة</td><td class="ltr">${money(p.existingInstallments)}</td></tr>
          <tr><td>السيولة المتاحة</td><td class="ltr">${money(p.liquidBuffer)}</td></tr>
          <tr><td>تذبذب الإنفاق</td><td class="ltr">${pct(p.spendCV)}</td></tr>
          <tr><td>أشهر مكتملة مرصودة</td><td class="ltr">${num(a.coverage.solid)}</td></tr>
        </tbody>
      </table>
    `)}
  </div>`;
}

function termRows(plan) {
  // نعرض مدىً مقروءًا: كل ٦ أشهر، مع إبراز الأنسب
  const picks = plan.rows.filter((r) => r.months % 6 === 0 || r.months === plan.best?.months);
  return picks.map((r) => `<tr class="${r.months === plan.best?.months ? 'best' : ''}">
    <td>${num(r.months)}</td>
    <td class="ltr">${money(r.installment)}</td>
    <td class="ltr ${r.baseSurplus < 0 ? 'neg' : ''}">${money(r.baseSurplus, { round: true })}</td>
    <td class="ltr ${r.stressSurplus < 0 ? 'neg' : ''}">${money(r.stressSurplus, { round: true })}</td>
    <td class="ltr">${pct(r.dbr, 0)}</td>
    <td class="ltr">${money(r.profit, { round: true })}</td>
    <td><span class="tag ${r.verdict === VERDICT.COMFORTABLE ? 'ok' : r.verdict === VERDICT.TIGHT ? 'warn' : 'danger'}">${VERDICT_AR[r.verdict]}</span></td>
  </tr>`).join('');
}

// ── ٦) العمليات ───────────────────────────────────────────────────────────
export function viewTransactions(a, state) {
  if (!a) return empty('لا توجد بيانات.');
  const q = (state.filter.q || '').trim();
  let rows = a.list;
  if (state.filter.onlyUncat) rows = rows.filter((t) => (t.category || 'other') === 'other' && t.amount < 0);
  if (state.filter.onlyExcluded) rows = rows.filter((t) => t.excluded);
  if (state.filter.cat) rows = rows.filter((t) => t.category === state.filter.cat);
  if (state.filter.account) rows = rows.filter((t) => t.account === state.filter.account);
  if (state.filter.from) rows = rows.filter((t) => t.date >= state.filter.from);
  if (state.filter.to) rows = rows.filter((t) => t.date <= state.filter.to);
  if (q) {
    const qq = q.toLowerCase();
    rows = rows.filter((t) => `${t.desc} ${t.merchant || ''} ${t.ref || ''} ${t.bankType || ''}`.toLowerCase().includes(qq));
  }
  rows = rows.slice().sort((x, y) => y.date.localeCompare(x.date));
  // ثلاثمئة صفٍّ دفعةً واحدة قيست ٤٣٬٧٦٨ بكسل على الجوال — أربعٌ وخمسون شاشة
  // تمريرٍ لا يبلغ آخرها أحد. تُعرض دفعةٌ ويُطلب ما بعدها.
  const total = rows.length;
  const limit = state.txLimit || TX_PAGE;
  const shown = rows.slice(0, limit);

  return `<div class="grid">
    ${card('', `
      ${state.filter.from || state.filter.to ? `<div class="range-chip">
        <span>محصورٌ بـ ${escapeHTML(dateLabel(state.filter.from))} — ${escapeHTML(dateLabel(state.filter.to))}</span>
        <button class="btn tiny" data-action="range-clear">أزِل الحصر</button>
      </div>` : ''}
      <div class="row wrap gap filters">
        <input id="q" type="search" placeholder="ابحث باسم تاجر أو وصف أو رقم عملية…" value="${escapeHTML(q)}">
        <select id="f-cat"><option value="">كل المجالات</option>${CATEGORIES.map((c) => `<option value="${c.id}" ${state.filter.cat === c.id ? 'selected' : ''}>${c.ar}</option>`).join('')}</select>
        <select id="f-acc"><option value="">كل الحسابات</option>${a.coverage.accounts.map((x) => `<option value="${escapeHTML(x)}" ${state.filter.account === x ? 'selected' : ''}>${escapeHTML(x)}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" id="f-uncat" ${state.filter.onlyUncat ? 'checked' : ''}> غير المصنّف فقط</label>
        <label class="chk"><input type="checkbox" id="f-exc" ${state.filter.onlyExcluded ? 'checked' : ''}> المستبعد فقط</label>
      </div>
      ${txTable(shown, { editable: true, state })}
      <p class="hint">وسمُك لعملية يُنشئ قاعدة تُطبَّق على كل عمليات التاجر نفسه — فتصنيف مئة عملية يستغرق دقائق.</p>
      ${total > shown.length ? `<div class="row gap center mt">
        <button class="btn" data-action="tx-more">اعرض ${num(Math.min(TX_PAGE, total - shown.length))} عملية أخرى</button>
        <span class="hint">ظهرت ${num(shown.length)} من ${num(total)}</span>
      </div>` : total ? `<p class="hint center">هذه كل العمليات المطابقة (${num(total)}).</p>` : ''}
    `)}
  </div>`;
}

/** حجم الدفعة الواحدة في قائمة العمليات. */
export const TX_PAGE = 40;

/**
 * قائمة العمليات صفوفًا لا جدولًا.
 * قيس الجدول على ٣٧٥ بكسل: خمسة أعمدة تتزاحم فيلتفّ نصّ كل خلية، فيبلغ
 * الصفّ ١٤٤ بكسل — خمسةُ صفوفٍ في الشاشة. والصفّ هنا سطران: التاجرُ والمبلغ
 * في الأعلى لأنهما المقروءان، وما دونهما بيانٌ مساعد. ويصير سطرًا واحدًا
 * على الشاشات الواسعة، فلا حاجة إلى بنيتين ولا إلى تكرار في DOM.
 */
function txTable(rows, { editable = false, state = {} } = {}) {
  if (!rows.length) return empty('لا توجد عمليات مطابقة.');
  return `<ul class="tx-list">${rows.map((t) => `
    <li class="tx-row ${t.excluded ? 'excluded' : ''}">
      <div class="tx-main" data-action="tag-open" data-id="${t.id}" role="button" tabindex="0"
        title="اضغط للتعديل: المجال والصنف الفرعي، أو جعله غير محسوب">
        <span class="tx-title">${escapeHTML(t.merchant || t.bankType || (t.desc || '').slice(0, 60))}</span>
        <span class="tx-amount ltr ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</span>
      </div>
      <div class="tx-meta">
        <span class="ltr">${dateLabel(t.date)}</span>
        <span>${TYPES[t.type]?.icon || ''} ${escapeHTML(TYPES[t.type]?.ar || '')}</span>
        ${t.city ? `<span>${escapeHTML(t.city)}</span>` : ''}
        <span class="tx-acc">${escapeHTML(t.account)}</span>
        ${t.status === 'pending' ? `<span class="tag" title="وصلت من إشعار بنكك وهي محسوبة في صرفك. وحين تستورد الكشف تُطابَق بنظيرتها فتُدمجان في واحدة — ولا تُحتسب مرتين.">📨 من رسالة</span>` : ''}
        ${t.excluded ? `<span class="tag amb">مستبعد: ${excuseAr(t.excludeReason)}</span>` : ''}
      </div>
      <div class="tx-actions">
        ${editable ? `<select class="cat-select" data-action="set-cat" data-id="${t.id}" aria-label="مجال العملية">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${(t.category || 'other') === c.id ? 'selected' : ''}>${c.ar}</option>`).join('')}
          </select>` : `<span class="tag">${escapeHTML(CATEGORY_MAP[t.category]?.ar || '—')}</span>`}
        ${t.subcategory ? `<span class="tag sub">${escapeHTML(t.subcategory)}</span>` : ''}
        ${t.categorySource === 'user' ? '<span class="dot user" title="وسم يدوي"></span>' : t.categorySource === 'rule' ? '<span class="dot rule" title="بقاعدة"></span>' : ''}
        <button class="btn tiny" data-action="tag-open" data-id="${t.id}" title="صنّف المحل بدقّة">🏷️</button>
        ${editable ? `<button class="btn tiny" data-action="toggle-exclude" data-id="${t.id}" title="استبعاد/إرجاع">${t.excluded ? '↩' : '⊘'}</button>` : ''}
      </div>
      ${state.tagging === t.id ? tagEditor(t, state) : ''}
    </li>`).join('')}</ul>`;
}

/**
 * محرّر تصنيف المحل: مجالٌ وصنفٌ فرعي، وما يُختار يصير قاعدةً تلتقط كل
 * شراءٍ من المحلّ نفسه بعدها. فالوسم مرةً واحدة لا في كل عملية.
 *
 * والصنف الفرعي قائمةٌ مقترحة يُكتب فيها: `datalist` يعرض الجاهز ولا يمنع
 * الجديد — فلا يُحبس المستخدم في قائمةٍ نقصت، ولا يُترك بلا اقتراح فيكتب
 * الاسم الواحد بوجوه.
 */
function tagEditor(t, state) {
  const cat = t.category || 'other';
  const subs = subcategoriesFor(cat, state.settings?.subcategories || {});
  const merchant = t.merchant || t.merchantHint || '';
  return `<div class="tag-editor">
    <p class="hint">${merchant ? `سيُطبَّق على كل عمليات <strong>${escapeHTML(merchant)}</strong> — الماضية والقادمة.`
      : 'لا اسم تاجرٍ في هذه العملية، فستُطبَّق على أشباهها بالمبلغ أو النوع.'}</p>
    <div class="row wrap gap">
      <label class="field"><span>المجال</span>
        <select id="tag-cat" data-id="${t.id}">
          ${catOptions(cat, t.amount)}
        </select>
      </label>
      <label class="field"><span>الصنف الفرعي (اختر أو اكتب جديدًا)</span>
        <input id="tag-sub" list="tag-sub-list" value="${escapeHTML(t.subcategory || '')}" placeholder="مثال: عصائر">
        <datalist id="tag-sub-list">${subs.map((s) => `<option value="${escapeHTML(s)}"></option>`).join('')}</datalist>
      </label>
    </div>
    <label class="chk mt"><input type="checkbox" id="tag-exclude" ${t.excluded ? 'checked' : ''}>
      <span>بندٌ غير محسوب — يظهر في سجلّك ولا يدخل في صرفك ولا دخلك</span></label>
    ${t.excluded && t.excludeReason && t.excludeReason !== 'user'
      ? `<p class="hint">مستبعدٌ الآن آليًّا (${escapeHTML(excuseAr(t.excludeReason))}). وإلغاء الاختيار يُرجعه محسوبًا بقرارك.</p>` : ''}
    <div class="row gap end mt">
      <button class="btn" data-action="tag-cancel">إلغاء</button>
      <button class="btn primary" data-action="tag-save" data-id="${t.id}">احفظ وطبّقه على المحل</button>
    </div>
  </div>`;
}

/**
 * قائمة المجالات مجمَّعةً بطبيعتها، والوارد يُقدَّم في العمليات الموجبة.
 * فمن يصنّف راتبًا لا يُعرض عليه «بقالة وتموين» أولًا، ومن يصنّف شراءً لا
 * يبحث عن «مطاعم» تحت مجالات الدخل.
 */
function catOptions(selected, amount) {
  const income = amount > 0;
  const groups = [...new Set(CATEGORIES.map((c) => c.group))]
    .sort((a, b) => (a === 'دخل' ? -1 : b === 'دخل' ? 1 : 0) * (income ? 1 : -1));
  return groups.map((g) => `<optgroup label="${escapeHTML(g)}">${CATEGORIES.filter((c) => c.group === g)
    .map((c) => `<option value="${c.id}" ${selected === c.id ? 'selected' : ''}>${escapeHTML(c.ar)}</option>`).join('')}</optgroup>`).join('');
}

function excuseAr(r) {
  return { internal: 'تحويل داخلي', reversal: 'مرتجع', extraordinary: 'استثنائي', user: 'يدوي' }[r] || '';
}

// ── ٧) الإعدادات ──────────────────────────────────────────────────────────
export function viewSettings(state, a) {
  const s = state.settings;
  const rules = state.rules || [];
  return `<div class="grid">
    ${foldable('حدّ الإنفاق الشهري', `
      <p class="hint">هو ما تقيس به شهرك: كم صُرف، وكم بقي، وهل وتيرتك أسرع من حدّك.
        اتركه فارغًا ليُشتقّ من وسيط صرفك${a?.spend?.median ? ` — وهو الآن ${money(a.spend.median, { round: true })}` : ''}.</p>
      ${numField('b-limit', 'الحدّ الشهري (ر.س)', s.budget?.monthlyLimit ?? '', 'مُشتقّ من كشوفك')}
      ${numField('b-start', 'يوم بداية الدورة', s.budget?.cycleStartDay ?? 1)}
      <p class="hint">من ينزل راتبه يوم ٢٧ يعيش دورةً من ٢٧ إلى ٢٦، وقياسُه بالشهر التقويمي يقطع دورته
        نصفين: نصفٌ في شهرٍ ونصفٌ في آخر. واضبطه <code>27</code> فتصير دورة أغسطس من ٢٧ يوليو إلى ٢٦ أغسطس.
        و<code>1</code> يعني الشهر التقويمي كما كان.</p>
    `, { open: true })}

    ${foldable('حُرّاس القرار', `
      <p class="hint">هذه السقوف هي ما يفصل «مريح» عن «مع ضغط» عن «غير ملائم». عدّلها لتوافق سياستك.</p>
      <div class="row wrap gap">
        ${numField('p-dbrCap', 'سقف نسبة الاستقطاع ٪', s.policy.dbrCap * 100)}
        ${numField('p-dbrHardCap', 'السقف القاطع ٪', s.policy.dbrHardCap * 100)}
        ${numField('p-instShare', 'أقصى نسبة للقسط من الدخل ٪', s.policy.installmentShareCap * 100)}
        ${numField('p-surplus', 'أدنى فائض متبقٍّ ٪ من الدخل', s.policy.comfortSurplusRatio * 100)}
        ${numField('p-buffer', 'أشهر الاحتياطي الموصى بها', s.policy.minBufferMonths)}
        ${numField('p-maxTerm', 'أقصى مدة تُدرس (شهر)', s.policy.maxTerm)}
      </div>`)}

    ${foldable('معالجة البيانات', `
      <label class="chk"><input type="checkbox" id="a-internal" ${s.analysis.excludeInternal ? 'checked' : ''}> استبعاد التحويل بين حساباتي</label>
      <label class="chk"><input type="checkbox" id="a-rev" ${s.analysis.excludeReversals ? 'checked' : ''}> استبعاد العمليات المرتجعة</label>
      <label class="chk"><input type="checkbox" id="a-extra" ${s.analysis.excludeExtraordinary ? 'checked' : ''}> استبعاد الدفعات الاستثنائية</label>
      <label class="chk"><input type="checkbox" id="a-partial" ${s.analysis.ignoreLastPartialMonth ? 'checked' : ''}> تجاهل الأشهر ناقصة التغطية في المتوسطات</label>
      ${numField('a-factor', 'حد الاستثنائي = كم ضعفًا من وسيط الشهر', s.analysis.extraordinaryFactor)}
      <h3>التحويل إلى حساباتك الأخرى</h3>
      <p class="hint">القاعدة: الريال يُحتسب مرة واحدة — حين يخرج من بيتك لا حين ينتقل بين جيوبك.
        فما لم تصلك تفاصيل حسابك الآخر، التحويل إليه <strong>هو</strong> الصرف؛ ومتى صارت تصلك من رسائل البنك
        أو من كشفٍ مستورد، صار التحويل نقلًا لا صرفًا — واحتسابه حينئذٍ يُحصي الريال مرتين.</p>
      <label class="field"><span>احتسب التحويل إلى حساباتي صرفًا حتى تاريخ</span>
        <input type="date" id="a-own-until" value="${escapeHTML(s.analysis.ownTransfersSpendUntil || '')}"></label>
      <p class="hint">اجعله <strong>يومَ تشغيلك لأتمتة الرسائل</strong>: قبله يُحتسب التحويل، وبعده تُحتسب المشتريات نفسها.
        واتركه فارغًا ليُستبعد التحويل دائمًا — وهو الصواب متى استوردت كشوف تلك الحسابات.</p>`)}

    ${foldable('تجاوز يدوي لأرقام الملاءة', `
      <p class="hint">اتركها فارغة ليُحتسب الرقم من الكشوف. املأها إن كنت تعرف رقمًا أدق (مثل راتب سيتغيّر، أو إيجار يُدفع نقدًا).</p>
      <div class="row wrap gap">
        ${numField('m-income', 'الدخل الشهري', s.manual.income, 'من الكشف')}
        ${numField('m-essentials', 'الإنفاق الملتزم', s.manual.essentials, 'من الكشف')}
        ${numField('m-discretionary', 'الإنفاق المرن', s.manual.discretionary, 'من الكشف')}
        ${numField('m-installments', 'الأقساط القائمة', s.manual.existingInstallments, 'من الكشف')}
        ${numField('m-buffer', 'السيولة المتاحة', s.manual.liquidBuffer, 'من الكشف')}
      </div>`)}

    ${foldable(`قواعد التصنيف (${num(rules.length)})`, rules.length ? `<table class="table compact">
      <thead><tr><th>الشرط</th><th>المجال</th><th></th></tr></thead>
      <tbody>${rules.map((r) => `<tr>
        <td>${escapeHTML(ruleAr(r))}</td>
        <td>${escapeHTML(CATEGORY_MAP[r.category]?.ar || r.category)}</td>
        <td><button class="btn tiny danger" data-action="del-rule" data-id="${r.id}">حذف</button></td>
      </tr>`).join('')}</tbody></table>` : empty('لا قواعد بعد — وسم أي عملية من صفحة العمليات يُنشئ قاعدة تلقائيًا.'))}

    ${foldable('ربط رسائل البنك بالجوال', inboxBody(state), { hint: state.inbox?.boxId ? 'مربوط' : 'غير مربوط' })}

    ${foldable('أداة شاشة الآيفون', widgetBody(state), { hint: state.settings?.widget?.enabled ? 'مفعّلة' : 'متوقفة' })}
    ${foldable('التنبيهات', notifyBody(state), { hint: state.notify?.enabled ? 'مفعّلة' : 'متوقفة' })}

    ${foldable('رمز الدخول والمزامنة', syncBody(state), { open: true, hint: state.sync?.secret ? 'مفعّلة' : 'متوقفة' })}

    ${foldable('البيانات وأين تُحفظ', `
      <p class="lead">بياناتك محفوظة <strong>داخل هذا المتصفح على هذا الجهاز</strong> فقط — لا خادم ولا حساب ولا مزامنة.
        فلا تظهر على جهاز آخر، ولا تنتقل بين نطاقين مختلفين.</p>
      ${state.storage ? `<p class="hint">حالة التخزين:
        ${state.storage.persisted
          ? '✅ <strong>دائم</strong> — لن يمحوه المتصفح تلقائيًا.'
          : '⚠️ <strong>غير مثبَّت</strong> — قد يمحوه المتصفح إن ضاقت المساحة أو طال عدم الاستخدام (سفاري على الجوال خاصةً). صدّر نسخة احتياطية.'}
        ${state.storage.usage ? ` المستخدَم: ${money(state.storage.usage / 1048576, { bare: true })} م.ب.` : ''}</p>` : ''}
      <p class="hint">للانتقال بين الأجهزة: صدّر نسخة كاملة، واحفظها في iCloud أو Drive، ثم استوردها في الجهاز الآخر.
        النسخة تحمل العمليات والقواعد ووسمَ حساباتك معًا.</p>
      <div class="row gap wrap">
        <button class="btn" data-action="export-json">تصدير نسخة كاملة (JSON)</button>
        <button class="btn" data-action="export-csv">تصدير العمليات (CSV)</button>
        <button class="btn" data-action="import-json">استيراد نسخة</button>
        <button class="btn danger" data-action="wipe">مسح كل البيانات</button>
      </div>
      <p class="hint">كل شيء محفوظ في متصفحك (IndexedDB). مسح بيانات الموقع يمحوها، فاحتفظ بنسخة إن أردت.</p>
      <p class="hint muted">نسخة التطبيق: <code>${APP_VERSION}</code> — إن كانت أقدم مما يقوله لك المطوّر فأعد التحميل مرتين.</p>`)}
  </div>`;
}

function inboxBody(state) {
  const i = state.inbox || {};
  if (!state.sync?.secret) {
    return `<p class="lead">فعّل المزامنة أولًا — رمز صندوق الرسائل يُشتقّ من مفتاحها.</p>`;
  }
  const url = `${location.origin}/api/ingest?box=${i.boxId || '…'}`;
  return `
    <p class="lead">تصلك رسالة من البنك عند كل عملية. اجعل جوالك يمرّرها إلى هنا، فتظهر العملية في لوحتك خلال ثوانٍ
      بدل انتظار الكشف الشهري.</p>
    <div class="secret-box"><code class="secret">${escapeHTML(url)}</code>
      <button class="btn tiny" data-action="inbox-copy-url">نسخ الرابط</button></div>

    <h3>على الآيفون — أتمتةٌ مستقلّة لكل مصرف</h3>
    <ol class="steps">
      <li>الاختصارات ← <strong>الأتمتة</strong> ← + ← <strong>رسالة</strong>.</li>
      <li>«المرسِل» = مرسِلٌ واحد من الثلاثة، و«يحتوي على» اتركه فارغًا،
        ثم <strong>تشغيل فورًا</strong> (أطفئ «اسألني قبل التشغيل»).</li>
      <li>أضف إجراء <strong>Get Contents of URL</strong> بالرابط أعلاه، والطريقة <code>POST</code>،
        و<code>Request Body</code> = <strong>JSON</strong>.</li>
      <li><strong>الحقل الأول</strong> — المفتاح: اكتب <code>text</code>.
        <br>والقيمة: <strong class="danger-text">لا تكتب فيها شيئًا</strong>. اضغط خانة القيمة، ثم اختر
        <strong>مُدخل الاختصار</strong> من شريط المتغيّرات فوق لوحة المفاتيح — يظهر
        <em>محاطًا بلونٍ مميّز</em>، وهذه علامة أنه متغيّر لا نصّ.</li>
      <li><strong>الحقل الثاني</strong> — المفتاح: <code>sender</code>، والقيمة: اسم المرسِل وحده،
        مثل <code>BankAlbilad</code> بلا زيادة.</li>
      <li>كرّر الأتمتة لكل مرسِل: <code>BankAlbilad</code> و<code>AlRajhiBank</code> و<code>STC Bank</code>
        — <strong>وأهمّها الراجحي</strong> إن كانت مشترياتك عليه.</li>
    </ol>
    <p class="hint danger-text">⚠️ أكثر خطأ يقع في هذا الإعداد: كتابة وصف الحقل مكان قيمته. فإن رأيت
      قيمةَ <code>text</code> نصًّا عاديًّا لا متغيّرًا ملوّنًا، فالأتمتة سترسل ذلك النصّ نفسه في كل مرة
      ولن تصل رسالةٌ واحدة من مصرفك.</p>
    <p class="hint">حقل <code>sender</code> ليس زينة: به يُميَّز <code>AlRajhiBank</code> عن <code>AlRajhiB-AD</code>،
      فتُردّ العروض التسويقية ولا تدخل حسابك عمليةً لم تقع. ويكفي النصّ وحده جسمًا للطلب إن تعذّر JSON،
      لكنك تفقد هذا التمييز. ولا تُنشئ أتمتةً لمرسِلٍ ينتهي بـ<code>-AD</code> أصلًا.</p>
    <h3>على الأندرويد</h3>
    <p class="hint">MacroDroid أو Tasker: محفّز «SMS مستلَمة» من المرسِلات الثلاثة ← إجراء HTTP POST إلى الرابط نفسه،
      والجسم <code>{"text":"…","sender":"…"}</code> بنوع <code>application/json</code>.</p>

    <div class="row gap wrap">
      <button class="btn primary" data-action="inbox-drain" ${i.busy ? 'disabled' : ''}>اسحب الرسائل الآن</button>
      <button class="btn" data-action="paste-open">الصق رسائل فائتة</button>
      <button class="btn" data-action="reconcile">طابِق المعلَّقات بالكشف</button>
      <button class="btn danger" data-action="inbox-clear">امسح الصندوق</button>
    </div>
    <p class="hint">${i.busy ? 'جارٍ…' : i.lastAt ? `آخر سحب: ${escapeHTML(new Date(i.lastAt).toLocaleString('ar-SA'))}` : 'لم يُسحب شيء بعد'}
      ${i.status ? `<span class="danger-text"> — ${escapeHTML(i.status)}</span>` : ''}</p>
    ${inboxHarvest(i)}
    ${i.failed?.some((m) => m.misconfig) ? `<div class="alerts" style="border-inline-start-color:var(--danger)">
      <p><strong class="danger-text">الأتمتة ترسل نصّ الشرح لا نصّ الرسالة.</strong>
      في اختصارك، قيمةُ الحقل <code>text</code> نصٌّ مكتوب بدل متغيّر <strong>مُدخل الاختصار</strong>.
      فتُرسَل العبارة نفسها في كل مرة، ولا تصل رسالةٌ واحدة من مصرفك.</p>
      <p class="hint">العلاج: افتح الأتمتة ← احذف ما في خانة قيمة <code>text</code> ← اضغطها ثم اختر
      <strong>مُدخل الاختصار</strong> من شريط المتغيّرات فوق لوحة المفاتيح. يجب أن تراه
      <em>محاطًا بلونٍ مميّز</em> لا نصًّا عاديًّا.</p>
    </div>` : ''}
    ${i.failed?.length ? `<h3>رسائل لم تُفهم (${num(i.failed.length)})</h3>
      <p class="hint">النصّ كاملًا لا مقتطعًا: بلا رؤيته لا يُعرف أهو شكلٌ جديد أم محرفٌ خفيّ أفسد القراءة.</p>
      <ul class="failed-list">${i.failed.slice(0, 8).map((m) => `<li>
        <div class="fl-head"><span class="tag amb">${escapeHTML(m.reason || '')}</span>
          <span class="muted">${escapeHTML(m.sender || 'بلا مرسِل')}</span></div>
        <pre class="fl-text">${escapeHTML(String(m.text || ''))}</pre>
      </li>`).join('')}</ul>
      <div class="row gap wrap">
        <button class="btn" data-action="copy-failed">انسخ نصوصها كاملة</button>
      </div>
      <p class="hint">تبقى في الصندوق و<strong>تُعاد محاولة تحليلها في كل سحب</strong> — فإن كان شكلها قد أُضيف
        في نسخةٍ أحدث، حدّث الصفحة ثم اسحب فتُفهم. وإن بقيت، انسخها وأرسلها لأضيف شكلها.
        <br>النسخة العاملة الآن على هذا الجهاز: <code>${escapeHTML(APP_VERSION)}</code>.</p>` : ''}
    ${pasteBody(state)}
    <p class="hint">🔒 نصّ الرسالة يمكث في الصندوق حتى يسحبه التطبيق فيُمسح فورًا، وما لم يُسحب يُمسح تلقائيًا بعد ٧٢ ساعة.
      ولا يُمسّ شيء من رسائلك في جوالك.</p>`;
}

/**
 * لصق الرسائل الفائتة: نصٌّ يُلصق، ويُعرض ما فُهم منه قبل اعتماده.
 * لا يُعتمد شيءٌ بلا معاينة: الرقم الذي يدخل حسابك بلا أن تراه أخطرُ من
 * رقمٍ لا يدخل.
 */
function pasteBody(state) {
  const p = state.paste;
  if (!p) return '';
  return `
    <h3>الصق رسائل فائتة</h3>
    <p class="hint">انسخ الرسالة من تطبيق الرسائل والصقها هنا. ولعدّة رسائل: افصل بينها
      <strong>بسطرٍ فارغ</strong>. ولا يغادر النصّ متصفحك — لا يمرّ بخادم ولا يُشفَّر ولا ينتظر.</p>
    <textarea id="paste-text" rows="6" placeholder="شراء عبر نقاط البيع&#10;لدى:JAVA JOY C&#10;مبلغ:74 SAR&#10;8/8/26 23:23">${escapeHTML(p.text || '')}</textarea>
    <div class="row gap wrap mt">
      <button class="btn primary" data-action="paste-parse">حلّلها</button>
      ${p.result ? `<button class="btn" data-action="paste-clear">أفرغ</button>` : ''}
    </div>
    ${p.result ? pasteResult(p.result) : ''}`;
}

function pasteResult(r) {
  return `
    <div class="row wrap gap mt">
      ${kpi('فُهمت', num(r.added.length), { tone: r.added.length ? 'ok' : '' })}
      ${kpi('جديدة', num(r.fresh.length), { tone: r.fresh.length ? 'ok' : 'warn' })}
      ${kpi('مكررة', num(r.dups.length), { tone: r.dups.length ? 'warn' : '' })}
      ${kpi('لم تُفهم', num(r.failed.length), { tone: r.failed.length ? 'danger' : '' })}
    </div>
    ${r.fresh.length ? `<ul class="tx-list mt">${r.fresh.map((t) => `<li class="tx-row">
      <div class="tx-main">
        <span class="tx-title">${escapeHTML(t.merchantHint || TYPES[t.smsKind]?.ar || 'عملية')}</span>
        <span class="tx-amount ltr ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</span>
      </div>
      <div class="tx-meta"><span class="ltr">${dateLabel(t.date)}</span>
        <span>${TYPES[t.smsKind]?.icon || ''} ${escapeHTML(TYPES[t.smsKind]?.ar || '')}</span>
        ${t.excluded ? '<span class="tag amb">مستبعد: تحويل داخلي</span>' : ''}</div>
    </li>`).join('')}</ul>` : ''}
    ${r.failed.length ? `<ul class="failed-list mt">${r.failed.map((f) => `<li>
      <div class="fl-head"><span class="tag amb">${escapeHTML(f.reason || '')}</span></div>
      <pre class="fl-text">${escapeHTML(f.text)}</pre></li>`).join('')}</ul>` : ''}
    ${r.fresh.length ? `<div class="row gap end mt">
      <button class="btn primary" data-action="paste-commit">اعتمد ${num(r.fresh.length)} عملية</button>
    </div>` : r.added.length ? '<p class="hint">كلها موجودة عندك مسبقًا — لا جديد يُضاف.</p>' : ''}`;
}

/**
 * حصاد الرسائل بالأيام: العدد وحده يجيب «هل تعمل الأتمتة؟» دون انتظار كشف.
 * وينبّه إن طال العهد بالسحب، لأن الصندوق ممرٌّ لا مستودع: ما لم يُسحب في
 * اثنتين وسبعين ساعة يُمحى — والتطبيق لا يسحب وهو مغلق.
 */
function inboxHarvest(i) {
  const today = todayISO();
  const week = lastDays(i.log, today, 7);
  const month = lastDays(i.log, today, 30);
  const hoursSince = i.lastAt ? (Date.now() - Date.parse(i.lastAt)) / 3600000 : null;
  const stale = hoursSince != null && hoursSince > 24;

  return `
    <h3>حصاد الرسائل على هذا الجهاز</h3>
    <table class="table compact">
      <tbody>
        <tr><td>اليوم</td><td class="ltr"><strong>${num(week.rows[0].count)}</strong> عملية</td></tr>
        <tr><td>آخر سبعة أيام</td><td class="ltr"><strong>${num(week.total)}</strong> عملية</td></tr>
        <tr><td>آخر ثلاثين يومًا</td><td class="ltr">${num(month.total)} عملية</td></tr>
      </tbody>
    </table>
    <table class="table compact mt">
      <thead><tr><th>اليوم</th><th>ما دخل من الرسائل</th></tr></thead>
      <tbody>${week.rows.map((r) => `<tr>
        <td>${dateLabel(r.date)}</td>
        <td class="ltr">${r.count ? `<strong class="pos">${num(r.count)}</strong>` : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table>
    ${stale ? `<p class="hint warn-text">مضى ${num(Math.floor(hoursSince))} ساعة على آخر سحب.
      التطبيق لا يسحب وهو مغلق، والرسالة تُمحى من الصندوق بعد ٧٢ ساعة — فافتحه مرة كل يومين على الأقل.</p>` : ''}
    <p class="hint">هذا العدّاد لهذا الجهاز وحده: السحب يقع على أوّل جهازٍ يُفتح، والعمليات نفسها تتزامن بينهما.</p>`;
}

function notifyBody(state) {
  const n = state.notify || {};
  const list = state.reminders || [];
  const blocked = n.permission === 'denied';
  return `
    <p class="lead">${n.enabled ? 'التنبيهات مفعّلة على هذا الجهاز.' : 'فعّل التنبيهات لتذكيرك بمواعيد الأقساط والراتب، وبتحديث الكشف، وبتجاوز وتيرة الصرف.'}</p>
    <div class="row gap wrap">
      <button class="btn ${n.enabled ? 'danger' : 'primary'}" data-action="notify-toggle" ${blocked && !n.enabled ? 'disabled' : ''}>
        ${n.enabled ? 'إيقاف التنبيهات' : 'تفعيل التنبيهات'}</button>
    </div>
    ${blocked ? '<p class="hint danger-text">التنبيهات محظورة في إعدادات المتصفح لهذا الموقع — اسمح بها من إعدادات الموقع ثم أعد المحاولة.</p>' : ''}
    ${list.length ? `<h3>تذكيرات قائمة الآن</h3>
      <ul class="reminders">${list.map((r) => `<li><strong>${escapeHTML(r.title)}</strong> — ${escapeHTML(r.body)}</li>`).join('')}</ul>`
      : '<p class="hint">لا تذكيرات مستحقّة اليوم.</p>'}
    <p class="hint">حدٌّ تقني يلزم أن تعرفه: المتصفح لا يوقظ التطبيق وهو مغلق ما لم يوجد خادم دفع،
      فالتنبيهات تظهر حين تفتحه أو يكون عاملًا في الخلفية. وعلى الآيفون لا تعمل إلا بعد
      <strong>«إضافة إلى الشاشة الرئيسية»</strong>.</p>`;
}

/** مبدّل أقسامٍ داخل الشاشة — أرخص من وجهةٍ مستقلّة لكل قسم. */
export function segmented(tabs, active) {
  return `<nav class="segmented">${tabs.map((t) => `
    <a href="#${t.id}" class="${t.id === active ? 'on' : ''}" ${t.id === active ? 'aria-current="page"' : ''}>${escapeHTML(t.ar)}</a>`).join('')}</nav>`;
}

/**
 * سكربت أداة الشاشة لتطبيق Scriptable.
 * يُبنى بالرابط مضمَّنًا فيه، فلا يبقى على المستخدم إلا اللصق والتسمية.
 * ولا يستعمل شيئًا من واجهات المتصفح: بيئة Scriptable ليست متصفحًا.
 */
export function scriptableSource(url) {
  return `// ميزانيتي — أداة الشاشة
// الصقه في Scriptable، سمِّه «ميزانيتي»، ثم أضف أداةً متوسطة واخترها.

const URL_ = ${JSON.stringify(url)};
const APP_ = ${JSON.stringify(location.origin)};

const money = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const OK = new Color('#22c55e'), WARN = new Color('#f59e0b'), BAD = new Color('#ef4444'), DIM = new Color('#9ca3af');

const T = (parent, text, size, color, bold) => {
  const x = parent.addText(text);
  x.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  if (color) x.textColor = color;
  x.rightAlignText();          // العربية تُقرأ من اليمين
  x.lineLimit = 1;             // سطرٌ واحد: الالتفاف يقطع آخر البطاقة
  return x;
};

/**
 * الشريط يُرسم صورةً بعرضٍ يُمرَّر إليه، لا بعرضٍ ثابت: الأداة المتوسطة
 * عريضةٌ قصيرة، وشريطٌ يملأ سطرها كلَّه يُثقلها ويُخرج آخرها عن حدّها.
 */
function bar(w, h, share, color) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  dc.addPath(track);
  dc.setFillColor(new Color('#9ca3af', 0.25));
  dc.fillPath();
  const fw = Math.max(h, Math.min(w, w * share));
  const fill = new Path();
  fill.addRoundedRect(new Rect(0, 0, fw, h), h / 2, h / 2);
  dc.addPath(fill);
  dc.setFillColor(color);
  dc.fillPath();
  return dc.getImage();
}

/**
 * سلّمٌ واحد لكل العلامات: سهمان أخضران لمن دبَّر، وسهمٌ لمن انضبط،
 * ونقطةٌ صفراء لمن بلغ الحافّة، وسهمٌ أحمر لمن تجاوز، وسهمان لمن بَعُد.
 *
 * والنسبة تُقاس بالوتيرة لا بالرصيد: من صرف نصف حدّه في ثلث دورته لم
 * يبقَ له نصف بل تجاوز. والعبارة مشدودةٌ إلى الدرجة، فلا تُجامل: عبارةٌ
 * مشجّعة فوق رقمٍ متجاوزٍ تُفسد الأداة كلَّها ويسقط معها الرقم الصادق.
 */
const LADDER = [
  { max: 0.70, m: '▲▲', c: OK,   s: ['تدبيرٌ ممتاز', 'إمساكٌ حسن', 'دون المعتاد بكثير'] },
  { max: 0.95, m: '▲',  c: OK,   s: ['على المسار', 'منضبطٌ حتى الآن', 'سِر على هذا'] },
  { max: 1.05, m: '●',  c: WARN, s: ['على الحافّة', 'وتيرتُك تقارب حدَّك'] },
  { max: 1.30, m: '▼',  c: BAD,  s: ['فوق المعتاد، خفِّف', 'تجاوزتَ وتيرتك'] },
  { max: Infinity, m: '▼▼', c: BAD, s: ['أوقف غير الضروري', 'الصرف بعيدٌ عن حدّك'] },
];
const grade = (r) => LADDER.find((g) => r <= g.max) || LADDER[LADDER.length - 1];
const sign = (share) => grade(share).m;
// الرصيد يُقاس بحدّه لا بسلّم الوتيرة: تجاوزُ الحدّ أحمرُ ولو بريال
const tone = (share) => share > 1 ? BAD : share > 0.9 ? WARN : OK;

let d = null;
try {
  const req = new Request(URL_);
  req.timeoutInterval = 10;
  const j = await req.loadJSON();
  if (j && j.found !== false) d = j;
} catch (e) { /* بلا اتصال: تبقى الأداة على آخر ما رُسم */ }

const w = new ListWidget();
w.setPadding(12, 13, 12, 13);
w.url = APP_;

if (!d) {
  T(w, 'ميزانيتي', 14, null, true);
  T(w, 'لا يوجد ملخّص بعد — افتح التطبيق', 12, DIM);
} else {
  const share = d.limit > 0 ? d.spent / d.limit : 0;
  const accent = tone(share);

  // ── الصفّ الأعلى: الرقم الكبير يمينًا، وموضع الدورة يسارًا ──
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  const meta = head.addStack();
  meta.layoutVertically();
  T(meta, 'اليوم ' + d.day + ' من ' + d.daysInMonth, 10, DIM);
  T(meta, 'المتوقَّع ' + money(d.projected), 10, DIM);
  head.addSpacer();
  const main = head.addStack();
  main.layoutVertically();
  T(main, 'صُرف هذه الدورة', 10, DIM);
  T(main, money(d.spent) + ' ر.س', 24, null, true);

  w.addSpacer(3);
  const rem = w.addStack();
  rem.addSpacer();
  T(rem, sign(share) + ' ' + (d.remaining < 0 ? 'تجاوزتَ بـ' + money(-d.remaining) : 'بقي ' + money(d.remaining)) + ' من ' + money(d.limit), 11, accent, true);
  w.addSpacer(4);
  w.addImage(bar(300, 7, Math.min(1, share), accent)).imageSize = new Size(300, 7);

  // ── ثلاثة أعمدة: اليوم، الربع، ووُفِّر — تستغلّ عرض الأداة بدل إطالتها ──
  w.addSpacer(8);
  const cols = w.addStack();
  cols.layoutHorizontally();

  const col = (label, value, sp, cap, color, foot) => {
    const c = cols.addStack();
    c.layoutVertically();
    c.size = new Size(92, 0);
    const hasBar = cap > 0;
    const sh = hasBar ? sp / cap : 0;
    const l = c.addStack(); l.addSpacer();
    T(l, (hasBar ? sign(sh) + ' ' : '') + label, 9, DIM);
    const v = c.addStack(); v.addSpacer();
    T(v, value, 13, color || (hasBar ? tone(sh) : null), true);
    // ثالثُ الصفوف: شريطٌ حيث ثمّ سقف، وسندٌ حيث لا سقف — فتستوي الأعمدة
    if (hasBar) {
      c.addSpacer(3);
      c.addImage(bar(92, 5, Math.min(1, sh), tone(sh))).imageSize = new Size(92, 5);
    } else if (foot) {
      const f = c.addStack(); f.addSpacer();
      T(f, foot, 9, DIM);
    }
  };

  // تُقرأ من اليمين: «اليوم» ثم «الربع» ثم «الوتيرة». والوتيرةُ حكمُ الدورة
  // كلِّها: صرفُك منسوبًا إلى ما كان ينبغي أن تكون صرفتَه في يومك هذا.
  // والعبارة تُنتقى بيوم الدورة لا بالعشوائية: العشوائيُّ يرتجف كلما
  // أُنعشت الأداة في اليوم الواحد، فيُفقدها الرصانة.
  const g = grade(d.pace || 0);
  const pcol = cols.addStack();
  pcol.layoutVertically();
  pcol.size = new Size(104, 0);
  const gl = pcol.addStack(); gl.addSpacer();
  T(gl, 'الوتيرة', 9, DIM);
  const gv = pcol.addStack(); gv.addSpacer();
  T(gv, g.m + ' ' + Math.round((d.pace || 0) * 100) + '%', 14, g.c, true);
  const gs = pcol.addStack(); gs.addSpacer();
  T(gs, g.s[(d.day || 0) % g.s.length], 9, g.c, true);
  cols.addSpacer();
  col('الربع', money(d.weekSpent) + ' / ' + money(d.weekLimit), d.weekSpent, d.weekLimit);
  cols.addSpacer();
  col('اليوم', money(d.todaySpent) + ' / ' + money(d.dayLimit), d.todaySpent, d.dayLimit);

  // ── سطرٌ أخير واحد: أكبر مجال، أو تنبيه القِدَم إن كانت الأرقام من أمس ──
  const now = new Date();
  const nowISO = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const stamp = String(d.at || '').slice(0, 10);
  const top = (d.top || [])[0];
  w.addSpacer(6);
  const foot = w.addStack();
  foot.addSpacer();
  if (stamp && stamp !== nowISO) T(foot, '⚠︎ أرقام ' + stamp + ' — افتح التطبيق', 9, WARN);
  else if (top) T(foot, 'أكبر مجال: ' + top.n + ' ' + money(top.a), 9, DIM);
}

if (config.runsInWidget) Script.setWidget(w);
else w.presentMedium();
Script.complete();
`;
}

function widgetBody(state) {
  const w = state.settings?.widget || {};
  if (!w.enabled || !w.token) {
    return `<p class="lead">أداةٌ على شاشة الآيفون تعرض: ما صُرف هذا الشهر، وما بقي من الحدّ، وصرفَ اليوم،
      والتوفير، وأكبر مجال، وآخر عملية.</p>
    <p class="hint">⚠️ تطبيق الويب لا يستطيع صنع أداةٍ على iOS — ذلك حكرٌ على التطبيقات الأصلية. فالطريق تطبيق
      <strong>Scriptable</strong> المجاني، وهو لا يفكّ تشفيرك (لا <code>crypto.subtle</code> في بيئته).
      ولذلك يُرفع <strong>ملخّصٌ مجمَّع بلا تشفير</strong> خلف رمزٍ عشوائي لا يُخمَّن — ولا يُرفع شيء من
      قائمة عملياتك ولا أرصدتك ولا أرقام حساباتك، والخادم نفسه يرفض ما عدا الحقول المجمَّعة.</p>
    <button class="btn primary" data-action="widget-on">فعّل أداة الشاشة</button>`;
  }
  return `
    <p class="lead">الأداة مفعّلة. الملخّص يُحدَّث كلما تغيّرت أرقامك.</p>
    <div class="secret-box"><code class="secret">${escapeHTML(state.widgetUrl || '')}</code>
      <button class="btn tiny" data-action="widget-copy-url">نسخ الرابط</button></div>
    <ol class="steps">
      <li>ثبّت <strong>Scriptable</strong> من App Store.</li>
      <li>اضغط «انسخ السكربت» أدناه، وافتح Scriptable ← <strong>+</strong> ← الصق ← سمِّه «ميزانيتي».</li>
      <li>على الشاشة الرئيسية: مطوّلًا ← <strong>+</strong> ← Scriptable ← اختر الحجم المتوسط،
        ثم اضغط الأداة واختر Script = «ميزانيتي».</li>
    </ol>
    <div class="row gap wrap">
      <button class="btn primary" data-action="widget-copy-script">انسخ السكربت</button>
      <button class="btn danger" data-action="widget-off">أبطِل الأداة وامحُ ملخّصها</button>
    </div>
    <p class="hint">${state.widgetAt ? `آخر نشر: ${escapeHTML(new Date(state.widgetAt).toLocaleString('ar-SA'))}` : 'لم يُنشر بعد — سيُنشر عند أول تغيّر'}
      ${state.widgetError ? `<span class="danger-text"> — ${escapeHTML(state.widgetError)}</span>` : ''}</p>
    <p class="hint">🔒 الرمز مستقلٌّ عن مفتاح المزامنة، فإبطاله لا يمسّها ولا يُستدلّ منه عليها.</p>`;
}

function syncBody(state) {
  const s = state.sync || {};
  if (!s.secret) {
    return `<p class="lead">تعمل الآن على هذا الجهاز فقط.</p>
      <button class="btn primary" data-action="gate-new">أنشئ رمز دخول وزامِن</button>`;
  }
  return `
    <p class="lead">مزامنة تلقائية مفعّلة. افتح الموقع على أي جهاز وأدخل هذا الرمز، فتجد بياناتك كما تركتها.</p>
    <div class="secret-box">
      <code class="secret">${escapeHTML(s.secret)}</code>
      <button class="btn tiny" data-action="sync-copy">نسخ</button>
    </div>
    <p class="hint">⚠️ احفظه في مدير كلمات السرّ. هو مفتاح التشفير نفسه: من يملكه يقرأ بياناتك، ومن يفقده يفقدها — لا نسخة لدينا منه.</p>
    <table class="table compact mt">
      <tbody>
        <tr><td>بصمة الرمز</td><td class="ltr"><code>${escapeHTML(s.fp || '—')}</code></td></tr>
        <tr><td>على هذا الجهاز</td><td class="ltr"><strong>${num(state.transactions.length)}</strong> عملية</td></tr>
        <tr><td>على الخادم</td><td class="ltr">${s.remoteCount == null ? '<span class="muted">لم يُفحص بعد</span>'
          : `<strong class="${s.remoteCount === state.transactions.length ? 'pos' : 'neg'}">${num(s.remoteCount)}</strong> عملية`}</td></tr>
        <tr><td>آخر تحديث</td><td class="ltr">${s.busy ? '⟳ جارٍ…' : s.lastAt ? escapeHTML(new Date(s.lastAt).toLocaleString('ar-SA')) : '—'}</td></tr>
      </tbody>
    </table>
    ${s.status ? `<p class="hint danger-text">${escapeHTML(s.status)}</p>` : ''}
    ${s.remoteCount != null && s.remoteCount !== state.transactions.length
      ? '<p class="hint warn-text">العددان مختلفان — اضغط «حدّث الآن» ليتطابقا.</p>' : ''}
    <p class="hint">قارِن «بصمة الرمز» في جهازيك: إن اختلفت البصمتان فالرمزان مختلفان — وكلٌّ يفتح خزانةً غير الأخرى
      مهما بدا الرمزان متشابهين.</p>
    <div class="row gap wrap">
      <button class="btn" data-action="sync-push" ${s.busy ? 'disabled' : ''}>حدّث الآن</button>
      <button class="btn" data-action="sync-rotate" ${s.busy ? 'disabled' : ''}>بدّل الرمز</button>
      <button class="btn danger" data-action="sign-out">تسجيل الخروج من هذا الجهاز</button>
    </div>`;
}

function numField(id, label, value, placeholder = '') {
  return `<label class="field"><span>${escapeHTML(label)}</span>
    <input type="number" lang="en" id="${id}" value="${value === '' || value == null ? '' : value}" placeholder="${escapeHTML(placeholder)}" step="any"></label>`;
}

function ruleAr(r) {
  if (r.field === 'merchant') return `التاجر: ${r.label || r.value}`;
  if (r.field === 'type') return `نوع العملية: ${TYPES[r.value]?.ar || r.value}`;
  if (r.field === 'amount') return `المبلغ = ${r.value}`;
  return `الوصف يحوي: ${r.value}`;
}
