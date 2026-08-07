// محرّك الملاءة والأريحية: يحوّل صورة الإنفاق الفعلي إلى حكم على طلب التمويل.
// لا يعتمد على الراتب وحده، بل على الفائض الحقيقي بعد الإنفاق المرصود، مع اختبار ضغط.

import { clamp, percentile } from './util.js';

export const VERDICT = {
  COMFORTABLE: 'comfortable', // مقبول بأريحية
  TIGHT: 'tight',             // مقبول مع ضغط
  UNFIT: 'unfit',             // غير ملائم
};

export const VERDICT_AR = {
  comfortable: 'مقبول بأريحية',
  tight: 'مقبول مع ضغط',
  unfit: 'غير ملائم',
};

/** الإعدادات الافتراضية للحُرّاس. كلها قابلة للتعديل من واجهة الإعدادات. */
export const DEFAULT_POLICY = {
  dbrCap: 0.33,            // سقف نسبة الاستقطاع المستهدف (قسط/دخل)
  dbrHardCap: 0.45,        // ما بعده يُعد الطلب غير ملائم مهما كان الفائض
  installmentShareCap: 0.25, // ألا يبتلع القسط الواحد أكثر من ربع الدخل
  comfortSurplusRatio: 0.10, // فائض شهري متبقٍّ لا يقل عن 10٪ من الدخل
  minBufferMonths: 3,       // احتياطي طوارئ بثلاثة أشهر من الالتزام
  maxTerm: 72,              // أقصى مدة تُدرس (شهرًا)
  minTerm: 6,
};

// ── حساب القسط ────────────────────────────────────────────────────────────

/**
 * القسط الشهري.
 * mode = 'reducing' → الربح على الرصيد المتناقص (معدل سنوي APR).
 * mode = 'flat'     → نسبة ربح ثابتة سنوية على كامل المبلغ (السائد في التمويل الشخصي).
 */
export function installmentOf({ amount, months, annualRate = 0, mode = 'reducing' }) {
  if (!(amount > 0) || !(months > 0)) return 0;
  if (mode === 'flat') {
    const total = amount * (1 + annualRate * (months / 12));
    return total / months;
  }
  const i = annualRate / 12;
  if (!i) return amount / months;
  return (amount * i) / (1 - Math.pow(1 + i, -months));
}

export function totalCostOf({ amount, months, annualRate = 0, mode = 'reducing' }) {
  const pmt = installmentOf({ amount, months, annualRate, mode });
  return { installment: pmt, total: pmt * months, profit: pmt * months - amount };
}

/** المعدل السنوي الفعلي (APR) المكافئ لقسط معلوم — عبر بحث ثنائي على IRR. */
export function effectiveAPR({ amount, months, installment }) {
  if (!(amount > 0) || !(months > 0) || !(installment > 0)) return 0;
  if (installment * months <= amount) return 0;
  let lo = 0, hi = 2; // 0٪ .. 200٪ سنويًا
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    const pmt = installmentOf({ amount, months, annualRate: mid, mode: 'reducing' });
    if (pmt > installment) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ── تقييم طلب تمويل ───────────────────────────────────────────────────────

/**
 * @param {object} profile  صورة الوضع المالي المستخرجة من الكشوف أو المُدخلة يدويًا.
 *   income:        {p50, p25}      الدخل الشهري (الوسيط، والسيناريو المتحفظ)
 *   essentials:    {p50, p75}      الإنفاق الملتزم (سكن، فواتير، تعليم، تأمين…)
 *   discretionary: {p50, p75}      الإنفاق المرن (مطاعم، تسوق، ترفيه…)
 *   existingInstallments: number   الأقساط القائمة شهريًا
 *   liquidBuffer:  number          السيولة/المدخرات المتاحة
 *   spendCV:       number          تذبذب الإنفاق الشهري (معامل الاختلاف)
 * @param {object} request  {amount, months, annualRate, mode}
 * @param {object} policy   سياسة الحُرّاس
 */
export function evaluate(profile, request, policy = DEFAULT_POLICY) {
  const P = { ...DEFAULT_POLICY, ...policy };
  const inc50 = num(profile?.income?.p50);
  const inc25 = num(profile?.income?.p25, inc50);
  const ess50 = num(profile?.essentials?.p50);
  const ess75 = num(profile?.essentials?.p75, ess50);
  const dis50 = num(profile?.discretionary?.p50);
  const dis75 = num(profile?.discretionary?.p75, dis50);
  const existing = num(profile?.existingInstallments);
  const buffer = num(profile?.liquidBuffer);
  const spendCV = num(profile?.spendCV);

  const newInst = installmentOf(request);
  const totalInst = existing + newInst;

  // الفائض الأساسي: بالسيناريو المعتاد (الوسيط).
  const baseSurplus = inc50 - ess50 - dis50 - existing - newInst;
  // فائض اختبار الضغط: دخل متحفظ وإنفاق في الربيع الأعلى.
  const stressSurplus = inc25 - ess75 - dis75 - existing - newInst;
  // الفائض قبل التمويل الجديد — يبيّن مقدار ما يبتلعه القسط.
  const surplusBefore = inc50 - ess50 - dis50 - existing;

  const dbr = inc50 > 0 ? totalInst / inc50 : Infinity;
  const instShare = inc50 > 0 ? newInst / inc50 : Infinity;
  const commitAfter = ess50 + newInst + existing;
  const bufferMonths = commitAfter > 0 ? buffer / commitAfter : 0;

  const checks = [
    check('dbr', dbr <= P.dbrCap, `نسبة الاستقطاع الكلية ${fmtPct(dbr)} مقابل سقف ${fmtPct(P.dbrCap)}`, dbr, P.dbrCap),
    check('instShare', instShare <= P.installmentShareCap, `القسط الجديد يمثل ${fmtPct(instShare)} من الدخل مقابل سقف ${fmtPct(P.installmentShareCap)}`, instShare, P.installmentShareCap),
    check('baseSurplus', baseSurplus >= P.comfortSurplusRatio * inc50, `الفائض الشهري بعد القسط ${Math.round(baseSurplus)} ر.س، والمطلوب ${Math.round(P.comfortSurplusRatio * inc50)} ر.س على الأقل`, baseSurplus, P.comfortSurplusRatio * inc50),
    check('stress', stressSurplus >= 0, `فائض اختبار الضغط ${Math.round(stressSurplus)} ر.س (دخل متحفظ وإنفاق مرتفع)`, stressSurplus, 0),
    check('buffer', bufferMonths >= P.minBufferMonths, `الاحتياطي يغطي ${bufferMonths.toFixed(1)} شهر من الالتزام، والموصى به ${P.minBufferMonths}`, bufferMonths, P.minBufferMonths),
  ];

  // ── الحكم: حُرّاس صارمة أولًا، ثم الدرجة المركّبة ─────────────────────
  let verdict;
  const hardFail = baseSurplus < 0 || dbr > P.dbrHardCap || inc50 <= 0;
  if (hardFail) {
    verdict = VERDICT.UNFIT;
  } else if (checks[0].pass && checks[1].pass && checks[2].pass && checks[3].pass) {
    verdict = VERDICT.COMFORTABLE;
  } else {
    verdict = VERDICT.TIGHT;
  }

  const score = comfortScore({ inc50, baseSurplus, stressSurplus, dbr, bufferMonths, spendCV, P });
  // الدرجة لا تُرقّي حكمًا سقط في حارس صارم، لكنها تُنزّل حكمًا هشًّا.
  if (verdict === VERDICT.COMFORTABLE && score < 60) verdict = VERDICT.TIGHT;

  return {
    verdict,
    verdictAr: VERDICT_AR[verdict],
    score: Math.round(score),
    installment: newInst,
    totalInstallments: totalInst,
    totalCost: newInst * (request.months || 0),
    profitCost: newInst * (request.months || 0) - (request.amount || 0),
    dbr, instShare, bufferMonths,
    surplusBefore, baseSurplus, stressSurplus,
    burdenOfSurplus: surplusBefore > 0 ? newInst / surplusBefore : Infinity,
    checks,
    reasons: checks.filter((c) => !c.pass).map((c) => c.msg),
    policy: P,
  };
}

function comfortScore({ inc50, baseSurplus, stressSurplus, dbr, bufferMonths, spendCV, P }) {
  if (inc50 <= 0) return 0;
  const s1 = clamp(baseSurplus / inc50 / 0.25, 0, 1);              // فائض معتاد
  const s2 = clamp((stressSurplus / inc50 + 0.10) / 0.25, 0, 1);   // صمود تحت الضغط
  const s3 = clamp((P.dbrHardCap - dbr) / P.dbrHardCap, 0, 1);     // مساحة الاستقطاع
  const s4 = clamp(bufferMonths / 6, 0, 1);                        // احتياطي الطوارئ
  const s5 = clamp(1 - (spendCV || 0) / 0.5, 0, 1);                // ثبات الإنفاق
  return 100 * (0.35 * s1 + 0.25 * s2 + 0.20 * s3 + 0.10 * s4 + 0.10 * s5);
}

function check(id, pass, msg, value, threshold) { return { id, pass, msg, value, threshold }; }
function num(v, dflt = 0) { return isFinite(v) && v != null ? v : dflt; }
function fmtPct(x) { return isFinite(x) ? `${(x * 100).toFixed(1)}٪` : '—'; }

// ── حلّالات: أقصى مبلغ، وأنسب مدى ─────────────────────────────────────────

/** أكبر مبلغ يبقى عنده الحكم عند المستوى المطلوب لمدة معلومة. */
export function maxAmountFor(profile, { months, annualRate, mode }, target = VERDICT.COMFORTABLE, policy = DEFAULT_POLICY) {
  const ok = (amt) => {
    const v = evaluate(profile, { amount: amt, months, annualRate, mode }, policy).verdict;
    return target === VERDICT.COMFORTABLE ? v === VERDICT.COMFORTABLE : v !== VERDICT.UNFIT;
  };
  if (!ok(1)) return 0;
  let lo = 1, hi = Math.max(1000, (profile?.income?.p50 || 0) * 120);
  if (ok(hi)) return hi;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return Math.floor(lo / 100) * 100;
}

/**
 * يبني جدول المدد ويستخرج «أنسب مدى» للمبلغ المطلوب.
 * الأنسب = أقصر مدة يتحقق عندها الحكم المريح، لأن إطالة المدة تزيد كلفة الربح.
 */
export function planTerms(profile, { amount, annualRate, mode }, policy = DEFAULT_POLICY) {
  const P = { ...DEFAULT_POLICY, ...policy };
  const rows = [];
  for (let m = P.minTerm; m <= P.maxTerm; m++) {
    const req = { amount, months: m, annualRate, mode };
    const ev = evaluate(profile, req, P);
    rows.push({
      months: m,
      installment: ev.installment,
      total: ev.installment * m,
      profit: ev.installment * m - amount,
      verdict: ev.verdict,
      score: ev.score,
      baseSurplus: ev.baseSurplus,
      stressSurplus: ev.stressSurplus,
      dbr: ev.dbr,
    });
  }
  const comfortable = rows.filter((r) => r.verdict === VERDICT.COMFORTABLE);
  const tight = rows.filter((r) => r.verdict === VERDICT.TIGHT);

  let range = null, best = null, level = 'none';
  if (comfortable.length) {
    level = VERDICT.COMFORTABLE;
    range = [comfortable[0].months, comfortable[comfortable.length - 1].months];
    best = comfortable[0]; // أقصر مدة مريحة = أقل كلفة ربح
  } else if (tight.length) {
    level = VERDICT.TIGHT;
    range = [tight[0].months, tight[tight.length - 1].months];
    best = tight.reduce((a, b) => (b.score > a.score ? b : a), tight[0]);
  }

  return {
    rows, comfortable, tight, range, best, level,
    maxComfortableAmount: maxAmountFor(profile, { months: P.maxTerm, annualRate, mode }, VERDICT.COMFORTABLE, P),
    maxTightAmount: maxAmountFor(profile, { months: P.maxTerm, annualRate, mode }, VERDICT.TIGHT, P),
  };
}

/**
 * ماذا يلزم لتحويل «مع ضغط» إلى «مريح»؟
 * يعيد مقدار التخفيض الشهري المطلوب من الإنفاق المرن، أو خفض المبلغ.
 */
export function gapAnalysis(profile, request, policy = DEFAULT_POLICY) {
  const P = { ...DEFAULT_POLICY, ...policy };
  const ev = evaluate(profile, request, P);
  if (ev.verdict === VERDICT.COMFORTABLE) return { needed: 0, ev };

  // كم ريالًا شهريًا يلزم تحريره من الإنفاق المرن؟
  let needed = 0;
  const dis = profile?.discretionary?.p50 || 0;
  for (let cut = 0; cut <= dis; cut += 25) {
    const p2 = {
      ...profile,
      discretionary: {
        p50: Math.max(0, (profile.discretionary?.p50 || 0) - cut),
        p75: Math.max(0, (profile.discretionary?.p75 || 0) - cut),
      },
    };
    if (evaluate(p2, request, P).verdict === VERDICT.COMFORTABLE) { needed = cut; break; }
    needed = null;
  }
  const amountForComfort = maxAmountFor(profile, request, VERDICT.COMFORTABLE, P);
  return { needed, amountForComfort, ev };
}

/** يبني صورة الوضع المالي من مخرجات التحليل، مع إتاحة التجاوز اليدوي. */
export function profileFromAnalytics(a, overrides = {}) {
  const monthlySpend = (a?.months || []).map((m) => m.spend);
  const base = {
    income: { p50: a?.income?.median || 0, p25: a?.income?.p25 || a?.income?.median || 0 },
    essentials: { p50: a?.essentials?.p50 || 0, p75: a?.essentials?.p75 || 0 },
    discretionary: { p50: a?.discretionary?.p50 || 0, p75: a?.discretionary?.p75 || 0 },
    existingInstallments: a?.existingInstallments || 0,
    liquidBuffer: a?.liquidBuffer || 0,
    spendCV: a?.spendCV || 0,
    monthsObserved: monthlySpend.length,
    monthlySpendP90: percentile(monthlySpend, 0.9),
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(a[k] || {}, v);
    else if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
