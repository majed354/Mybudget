// واجهات العرض — كل دالة تُعيد HTML، والتفاعل يمرّ عبر data-action.

import { money, num, pct, monthLabel, dateLabel, escapeHTML } from './util.js';
import { donut, hbars, monthlyChart, stackedBar, gauge, sparkline } from './charts.js';
import { CATEGORIES, CATEGORY_MAP, TYPES } from './classify.js';
import { VERDICT, VERDICT_AR, installmentOf, effectiveAPR } from './affordability.js';

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
  return `<section class="card ${cls}">
    <header class="card-head"><h2>${escapeHTML(title)}</h2>${actions}</header>
    <div class="card-body">${body}</div>
  </section>`;
}

function empty(msg, action = '') {
  return `<div class="empty"><p>${escapeHTML(msg)}</p>${action}</div>`;
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
    alerts.push(`<li class="warn">${pct(a.coverage.ambiguousShare)} من صرفك «غامض» (${money(a.coverage.ambiguousAmount)}): سحب نقدي وتحويلات لأشخاص وغير مصنّف.
      يُحتسب اليوم إنفاقًا مرنًا، فيقسو حكم الأريحية. <button class="btn tiny" data-action="go-tag">صنّفه</button> — إن كان ادخارًا أو التزامًا فسيتغيّر الحكم جوهريًا.</li>`);
  } else if (a.coverage.uncategorizedShare > 0.10) {
    alerts.push(`<li class="warn">${pct(a.coverage.uncategorizedShare)} من صرفك غير مصنّف (${money(a.coverage.uncategorizedAmount)}). <button class="btn tiny" data-action="go-tag">صنّفه الآن</button> لتدقّ نتيجة الملاءة.</li>`);
  }
  if (a.excluded.internal.length) alerts.push(`<li>استُبعد ${num(a.excluded.internal.length)} تحويلًا بين حساباتك — نقلُ مالٍ لا صرف.</li>`);
  if (a.excluded.reversal.length) alerts.push(`<li>استُبعدت ${num(a.excluded.reversal.length)} عملية مرتجعة (صادرة ثم مرتدّة بالمبلغ نفسه).</li>`);
  if (a.excluded.extraordinary.length) alerts.push(`<li>استُبعدت ${num(a.excluded.extraordinary.length)} دفعة استثنائية (صرف تمويل أو مبلغ ضخم لمرة واحدة). <button class="btn tiny" data-action="go-excluded">راجعها</button></li>`);
  if (a.coverage.solid < 3) alerts.push(`<li class="warn">عدد الأشهر المكتملة ${num(a.coverage.solid)} فقط — النتائج تقديرية حتى تتوفر ثلاثة أشهر فأكثر.</li>`);

  return `
  <div class="grid">
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

// ── ٥) محرّك الملاءة ──────────────────────────────────────────────────────
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
  if (q) {
    const qq = q.toLowerCase();
    rows = rows.filter((t) => `${t.desc} ${t.merchant || ''} ${t.ref || ''} ${t.bankType || ''}`.toLowerCase().includes(qq));
  }
  rows = rows.slice().sort((x, y) => y.date.localeCompare(x.date)).slice(0, 300);

  return `<div class="grid">
    ${card('العمليات', `
      <div class="row wrap gap filters">
        <input id="q" type="search" placeholder="ابحث باسم تاجر أو وصف أو رقم عملية…" value="${escapeHTML(q)}">
        <select id="f-cat"><option value="">كل المجالات</option>${CATEGORIES.map((c) => `<option value="${c.id}" ${state.filter.cat === c.id ? 'selected' : ''}>${c.ar}</option>`).join('')}</select>
        <select id="f-acc"><option value="">كل الحسابات</option>${a.coverage.accounts.map((x) => `<option value="${escapeHTML(x)}" ${state.filter.account === x ? 'selected' : ''}>${escapeHTML(x)}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" id="f-uncat" ${state.filter.onlyUncat ? 'checked' : ''}> غير المصنّف فقط</label>
        <label class="chk"><input type="checkbox" id="f-exc" ${state.filter.onlyExcluded ? 'checked' : ''}> المستبعد فقط</label>
      </div>
      <p class="hint">وسمُك لعملية يُنشئ قاعدة تُطبَّق على كل عمليات التاجر نفسه — فتصنيف مئة عملية يستغرق دقائق.</p>
      ${txTable(rows, { editable: true })}
    `)}
  </div>`;
}

function txTable(rows, { editable = false } = {}) {
  if (!rows.length) return empty('لا توجد عمليات مطابقة.');
  return `<table class="table tx">
    <thead><tr><th>التاريخ</th><th>الحساب</th><th>التاجر / الوصف</th><th>النوع</th><th>المبلغ</th>${editable ? '<th>المجال</th><th></th>' : '<th>المجال</th>'}</tr></thead>
    <tbody>${rows.map((t) => `<tr class="${t.excluded ? 'excluded' : ''}">
      <td class="ltr nowrap">${dateLabel(t.date)}</td>
      <td class="muted">${escapeHTML(t.account)}</td>
      <td class="desc">
        <strong>${escapeHTML(t.merchant || t.bankType || (t.desc || '').slice(0, 40))}</strong>
        ${t.city ? `<span class="muted"> · ${escapeHTML(t.city)}</span>` : ''}
        ${t.excluded ? `<span class="tag amb">مستبعد: ${excuseAr(t.excludeReason)}</span>` : ''}
      </td>
      <td class="nowrap">${TYPES[t.type]?.icon || ''} ${escapeHTML(TYPES[t.type]?.ar || '')}</td>
      <td class="ltr nowrap ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td>
      <td>${editable ? `<select class="cat-select" data-action="set-cat" data-id="${t.id}">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${(t.category || 'other') === c.id ? 'selected' : ''}>${c.ar}</option>`).join('')}
          </select>` : escapeHTML(CATEGORY_MAP[t.category]?.ar || '—')}
        ${t.categorySource === 'user' ? '<span class="dot user" title="وسم يدوي"></span>' : t.categorySource === 'rule' ? '<span class="dot rule" title="بقاعدة"></span>' : ''}
      </td>
      ${editable ? `<td><button class="btn tiny" data-action="toggle-exclude" data-id="${t.id}" title="استبعاد/إرجاع">${t.excluded ? '↩' : '⊘'}</button></td>` : ''}
    </tr>`).join('')}</tbody>
  </table>`;
}

function excuseAr(r) {
  return { internal: 'تحويل داخلي', reversal: 'مرتجع', extraordinary: 'استثنائي', user: 'يدوي' }[r] || '';
}

// ── ٧) الإعدادات ──────────────────────────────────────────────────────────
export function viewSettings(state, a) {
  const s = state.settings;
  const rules = state.rules || [];
  return `<div class="grid">
    ${card('حُرّاس القرار', `
      <p class="hint">هذه السقوف هي ما يفصل «مريح» عن «مع ضغط» عن «غير ملائم». عدّلها لتوافق سياستك.</p>
      <div class="row wrap gap">
        ${numField('p-dbrCap', 'سقف نسبة الاستقطاع ٪', s.policy.dbrCap * 100)}
        ${numField('p-dbrHardCap', 'السقف القاطع ٪', s.policy.dbrHardCap * 100)}
        ${numField('p-instShare', 'أقصى نسبة للقسط من الدخل ٪', s.policy.installmentShareCap * 100)}
        ${numField('p-surplus', 'أدنى فائض متبقٍّ ٪ من الدخل', s.policy.comfortSurplusRatio * 100)}
        ${numField('p-buffer', 'أشهر الاحتياطي الموصى بها', s.policy.minBufferMonths)}
        ${numField('p-maxTerm', 'أقصى مدة تُدرس (شهر)', s.policy.maxTerm)}
      </div>`)}

    ${card('معالجة البيانات', `
      <label class="chk"><input type="checkbox" id="a-internal" ${s.analysis.excludeInternal ? 'checked' : ''}> استبعاد التحويل بين حساباتي</label>
      <label class="chk"><input type="checkbox" id="a-rev" ${s.analysis.excludeReversals ? 'checked' : ''}> استبعاد العمليات المرتجعة</label>
      <label class="chk"><input type="checkbox" id="a-extra" ${s.analysis.excludeExtraordinary ? 'checked' : ''}> استبعاد الدفعات الاستثنائية</label>
      <label class="chk"><input type="checkbox" id="a-partial" ${s.analysis.ignoreLastPartialMonth ? 'checked' : ''}> تجاهل الأشهر ناقصة التغطية في المتوسطات</label>
      ${numField('a-factor', 'حد الاستثنائي = كم ضعفًا من وسيط الشهر', s.analysis.extraordinaryFactor)}`)}

    ${card('تجاوز يدوي لأرقام الملاءة', `
      <p class="hint">اتركها فارغة ليُحتسب الرقم من الكشوف. املأها إن كنت تعرف رقمًا أدق (مثل راتب سيتغيّر، أو إيجار يُدفع نقدًا).</p>
      <div class="row wrap gap">
        ${numField('m-income', 'الدخل الشهري', s.manual.income, 'من الكشف')}
        ${numField('m-essentials', 'الإنفاق الملتزم', s.manual.essentials, 'من الكشف')}
        ${numField('m-discretionary', 'الإنفاق المرن', s.manual.discretionary, 'من الكشف')}
        ${numField('m-installments', 'الأقساط القائمة', s.manual.existingInstallments, 'من الكشف')}
        ${numField('m-buffer', 'السيولة المتاحة', s.manual.liquidBuffer, 'من الكشف')}
      </div>`)}

    ${card(`قواعد التصنيف (${num(rules.length)})`, rules.length ? `<table class="table compact">
      <thead><tr><th>الشرط</th><th>المجال</th><th></th></tr></thead>
      <tbody>${rules.map((r) => `<tr>
        <td>${escapeHTML(ruleAr(r))}</td>
        <td>${escapeHTML(CATEGORY_MAP[r.category]?.ar || r.category)}</td>
        <td><button class="btn tiny danger" data-action="del-rule" data-id="${r.id}">حذف</button></td>
      </tr>`).join('')}</tbody></table>` : empty('لا قواعد بعد — وسم أي عملية من صفحة العمليات يُنشئ قاعدة تلقائيًا.'))}

    ${card('البيانات', `
      <div class="row gap wrap">
        <button class="btn" data-action="export-json">تصدير نسخة كاملة (JSON)</button>
        <button class="btn" data-action="export-csv">تصدير العمليات (CSV)</button>
        <button class="btn" data-action="import-json">استيراد نسخة</button>
        <button class="btn danger" data-action="wipe">مسح كل البيانات</button>
      </div>
      <p class="hint">كل شيء محفوظ في متصفحك (IndexedDB). مسح بيانات الموقع يمحوها، فاحتفظ بنسخة إن أردت.</p>`)}
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
