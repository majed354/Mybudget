// محرّك التحليل: من قائمة عمليات خام إلى صورة إنفاق قابلة لاتخاذ القرار.

import { monthKey, median, percentile, mean, cv, trendSlope, groupBy, sum } from './util.js';
import { CATEGORY_MAP, GROUP_OF, ESSENTIAL_GROUPS, FLEX_GROUPS, TYPES } from './classify.js';

// ── وسم العمليات التي يجب ألّا تُحسب إنفاقًا حقيقيًا ────────────────────────

/**
 * يكشف ثلاثة أنماط تُفسد كل حساب للمصروف إن تُركت:
 *  ١) التحويل بين حسابات المستخدم نفسه — نقل لا صرف.
 *  ٢) العمليات المرتجعة (صادر ثم مرتدّ بالمبلغ نفسه) — تُضاعف الرقم بلا سبب.
 *  ٣) الدفعات الاستثنائية (صرف تمويل، مبالغ ضخمة لمرة واحدة) — تشوّه المتوسط.
 */
export function markExclusions(list, settings) {
  const cfg = settings?.analysis || {};
  for (const t of list) {
    if (t.excludeReason === 'user') continue;
    t.excluded = false;
    t.excludeReason = null;
    t.linkId = null;
  }

  // ١) التحويل الداخلي
  if (cfg.excludeInternal !== false) {
    for (const t of list) {
      if (t.type === 'internal') { t.excluded = true; t.excludeReason = 'internal'; }
    }
    // طرفا التحويل بين حسابين مستورَدين: رقم العملية نفسه، أو مبلغ متطابق بإشارتين متعاكستين
    pairUp(list, (a, b) => a.account !== b.account && a.ref && a.ref === b.ref,
      (a, b) => { a.excluded = b.excluded = true; a.excludeReason = b.excludeReason = 'internal'; });
    pairUp(list, (a, b) => a.account !== b.account && Math.abs(a.amount + b.amount) < 0.01 && daysApart(a, b) <= 2 && !a.excluded && !b.excluded,
      (a, b) => { a.excluded = b.excluded = true; a.excludeReason = b.excludeReason = 'internal'; });
  }

  // ٢) العمليات المرتجعة داخل الحساب نفسه
  if (cfg.excludeReversals !== false) {
    pairUp(list, (a, b) => a.account === b.account && Math.abs(a.amount + b.amount) < 0.01 && daysApart(a, b) <= 3 && !a.excluded && !b.excluded,
      (a, b) => { a.excluded = b.excluded = true; a.excludeReason = b.excludeReason = 'reversal'; });
  }

  // ٣) الاستثنائي: صرف التمويل دائمًا، والمبالغ الضخمة إن فُعّل الخيار
  const spendPerMonth = monthlyTotals(list.filter((t) => !t.excluded));
  const medSpend = median(spendPerMonth.map((m) => m.spend)) || 0;
  const factor = cfg.extraordinaryFactor || 4;
  for (const t of list) {
    if (t.excluded) continue;
    if (t.type === 'financing') { t.excluded = true; t.excludeReason = 'extraordinary'; continue; }
    if (cfg.excludeExtraordinary !== false && medSpend > 0 && Math.abs(t.amount) > factor * medSpend && t.type !== 'salary') {
      t.excluded = true;
      t.excludeReason = 'extraordinary';
    }
  }
  return list;
}

function pairUp(list, match, apply) {
  const used = new Set();
  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (used.has(j)) continue;
      const a = list[i], b = list[j];
      if (Math.sign(a.amount) === Math.sign(b.amount)) continue;
      if (!match(a, b)) continue;
      const link = `${a.id}~${b.id}`;
      a.linkId = b.linkId = link;
      apply(a, b);
      used.add(i); used.add(j);
      break;
    }
  }
}

function daysApart(a, b) {
  return Math.abs((Date.parse(a.date) - Date.parse(b.date)) / 86400000);
}

function monthlyTotals(list) {
  const g = groupBy(list, (t) => monthKey(t.date));
  return [...g.entries()].sort().map(([key, rows]) => ({
    key,
    spend: sum(rows.filter((t) => t.amount < 0).map((t) => -t.amount)),
    income: sum(rows.filter((t) => t.amount > 0).map((t) => t.amount)),
  }));
}

// ── كشف التكرار ───────────────────────────────────────────────────────────

/**
 * عملية متكررة = تظهر في ثلاثة أشهر مختلفة على الأقل بمبلغ متقارب.
 * هذا ما يفصل الالتزام الثابت عن الصرف العابر، وهو أساس تقدير الأريحية.
 */
export function findRecurring(list) {
  const candidates = list.filter((t) => !t.excluded && t.amount < 0);
  const groups = groupBy(candidates, (t) => t.merchantKey || `${t.type}:${Math.round(Math.abs(t.amount))}`);
  const out = [];
  for (const [key, rows] of groups) {
    if (rows.length < 3) continue;
    const months = new Set(rows.map((t) => monthKey(t.date)));
    if (months.size < 3) continue;
    const amounts = rows.map((t) => Math.abs(t.amount));
    const variation = cv(amounts);
    const days = rows.map((t) => Number(t.date.slice(8, 10)));
    const dayStable = Math.max(...days) - Math.min(...days) <= 8;
    // ثابت المبلغ، أو ثابت اليوم — أيّهما تحقّق يكفي لعدّه التزامًا دوريًا
    if (variation > 0.20 && !dayStable) continue;
    out.push({
      key,
      label: rows[0].merchant || TYPES[rows[0].type]?.ar || rows[0].desc?.slice(0, 40) || 'غير معروف',
      type: rows[0].type,
      category: rows[0].category,
      amount: median(amounts),
      count: rows.length,
      months: months.size,
      day: Math.round(median(days)),
      variation,
      total: sum(amounts),
      ids: rows.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.amount * b.months - a.amount * a.months);
}

/** الدخل المتكرر (الراتب وما جرى مجراه) مقابل الوارد العابر. */
export function analyzeIncome(list) {
  const credits = list.filter((t) => !t.excluded && t.amount > 0);
  const salaryTx = credits.filter((t) => t.type === 'salary');
  const groups = groupBy(credits.filter((t) => t.type !== 'salary'), (t) => `${t.type}:${Math.round(t.amount / 100)}`);
  const recurringOther = [];
  for (const [, rows] of groups) {
    const months = new Set(rows.map((t) => monthKey(t.date)));
    if (months.size >= 3 && cv(rows.map((t) => t.amount)) < 0.15) recurringOther.push(...rows);
  }
  const recurring = [...salaryTx, ...recurringOther];
  const recurringIds = new Set(recurring.map((t) => t.id));
  const oneOff = credits.filter((t) => !recurringIds.has(t.id));

  const byMonth = groupBy(recurring, (t) => monthKey(t.date));
  const monthly = [...byMonth.entries()].sort().map(([k, rows]) => ({ key: k, amount: sum(rows.map((t) => t.amount)) }));
  const values = monthly.map((m) => m.amount);

  return {
    median: median(values),
    p25: percentile(values, 0.25),
    mean: mean(values),
    monthly,
    salary: salaryTx.length ? {
      amount: median(salaryTx.map((t) => t.amount)),
      count: salaryTx.length,
      day: Math.round(median(salaryTx.map((t) => Number(t.date.slice(8, 10))))),
    } : null,
    oneOffTotal: sum(oneOff.map((t) => t.amount)),
    oneOffCount: oneOff.length,
    oneOff: oneOff.sort((a, b) => b.amount - a.amount).slice(0, 12),
  };
}

// ── التحليل الشامل ────────────────────────────────────────────────────────

export function analyze(transactions, settings = {}) {
  const list = transactions.slice();
  markExclusions(list, settings);

  const active = list.filter((t) => !t.excluded);
  const spendTx = active.filter((t) => t.amount < 0);
  const monthsMap = groupBy(active, (t) => monthKey(t.date));
  let monthKeys = [...monthsMap.keys()].sort();

  // شهر الطرف الناقص يشوّه المتوسط، فنستبعده من الحسابات (لا من العرض)
  const partial = new Set();
  if (settings?.analysis?.ignoreLastPartialMonth !== false && monthKeys.length > 2) {
    const first = monthKeys[0], last = monthKeys[monthKeys.length - 1];
    const dayOf = (k, pick) => pick(monthsMap.get(k).map((t) => Number(t.date.slice(8, 10))));
    if (dayOf(first, (d) => Math.min(...d)) > 5) partial.add(first);
    if (dayOf(last, (d) => Math.max(...d)) < 25) partial.add(last);
  }

  const months = monthKeys.map((key) => {
    const rows = monthsMap.get(key);
    const byCategory = {};
    const byGroup = {};
    for (const t of rows) {
      if (t.amount >= 0) continue;
      const c = t.category || 'other';
      byCategory[c] = (byCategory[c] || 0) - t.amount;
      const g = GROUP_OF[c] || 'غامض';
      byGroup[g] = (byGroup[g] || 0) - t.amount;
    }
    return {
      key,
      partial: partial.has(key),
      spend: sum(rows.filter((t) => t.amount < 0).map((t) => -t.amount)),
      income: sum(rows.filter((t) => t.amount > 0).map((t) => t.amount)),
      count: rows.length,
      byCategory,
      byGroup,
    };
  });

  const solid = months.filter((m) => !m.partial);
  const spendValues = solid.map((m) => m.spend);

  const income = analyzeIncome(list);
  const recurring = findRecurring(list);

  // المجالات
  const catTotals = new Map();
  for (const t of spendTx) {
    const c = t.category || 'other';
    if (!catTotals.has(c)) catTotals.set(c, { id: c, total: 0, count: 0, monthly: new Map() });
    const e = catTotals.get(c);
    e.total += -t.amount;
    e.count++;
    const mk = monthKey(t.date);
    e.monthly.set(mk, (e.monthly.get(mk) || 0) - t.amount);
  }
  const totalSpend = sum([...catTotals.values()].map((c) => c.total)) || 1;
  const categories = [...catTotals.values()].map((c) => {
    const series = solid.map((m) => c.monthly.get(m.key) || 0);
    // المتوسط الشهري هو الرقم الصادق للمجالات المتقطعة (سفر، صيانة، هدايا)،
    // إذ يعطي الوسيطُ صفرًا لمجالٍ ضخم يظهر في شهرين من اثني عشر.
    return {
      id: c.id,
      ar: CATEGORY_MAP[c.id]?.ar || c.id,
      color: CATEGORY_MAP[c.id]?.color || '#999',
      group: GROUP_OF[c.id] || 'غامض',
      total: c.total,
      count: c.count,
      share: c.total / totalSpend,
      monthlyAvg: c.total / Math.max(1, solid.length),
      monthlyMedian: median(series),
      monthlyMean: mean(series),
      trend: trendSlope(series),
      series,
    };
  }).sort((a, b) => b.total - a.total);

  // التجار
  const merchTotals = new Map();
  for (const t of spendTx) {
    if (!t.merchantKey) continue;
    if (!merchTotals.has(t.merchantKey)) merchTotals.set(t.merchantKey, { key: t.merchantKey, name: t.merchant, total: 0, count: 0, category: t.category, city: t.city });
    const e = merchTotals.get(t.merchantKey);
    e.total += -t.amount;
    e.count++;
  }
  const merchants = [...merchTotals.values()].sort((a, b) => b.total - a.total);

  // ملتزم / مرن / غامض — الأساس الذي يقوم عليه اختبار الأريحية.
  // أقساط التمويل تُستثنى من «الملتزم» لأن محرّك الملاءة يطرحها مستقلةً
  // بوصفها التزامًا قائمًا؛ لو بقيت هنا لطُرحت مرتين وضاع نصف الفائض.
  const catSeries = (pred) => solid.map((m) => sum(Object.entries(m.byCategory).filter(([c]) => pred(c)).map(([, v]) => v)));
  const groupOf = (c) => GROUP_OF[c] || 'غامض';
  const essSeries = catSeries((c) => c !== 'debt' && ESSENTIAL_GROUPS.has(groupOf(c)));
  const flexSeries = catSeries((c) => FLEX_GROUPS.has(groupOf(c)));
  const ambSeries = catSeries((c) => groupOf(c) === 'غامض');

  const uncategorized = sum(spendTx.filter((t) => (t.category || 'other') === 'other').map((t) => -t.amount));

  const balances = latestBalances(transactions);
  const installments = recurring.filter((r) => r.type === 'loan');
  // القسط القائم = ما يُدفع فعلًا في الأشهر الأخيرة، لا مجموع كل قسط ظهر في السنة؛
  // فالقرض المسدَّد أو المُعاد جدولته يظهر مرتين لو جُمعت البنود المتكررة.
  const loanByMonth = new Map();
  for (const t of active) {
    if (t.type !== 'loan' || t.amount >= 0) continue;
    const k = monthKey(t.date);
    loanByMonth.set(k, (loanByMonth.get(k) || 0) - t.amount);
  }
  const recentKeys = solid.slice(-3).map((m) => m.key);
  const recentLoans = recentKeys.map((k) => loanByMonth.get(k) || 0);
  const existingInstallments = recentLoans.length ? median(recentLoans) : 0;

  return {
    months, solidMonths: solid, monthKeys,
    income,
    spend: {
      median: median(spendValues),
      mean: mean(spendValues),
      p75: percentile(spendValues, 0.75),
      p90: percentile(spendValues, 0.9),
      cv: cv(spendValues),
      trend: trendSlope(spendValues),
      total: totalSpend,
    },
    essentials: { p50: median(essSeries), p75: percentile(essSeries, 0.75), series: essSeries },
    // الإنفاق الكلي (عدا الأقساط) في شهر مرتفع فعلي — أساس اختبار الضغط
    stressSpend: percentile(solid.map((m, i) => essSeries[i] + flexSeries[i] + ambSeries[i]), 0.75),
    discretionary: {
      p50: median(flexSeries) + median(ambSeries),
      p75: percentile(flexSeries, 0.75) + percentile(ambSeries, 0.75),
      flexP50: median(flexSeries),
      ambiguousP50: median(ambSeries),
      series: flexSeries,
    },
    categories, merchants, recurring, installments,
    existingInstallments,
    liquidBuffer: balances.total,
    balances,
    spendCV: cv(spendValues),
    savingsRate: income.median > 0 ? (income.median - median(spendValues)) / income.median : 0,
    excluded: {
      internal: list.filter((t) => t.excludeReason === 'internal'),
      reversal: list.filter((t) => t.excludeReason === 'reversal'),
      extraordinary: list.filter((t) => t.excludeReason === 'extraordinary'),
      user: list.filter((t) => t.excludeReason === 'user'),
    },
    coverage: {
      from: monthKeys[0] || null,
      to: monthKeys[monthKeys.length - 1] || null,
      months: months.length,
      solid: solid.length,
      txCount: transactions.length,
      activeCount: active.length,
      uncategorizedShare: totalSpend ? uncategorized / totalSpend : 0,
      uncategorizedAmount: uncategorized,
      // «الغامض» = غير مصنّف + سحب نقدي + تحويلات لأشخاص: مالٌ خرج ولا نعرف وجهته،
      // وهو أخطر ما يشوّه حكم الأريحية لأنه يُحسب إنفاقًا مرنًا افتراضًا.
      ambiguousShare: totalSpend ? sum(categories.filter((c) => c.group === 'غامض').map((c) => c.total)) / totalSpend : 0,
      ambiguousAmount: sum(categories.filter((c) => c.group === 'غامض').map((c) => c.total)),
      accounts: [...new Set(transactions.map((t) => t.account))],
    },
    list,
  };
}

/** آخر رصيد معروف لكل حساب — تقدير السيولة المتاحة. */
export function latestBalances(transactions) {
  const byAcc = groupBy(transactions.filter((t) => isFinite(t.balance)), (t) => t.account);
  const per = {};
  for (const [acc, rows] of byAcc) {
    const last = rows.slice().sort((a, b) => (a.date === b.date ? (a.seq || 0) - (b.seq || 0) : a.date.localeCompare(b.date))).pop();
    per[acc] = { balance: last.balance, asOf: last.date };
  }
  return { per, total: sum(Object.values(per).map((x) => x.balance)) };
}
