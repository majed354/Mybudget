// اختبارات المحرّك: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNumber, toISODate, percentile, median, hashTx } from '../src/util.js';
import { rowsToTransactions, verifyBalances, parseCSV, detectHeader, inferColumns, dedupe } from '../src/import.js';
import { classifyType, extractMerchant, applyClassification, guessCategoryFromMerchant, merchantKey } from '../src/classify.js';
import { markExclusions, findRecurring, analyze } from '../src/analytics.js';
import { installmentOf, effectiveAPR, evaluate, planTerms, maxAmountFor, VERDICT, DEFAULT_POLICY } from '../src/affordability.js';

// ── أدوات ─────────────────────────────────────────────────────────────────
test('parseNumber يفهم الفواصل والسالب والأرقام العربية', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('-8.00'), -8);
  assert.equal(parseNumber('(150.25)'), -150.25);
  assert.equal(parseNumber('١٢٣٫٥'), 123.5);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('—'), null);
});

test('toISODate يفهم صيغ البنوك السعودية', () => {
  assert.equal(toISODate('31/03/2026'), '2026-03-31');
  assert.equal(toISODate('2026-03-31'), '2026-03-31');
  assert.equal(toISODate('01/08/2025'), '2025-08-01');
  assert.equal(toISODate('12-MAR-26'), '2026-03-12');
  assert.equal(toISODate('غير تاريخ'), null);
});

test('percentile و median', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([10, 20, 30, 40], 0.75), 32.5);
});

// ── الاستيراد ─────────────────────────────────────────────────────────────
const HEADER = ['رقم', 'التاريخ الميلادي', 'التاريخ الهجري', 'نوع العملية', 'الوصف المختصر', 'مدين', 'دائن', 'صافي الحركة', 'الرصيد', 'الرقم المرجعي'];
const row = (i, date, type, desc, debit, credit, bal, ref) =>
  [String(i), date, '', type, desc, debit, credit, '', bal, ref];

test('detectHeader يتعرّف على عناوين كشف بنك البلاد', () => {
  const h = detectHeader(HEADER);
  assert.ok(h);
  assert.equal(h.date, 1);
  assert.equal(h.hijri, 2);
  assert.equal(h.btype, 3);
  assert.equal(h.debit, 5);
  assert.equal(h.credit, 6);
  assert.equal(h.balance, 8);
  assert.equal(h.ref, 9);
});

test('rowsToTransactions يقرأ المدين والدائن ويستنتج الإشارة', () => {
  const rows = [HEADER,
    row(1, '01/08/2025', 'مشتريات نقاط بيع', 'x', '-43.00', '', '957.00', 'FT1'),
    row(2, '02/08/2025', 'حوالة واردة - بنوك محلية رواتب', 'y', '', '5,000.00', '5,957.00', 'FT2'),
  ];
  const res = rowsToTransactions(rows, { account: 'أ' });
  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions[0].amount, -43);
  assert.equal(res.transactions[1].amount, 5000);
  assert.equal(res.transactions[1].balance, 5957);
  assert.equal(res.skipped, 0);
});

test('الترتيب يُحسم بالأرصدة لا بالتخمين — ملف تنازلي يُعاد ترتيبه', () => {
  // كشف يبدأ بالأحدث: الرصيد ينزل مع تقدّم التاريخ
  const rows = [HEADER,
    row(1, '03/08/2025', 'ش', 'c', '-100.00', '', '800.00', 'F3'),
    row(2, '02/08/2025', 'ش', 'b', '-50.00', '', '900.00', 'F2'),
    row(3, '01/08/2025', 'ش', 'a', '-50.00', '', '950.00', 'F1'),
  ];
  const res = rowsToTransactions(rows, { account: 'أ' });
  assert.equal(res.transactions[0].date, '2025-08-01');
  assert.equal(res.balanceCheck.mismatches, 0, 'يجب أن تتّسق الأرصدة بعد إعادة الترتيب');
});

test('تدقيق الأرصدة يكشف صفًّا مفقودًا', () => {
  const list = [
    { balance: 1000, amount: -100 },
    { balance: 900, amount: -100 },
    { balance: 500, amount: -100 }, // قفزة لا يفسّرها المبلغ
  ];
  const v = verifyBalances(list);
  assert.equal(v.checked, true);
  assert.equal(v.mismatches, 1);
});

test('parseCSV يحترم علامات الاقتباس', () => {
  const rows = parseCSV('a,"b,c",d\n1,2,3\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd']);
  assert.deepEqual(rows[1], ['1', '2', '3']);
});

test('inferColumns يستنتج أعمدة ملف بلا عناوين (نمط CSV البلاد)', () => {
  const rows = [
    ['12/10/1447', '31/03/2026', 'FT26090180003369', '-8.00', '', '28724.76', 'دفع عبر نقاط البيع'],
    ['11/10/1447', '30/03/2026', 'FT26089548024043', '-29.00', '', '29051.26', 'دفع عبر نقاط البيع'],
    ['11/10/1447', '30/03/2026', 'FT26089604259871', '', '9000.00', '29086.26', 'حواله وارده'],
  ];
  const cols = inferColumns(rows);
  assert.ok(cols, 'يجب أن تُستنتج الأعمدة');
  assert.equal(cols.date, 1);
  assert.equal(cols.hijri, 0, 'عمود التاريخ الهجري يُميَّز بسنته');
  assert.equal(cols.debit, 3);
  assert.equal(cols.credit, 4);
  assert.equal(cols.balance, 5);
  assert.equal(cols.ref, 2, 'رقم العملية لا يُخلط بالوصف');
  assert.equal(cols.desc, 6);
});

test('dedupe يمنع تكرار العملية نفسها ويُبقي المتشابهات في اليوم نفسه', () => {
  const rows = [HEADER,
    row(1, '27/05/2026', 'دفع فاتورة سداد', 'x', '-113.00', '', '900.00', ''),
    row(2, '27/05/2026', 'دفع فاتورة سداد', 'x', '-113.00', '', '787.00', ''),
  ];
  const first = rowsToTransactions(rows, { account: 'أ' }).transactions;
  assert.equal(new Set(first.map((t) => t.hash)).size, 2, 'عمليتان متطابقتان في اليوم نفسه ليستا نسخة واحدة');
  const again = rowsToTransactions(rows, { account: 'أ' }).transactions;
  const { fresh } = dedupe(again, first.map((t) => t.hash));
  assert.equal(fresh.length, 0, 'إعادة استيراد الملف نفسه لا تضيف شيئًا');
});

test('تكرار الرقم المرجعي لا يبتلع أقساطًا حقيقية', () => {
  // بنك البلاد يضع رقم العقد في أقساط التمويل، فيتكرر الرقم نفسه كل شهر
  const rows = [HEADER,
    row(1, '27/08/2025', 'سداد قسط تمويل', 'قسط', '-3473.65', '', '18919.24', 'LD2105200091'),
    row(2, '28/09/2025', 'سداد قسط تمويل', 'قسط', '-3473.65', '', '15445.59', 'LD2105200091'),
    row(3, '27/10/2025', 'سداد قسط تمويل', 'قسط', '-3473.65', '', '11971.94', 'LD2105200091'),
  ];
  const list = rowsToTransactions(rows, { account: 'أ' }).transactions;
  assert.equal(new Set(list.map((t) => t.hash)).size, 3, 'ثلاثة أقساط في ثلاثة أشهر ليست عملية واحدة');
  const { fresh } = dedupe(list, []);
  assert.equal(fresh.length, 3);
  // وإعادة استيراد الملف نفسه لا تُضيف شيئًا
  const again = rowsToTransactions(rows, { account: 'أ' }).transactions;
  assert.equal(dedupe(again, list.map((t) => t.hash)).fresh.length, 0);
});

// ── التصنيف ───────────────────────────────────────────────────────────────
test('classifyType يفرّق بين أنواع عمليات البنك', () => {
  assert.equal(classifyType('', -50, 'مشتريات نقاط بيع'), 'pos');
  assert.equal(classifyType('', 20853, 'حوالة واردة - بنوك محلية رواتب'), 'salary');
  assert.equal(classifyType('', -1000, 'تحويل من حساب لحساب'), 'internal');
  assert.equal(classifyType('', -3473, 'سداد قسط تمويل'), 'loan');
  assert.equal(classifyType('', -624, 'دفع فاتورة سداد'), 'bill');
  assert.equal(classifyType('', -1600, 'سحب آلي'), 'atm_out');
  assert.equal(classifyType('', -2105, 'أمر مستديم - حوالة صادرة داخلية'), 'standing_order');
  assert.equal(classifyType('', -5000, 'حوالة فورية صادرة'), 'transfer_out');
});

test('extractMerchant يستخرج الاسم والمدينة من نص الكشف المبعثر', () => {
  const details = ['مشتريات نقاط بيع',
    'badr + 8132532202077643 + مؤسسة الراجحي المصرفية للاستثمار',
    'الرقم المرجعيMAKKAH : موقع قناة تقديم الخدمةbawazeev est',
    'FT25213111000593 + 521309045870 / :للعملية'].join('\n');
  const m = extractMerchant({ details });
  assert.match(m.name, /bawazeev/i);
  assert.equal(m.city, 'MAKKAH');
  assert.ok(!/الراجحي|الرقم المرجعي/.test(m.name), 'يجب تنظيف اسم البنك والعبارات النمطية');
});

test('قاموس التجار يصنّف الأسماء الشائعة', () => {
  assert.equal(guessCategoryFromMerchant('AMAZON SA'), 'shopping');
  assert.equal(guessCategoryFromMerchant('Keeta'), 'dining');
  assert.equal(guessCategoryFromMerchant('RESTURANT ALANWAR'), 'dining');
  assert.equal(guessCategoryFromMerchant('ADAM PHARMACY'), 'health');
  assert.equal(guessCategoryFromMerchant('SPORTS AL FORSAN YOUTH'), 'sports');
  assert.equal(guessCategoryFromMerchant('اسم لا يعرفه القاموس'), null);
});

test('وسم المستخدم لا تدهسه القواعد الآلية', () => {
  const tx = [{ id: '1', date: '2026-01-01', amount: -50, desc: '', bankType: 'مشتريات نقاط بيع', details: 'Keeta', category: 'travel', categorySource: 'user' }];
  applyClassification(tx, []);
  assert.equal(tx[0].category, 'travel');
});

test('القواعد ووسمُ الحسابات تسري تلقائيًا على كشفٍ يُرفع لاحقًا', () => {
  // ما يتعلّمه النظام من كشف أغسطس يجب أن يُطبَّق على كشف سبتمبر بلا تدخّل
  const rules = [
    { id: 'r1', field: 'merchant', op: 'key', value: merchantKey('NJAIM SAADI'), category: 'dining', priority: 10 },
    { id: 'r2', field: 'type', op: 'equals', value: 'atm_out', category: 'groceries', priority: 5 },
  ];
  const own = { ibans: ['SA6680000409608010079587'], merchants: [merchantKey('STC Pay')] };

  const later = [
    { id: '1', date: '2026-09-03', amount: -180, bankType: 'مشتريات نقاط بيع', details: 'مشتريات نقاط بيع\nNJAIM SAADI' },
    { id: '2', date: '2026-09-05', amount: -700, bankType: 'سحب آلي', details: 'سحب آلي\nAL RAJHI BANK' },
    { id: '3', date: '2026-09-08', amount: -9000, bankType: 'حوالة فورية صادرة', details: 'حوالة فورية صادرة\nSA6680000409608010079587' },
    { id: '4', date: '2026-09-09', amount: -500, bankType: 'مشتريات نقاط بيع', details: 'مشتريات نقاط بيع\nSABS2I43 + STC Pay + البنك السعودي البريطاني' },
    { id: '5', date: '2026-09-11', amount: -60, bankType: 'مشتريات نقاط بيع', details: 'مشتريات نقاط بيع\nADAM PHARMACY' },
  ];
  applyClassification(later, rules, own);

  assert.equal(later[0].category, 'dining', 'قاعدة التاجر تسري على الكشف الجديد');
  assert.equal(later[1].category, 'groceries', 'قاعدة نوع العملية تسري كذلك');
  assert.equal(later[2].type, 'internal', 'الآيبان الموسوم بأنه حسابك يخرج من الصرف');
  assert.equal(later[3].type, 'internal', 'المحفظة الموسومة تخرج كذلك');
  assert.equal(later[4].category, 'health', 'وما لم تُوسمه يلتقطه القاموس المدمج');

  const a = analyze(later, { analysis: {}, ownAccounts: own });
  const spent = a.categories.reduce((s, c) => s + c.total, 0);
  assert.equal(Math.round(spent), 940, 'المستبعد لا يدخل في الصرف: 180+700+60 فقط');
});

// ── الاستبعادات ───────────────────────────────────────────────────────────
test('التحويل بين حسابين برقم عملية واحد يُستبعد من الطرفين', () => {
  const list = [
    { id: 'a', account: 'أ', date: '2025-08-10', amount: -1010, ref: 'FT1', type: 'internal' },
    { id: 'b', account: 'ب', date: '2025-08-10', amount: 1010, ref: 'FT1', type: 'internal' },
  ];
  markExclusions(list, { analysis: {} });
  assert.ok(list.every((t) => t.excluded && t.excludeReason === 'internal'));
});

test('العملية المرتجعة تُستبعد مع أصلها فلا تُحتسب صرفًا', () => {
  const list = [
    { id: 'a', account: 'أ', date: '2026-01-01', amount: -1500.58, type: 'transfer_out' },
    { id: 'b', account: 'أ', date: '2026-01-01', amount: 1500.58, type: 'transfer_in' },
    { id: 'c', account: 'أ', date: '2026-01-02', amount: -200, type: 'pos' },
  ];
  markExclusions(list, { analysis: {} });
  assert.equal(list[0].excluded, true);
  assert.equal(list[1].excluded, true);
  assert.equal(list[2].excluded, false, 'العملية العادية تبقى محسوبة');
});

test('صرف التمويل لا يُحتسب دخلًا', () => {
  const list = [{ id: 'a', account: 'أ', date: '2026-06-11', amount: 352638.25, type: 'financing' }];
  markExclusions(list, { analysis: {} });
  assert.equal(list[0].excludeReason, 'extraordinary');
});

test('findRecurring يرصد الالتزام الشهري الثابت', () => {
  const list = [];
  for (let m = 1; m <= 6; m++) {
    list.push({ id: `s${m}`, account: 'أ', date: `2026-0${m}-28`, amount: -2105.75, type: 'standing_order', category: 'support', excluded: false });
    list.push({ id: `p${m}`, account: 'أ', date: `2026-0${m}-0${m}`, amount: -(10 * m), type: 'pos', merchantKey: `RAND${m}`, category: 'dining', excluded: false });
  }
  const rec = findRecurring(list);
  const so = rec.find((r) => r.type === 'standing_order');
  assert.ok(so, 'يجب رصد الأمر المستديم');
  assert.equal(so.months, 6);
  assert.equal(Math.round(so.amount), 2106);
});

// ── حساب القسط ────────────────────────────────────────────────────────────
test('القسط بالنسبة الثابتة على أصل المبلغ', () => {
  // 100,000 بنسبة 5٪ سنويًا لخمس سنوات: الإجمالي 125,000 والقسط 2,083.33
  const pmt = installmentOf({ amount: 100000, months: 60, annualRate: 0.05, mode: 'flat' });
  assert.ok(Math.abs(pmt - 2083.33) < 0.01, `القسط ${pmt}`);
});

test('القسط على الرصيد المتناقص يطابق دالة الأقساط المعيارية', () => {
  const pmt = installmentOf({ amount: 100000, months: 60, annualRate: 0.06, mode: 'reducing' });
  assert.ok(Math.abs(pmt - 1933.28) < 0.05, `القسط ${pmt}`);
});

test('بلا ربح، القسط = المبلغ ÷ المدة', () => {
  assert.equal(installmentOf({ amount: 12000, months: 12, annualRate: 0, mode: 'reducing' }), 1000);
  assert.equal(installmentOf({ amount: 12000, months: 12, annualRate: 0, mode: 'flat' }), 1000);
});

test('المعدل الفعلي يعكس القسط المحسوب (رحلة ذهاب وعودة)', () => {
  const amount = 80000, months = 48, apr = 0.075;
  const pmt = installmentOf({ amount, months, annualRate: apr, mode: 'reducing' });
  const back = effectiveAPR({ amount, months, installment: pmt });
  assert.ok(Math.abs(back - apr) < 0.001, `${back} ≠ ${apr}`);
});

test('النسبة الثابتة أغلى من ظاهرها: 6٪ ثابتة ≈ 11٪ فعلية', () => {
  const amount = 100000, months = 60;
  const pmt = installmentOf({ amount, months, annualRate: 0.06, mode: 'flat' });
  const apr = effectiveAPR({ amount, months, installment: pmt });
  assert.ok(apr > 0.10 && apr < 0.12, `المعدل الفعلي ${apr}`);
});

// ── الحكم على الملاءة ─────────────────────────────────────────────────────
const RICH = {
  income: { p50: 25000, p25: 25000 },
  essentials: { p50: 6000, p75: 6500 },
  discretionary: { p50: 4000, p75: 5000 },
  existingInstallments: 0,
  liquidBuffer: 60000,
  spendCV: 0.1,
};

test('طلب صغير على دخل مرتفع = مقبول بأريحية', () => {
  const ev = evaluate(RICH, { amount: 50000, months: 60, annualRate: 0.05, mode: 'flat' });
  assert.equal(ev.verdict, VERDICT.COMFORTABLE);
  assert.ok(ev.baseSurplus > 0);
  assert.ok(ev.checks.every((c) => c.pass));
});

test('تجاوز سقف الاستقطاع مع بقاء فائض = مقبول مع ضغط', () => {
  const ev = evaluate(RICH, { amount: 500000, months: 60, annualRate: 0.05, mode: 'flat' });
  assert.equal(ev.verdict, VERDICT.TIGHT);
  assert.ok(ev.dbr > DEFAULT_POLICY.dbrCap);
  assert.ok(ev.baseSurplus >= 0);
});

test('استنفاد الفائض = غير ملائم', () => {
  const ev = evaluate(RICH, { amount: 900000, months: 60, annualRate: 0.05, mode: 'flat' });
  assert.equal(ev.verdict, VERDICT.UNFIT);
  assert.ok(ev.baseSurplus < 0);
});

test('الحكم يقوم على الإنفاق الفعلي لا على الراتب وحده', () => {
  const spender = { ...RICH, discretionary: { p50: 16000, p75: 18000 } };
  const req = { amount: 100000, months: 60, annualRate: 0.05, mode: 'flat' };
  assert.equal(evaluate(RICH, req).verdict, VERDICT.COMFORTABLE);
  assert.notEqual(evaluate(spender, req).verdict, VERDICT.COMFORTABLE,
    'نفس الراتب ونفس القسط، لكن إنفاقًا أعلى ⇒ حكمًا مختلفًا');
});

test('اختبار الضغط يُنزل الحكم عند تذبذب الدخل', () => {
  const shaky = { ...RICH, income: { p50: 25000, p25: 15000 } };
  const req = { amount: 200000, months: 60, annualRate: 0.05, mode: 'flat' };
  const stable = evaluate(RICH, req);
  const unstable = evaluate(shaky, req);
  assert.ok(unstable.stressSurplus < stable.stressSurplus);
  assert.ok(unstable.score < stable.score);
});

test('الأقساط القائمة تُحتسب في نسبة الاستقطاع', () => {
  const loaded = { ...RICH, existingInstallments: 5000 };
  const req = { amount: 100000, months: 60, annualRate: 0.05, mode: 'flat' };
  assert.ok(evaluate(loaded, req).dbr > evaluate(RICH, req).dbr);
});

test('planTerms يختار أقصر مدة مريحة (أقل كلفة ربح)', () => {
  const plan = planTerms(RICH, { amount: 150000, annualRate: 0.05, mode: 'flat' });
  assert.ok(plan.range, 'يجب أن يوجد نطاق');
  assert.equal(plan.best.months, plan.range[0]);
  assert.equal(plan.best.verdict, VERDICT.COMFORTABLE);
  const longer = plan.rows.find((r) => r.months === plan.best.months + 12);
  if (longer) assert.ok(longer.profit > plan.best.profit, 'المدة الأطول أغلى');
});

test('maxAmountFor يجد الحد الذي ينقلب عنده الحكم', () => {
  const max = maxAmountFor(RICH, { months: 60, annualRate: 0.05, mode: 'flat' }, VERDICT.COMFORTABLE);
  assert.ok(max > 0);
  const atMax = evaluate(RICH, { amount: max, months: 60, annualRate: 0.05, mode: 'flat' });
  const above = evaluate(RICH, { amount: max + 20000, months: 60, annualRate: 0.05, mode: 'flat' });
  assert.equal(atMax.verdict, VERDICT.COMFORTABLE);
  assert.notEqual(above.verdict, VERDICT.COMFORTABLE);
});

test('دخل صفر لا يكسر المحرّك', () => {
  const ev = evaluate({ income: { p50: 0, p25: 0 }, essentials: {}, discretionary: {} }, { amount: 10000, months: 12, annualRate: 0.05, mode: 'flat' });
  assert.equal(ev.verdict, VERDICT.UNFIT);
  assert.equal(ev.score, 0);
});

// ── التحليل من طرف إلى طرف ────────────────────────────────────────────────
test('analyze يبني صورة متسقة من كشف مُصطنع', () => {
  const tx = [];
  let seq = 0;
  for (let m = 1; m <= 6; m++) {
    const mm = String(m).padStart(2, '0');
    tx.push({ id: `sal${m}`, seq: seq++, account: 'أ', date: `2026-${mm}-27`, amount: 20000, desc: '', bankType: 'حوالة واردة - بنوك محلية رواتب', balance: 0 });
    tx.push({ id: `so${m}`, seq: seq++, account: 'أ', date: `2026-${mm}-28`, amount: -2000, desc: '', bankType: 'أمر مستديم - حوالة صادرة داخلية', balance: 0 });
    tx.push({ id: `ln${m}`, seq: seq++, account: 'أ', date: `2026-${mm}-27`, amount: -3000, desc: '', bankType: 'سداد قسط تمويل', balance: 0 });
    tx.push({ id: `f${m}`, seq: seq++, account: 'أ', date: `2026-${mm}-15`, amount: -1200, desc: '', bankType: 'مشتريات نقاط بيع', details: 'RESTURANT ALANWAR', balance: 0 });
  }
  applyClassification(tx, []);
  const a = analyze(tx, { analysis: {} });
  assert.equal(a.income.median, 20000);
  assert.equal(a.income.salary.amount, 20000);
  assert.equal(a.spend.median, 6200);
  assert.equal(a.existingInstallments, 3000, 'القسط القائم من الأشهر الأخيرة');
  assert.ok(a.categories.find((c) => c.id === 'dining'));
  assert.ok(Math.abs(a.savingsRate - (20000 - 6200) / 20000) < 1e-9);
});

// ── ما كشفه كشف الراجحي ───────────────────────────────────────────────────

test('صفّ العناوين خلف ديباجةٍ طويلة يُعثر عليه', () => {
  // كشف الراجحي يضع عنوانه في الصف السادس عشر بعد اسم العميل والرصيد
  // ومعايير البحث؛ وكانت النافذة خمسة صفوف عند اختيار الورقة وخمسةَ عشرَ
  // عند القراءة، فيُرفض الكشف كاملًا: صفر عملية بلا سببٍ مفهوم.
  const preamble = Array.from({ length: 15 }, () => ['', '', 'ديباجة', '']);
  const rows = [
    ...preamble,
    ['الرصيد', '', 'مدين', 'دائن', '', '', 'التاريخ الهجري', '', '', 'التاريخ الميلادي', '', '', '', '', 'البيان', ''],
    ['SAR 2,006.02', '', 'SAR -2,984.44', ' ', '', '', '23-02-1448', '', '', '06-08-2026', '', '', '', '', 'خصم مستحقات البطاقات الائتمانية', ''],
    ['SAR 4,990.46', '', '', 'SAR 5,000.00', '', '', '24-02-1448', '', '', '05-08-2026', '', '', '', '', 'حوالة فورية واردة', ''],
  ];
  const res = rowsToTransactions(rows, { account: 'الراجحي' });
  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions.find((t) => t.date === '2026-08-06').amount, -2984.44, 'المدين سالب');
  assert.equal(res.transactions.find((t) => t.date === '2026-08-05').amount, 5000, 'الدائن موجب');
});

test('العملة قبل الرقم لا تبتلع الإشارة السالبة', () => {
  // «SAR -2,984.44» لا يبدأ بـ«-» فكان فحص الإشارة يخطئه ثم تُمحى مع الحروف،
  // فينقلب المدين دائنًا في أي كشفٍ عموده مبلغٌ موحَّد
  assert.equal(parseNumber('SAR -2,984.44'), -2984.44);
  assert.equal(parseNumber('  SAR -1.15  '), -1.15);
  assert.equal(parseNumber('SAR 2,006.02'), 2006.02);
  assert.equal(parseNumber('ر.س -50.00'), -50);
  assert.equal(parseNumber('(1,200.00) SAR'), -1200, 'القوسان يبقيان سالبين');
  assert.equal(parseNumber('1,200.00-'), -1200, 'والإشارة اللاحقة كذلك');
});

test('نقطة التحوّل: التحويل إلى حساباتك صرفٌ قبلها، ونقلٌ بعدها', () => {
  // قبل أتمتة الرسائل لا تصل تفاصيل الراجحي، فالتحويل إليه هو الصرف نفسه.
  // وبعدها تصل المشتريات مفصَّلة، فاحتساب التحويل يُحصي الريال مرتين.
  const rows = () => ([
    { id: '1', date: '2026-06-10', amount: -5000, type: 'internal', account: 'البلاد', desc: 'إلى حسابي في الراجحي' },
    { id: '2', date: '2026-09-10', amount: -5000, type: 'internal', account: 'البلاد', desc: 'إلى حسابي في الراجحي' },
  ]);

  const before = rows();
  markExclusions(before, { analysis: { ownTransfersSpendUntil: '2026-08-01' } });
  assert.equal(before[0].excluded, false, 'ما قبل التاريخ يبقى صرفًا محسوبًا');
  assert.equal(before[1].excluded, true, 'وما بعده يُستبعد لأن تفصيله يصل من الرسائل');

  // فارغٌ = السلوك السابق: استبعادٌ دائم
  const always = rows();
  markExclusions(always, { analysis: {} });
  assert.ok(always.every((t) => t.excluded), 'بلا تاريخٍ يُستبعد الداخلي كله كما كان');

  // وإطفاء الاستبعاد كليًّا يبقى مُطاعًا
  const off = rows();
  markExclusions(off, { analysis: { excludeInternal: false, ownTransfersSpendUntil: '2026-08-01' } });
  assert.ok(off.every((t) => !t.excluded));
});

// ── صورة الشهر الجاري ─────────────────────────────────────────────────────

test('صورة الشهر: ما صُرف، وما بقي من الحدّ، والوتيرة، والمتوقَّع', async () => {
  const { cycleSnapshot: monthSnapshot } = await import('../src/analytics.js');
  const a = {
    months: [{ key: '2026-08', spend: 6000, income: 20000, byCategory: { groceries: 3000, dining: 2000, transport: 1000 } }],
    spend: { median: 12000 },
  };
  // اليوم العاشر من واحدٍ وثلاثين، والحدّ ١٢ ألفًا
  const m = monthSnapshot(a, { today: '2026-08-10', limit: 12000 });
  assert.equal(m.spent, 6000);
  assert.equal(m.remaining, 6000);
  assert.equal(+m.usedShare.toFixed(3), 0.5);
  assert.equal(m.saved, 14000);
  // المفترَض حتى اليوم = ١٢٠٠٠ × ١٠/٣١ ≈ ٣٨٧١، فالوتيرة ضِعفٌ ونصف تقريبًا
  assert.ok(m.pace > 1.5, `الوتيرة ${m.pace} يجب أن تكشف التسرّع`);
  assert.equal(Math.round(m.projected), 18600, 'مدُّ الوتيرة إلى آخر الشهر');
  assert.equal(Math.round(m.overBy), 6600);
  assert.deepEqual(m.top.map((c) => c.id), ['groceries', 'dining', 'transport']);
  assert.equal(+m.top[0].share.toFixed(2), 0.5);
});

test('بلا حدٍّ مضبوط يُشتقّ من وسيط الصرف فيبقى العدّاد ذا معنى', async () => {
  const { cycleSnapshot: monthSnapshot } = await import('../src/analytics.js');
  const a = { months: [{ key: '2026-08', spend: 1000, income: 0, byCategory: {} }], spend: { median: 9000 } };
  const m = monthSnapshot(a, { today: '2026-08-15', limit: null });
  assert.equal(m.limit, 9000);
  assert.equal(m.limitIsDerived, true);
  assert.equal(m.savedShare, null, 'لا دخل ⇒ لا نسبة ادخار تُعرض');
});

test('شهرٌ بلا عمليات لا يكسر الصورة', async () => {
  const { cycleSnapshot: monthSnapshot } = await import('../src/analytics.js');
  const a = { months: [{ key: '2026-07', spend: 500, income: 0, byCategory: {} }], spend: { median: 4000 } };
  const m = monthSnapshot(a, { today: '2026-08-03', limit: 4000 });
  assert.equal(m.spent, 0);
  assert.equal(m.remaining, 4000);
  assert.equal(m.top.length, 0);
  assert.equal(monthSnapshot(null, { today: '2026-08-03' }), null);
});

// ── ما كشفه تصدير أغسطس إلى CSV ───────────────────────────────────────────

test('كشفٌ بلا عمود رصيد لا يُنتج إنذار تدقيقٍ كاذبًا', () => {
  // `isFinite(null)` صحيحة في جافاسكربت، فكان الرصيد المعدوم يُقرأ صفرًا،
  // فتخرج فروقٌ بعدد الصفوف في أداةٍ حجّتها تدقيق الأرصدة
  const rows = [
    ['التاريخ الميلادي', 'البيان', 'مدين', 'دائن'],
    ['2026-08-02', 'شراء نقاط بيع - SASCO', '110.00', ''],
    ['2026-08-03', 'شراء نقاط بيع - X', '20.00', ''],
    ['2026-08-04', 'شراء نقاط بيع - Y', '30.00', ''],
    ['2026-08-05', 'شراء نقاط بيع - Z', '40.00', ''],
  ];
  const res = rowsToTransactions(rows, { account: 'بلا رصيد' });
  assert.equal(res.transactions.length, 4);
  assert.equal(res.balanceCheck.checked, false, 'لا رصيد ⇒ لا تدقيق، لا تدقيقٌ فاشل');
  assert.deepEqual(res.warnings, []);
});

test('سداد بطاقتك من كشفك تحويلٌ داخلي لا مصروف', () => {
  assert.equal(classifyType('سداد بطاقة ائتمانية'), 'internal');
  assert.equal(classifyType('خصم مستحقات البطاقات الائتمانية'), 'internal');
  // ولا يبتلع سدادَ القسط ولا الفاتورة
  assert.equal(classifyType('سداد قسط تمويل'), 'loan');
  assert.equal(classifyType('سداد فاتورة كهرباء'), 'bill');
});

test('الشراء الإلكتروني يُعرف بصيغ المصارف الثلاثة', () => {
  for (const d of ['مشتريات انترنت - Keeta', 'مشتريات إنترنت', 'شراء إنترنت', 'عملية انترنت']) {
    assert.equal(classifyType(d), 'ecom', d);
  }
});

test('عبارة النوع تُقطع عن اسم التاجر فيُطابق القاموس', () => {
  const m = extractMerchant({ desc: 'مشتريات انترنت - OPENAI' });
  assert.equal(m.name, 'OPENAI', 'وإلا بقيت العبارة فأفسدت تجميع التاجر');
  assert.equal(guessCategoryFromMerchant('OPENAI'), 'subs');
  assert.equal(guessCategoryFromMerchant('ANTHRO'), 'subs');
  assert.equal(guessCategoryFromMerchant('Udemy'), 'education');
  assert.equal(guessCategoryFromMerchant('RKAEZ ALA'), 'groceries');
  assert.equal(guessCategoryFromMerchant('BAJH TRAD'), 'groceries');
  assert.equal(guessCategoryFromMerchant('durah alb'), 'groceries');
});

test('تاريخ اليوم بتوقيت المستخدم لا بتوقيت غرينتش', async () => {
  const { todayISO } = await import('../src/util.js');
  // الرياض تسبق غرينتش بثلاث ساعات: ليلةَ التاسع الساعةَ الواحدة والنصف،
  // `toISOString` يعود بالثامن — فتُعرض «اليوم ٨ من ٣١» ليلةَ التاسع
  const night = new Date('2026-08-09T01:30:00+03:00');
  assert.equal(night.toISOString().slice(0, 10), '2026-08-08', 'هذا ما كان يقع');
  assert.equal(todayISO(night), '2026-08-09', 'وهذا الصواب');

  // وأسوأه ليلةَ أول الشهر: شهرٌ كامل يُعرض على أنه الشهر الجاري
  const first = new Date('2026-09-01T02:00:00+03:00');
  assert.equal(first.toISOString().slice(0, 7), '2026-08');
  assert.equal(todayISO(first).slice(0, 7), '2026-09');

  // وفي منتصف النهار لا فرق بينهما
  const noon = new Date('2026-08-09T12:00:00+03:00');
  assert.equal(todayISO(noon), noon.toISOString().slice(0, 10));
});

// ── التصنيف الدقيق: مجالٌ وصنفٌ فرعي يرثهما كل شراءٍ من المحلّ ────────────

test('الصنف الفرعي يتبع القاعدة فيرثه كل شراءٍ من المحلّ نفسه', async () => {
  const { suggestRule, applyClassification } = await import('../src/classify.js');
  const mk = (id, desc) => ({ id, desc, amount: -20, date: '2026-08-0' + id, account: 'x', bankType: 'مدين' });
  const rows = [mk(1, 'شراء نقاط بيع SALEH ABD'), mk(2, 'شراء نقاط بيع SALEH ABD'), mk(3, 'شراء نقاط بيع OTHER')];
  applyClassification(rows);

  // يُوسم واحدٌ منها، فتُشتقّ منه قاعدةٌ بالمجال والصنف
  const rule = { id: 'r1', priority: 10, ...suggestRule(rows[0], 'dining', 'عصائر') };
  assert.equal(rule.subcategory, 'عصائر');

  applyClassification(rows, [rule]);
  assert.equal(rows[0].subcategory, 'عصائر');
  assert.equal(rows[1].subcategory, 'عصائر', 'ويرثه شراءٌ آخر من المحلّ نفسه');
  assert.equal(rows[1].category, 'dining');
  assert.notEqual(rows[2].subcategory, 'عصائر', 'ولا يتعدّى إلى محلٍّ غيره');
});

test('الأصناف المقترحة: المجهَّز ثم ما أضافه المستخدم بلا تكرار', async () => {
  const { subcategoriesFor } = await import('../src/classify.js');
  const seeded = subcategoriesFor('dining');
  assert.ok(seeded.includes('عصائر'));
  const withMine = subcategoriesFor('dining', { dining: ['عصير طازج بالحيّ', 'عصائر'] });
  assert.ok(withMine.includes('عصير طازج بالحيّ'));
  assert.equal(withMine.filter((s) => s === 'عصائر').length, 1, 'لا يتكرر ما كان مجهَّزًا');
  assert.deepEqual(subcategoriesFor('لا-وجود-له'), [], 'مجالٌ بلا أصناف لا يكسر شيئًا');
});

test('قرار «غير محسوب» يثبت في الاتجاهين', () => {
  const mk = (id, extra) => ({ id, date: '2026-08-01', amount: -100, account: 'a', type: 'pos', ...extra });

  // ما استبعده المستخدم يبقى مستبعدًا ولو لم يرَ المحرّك سببًا
  const a = [mk(1, { userExcluded: true })];
  markExclusions(a, { analysis: {} });
  assert.equal(a[0].excluded, true);
  assert.equal(a[0].excludeReason, 'user');

  // وما أرجعه بيده يبقى محسوبًا ولو رآه المحرّك تحويلًا داخليًّا
  const b = [mk(2, { type: 'internal', userExcluded: false })];
  markExclusions(b, { analysis: {} });
  assert.equal(b[0].excluded, false, 'وإلا وجد المستخدم نقرته لم تُسمع');

  // وبلا قرارٍ منه يبقى الحكم للمحرّك
  const c = [mk(3, { type: 'internal' })];
  markExclusions(c, { analysis: {} });
  assert.equal(c[0].excluded, true);
});

test('قاموس المجالات يشمل الوارد كما يشمل الصادر', async () => {
  const { CATEGORIES, subcategoriesFor, CATEGORY_MAP } = await import('../src/classify.js');
  const income = CATEGORIES.filter((c) => c.group === 'دخل');
  assert.ok(income.length >= 8, `مجالات الدخل ${income.length}`);
  assert.equal(CATEGORY_MAP.salary.ar, 'راتب');
  assert.ok(subcategoriesFor('salary').includes('بدل سكن'));
  assert.ok(subcategoriesFor('refund_in').includes('كاش باك'));
  // ولا تدخل مجالاتُ الدخل في مجموعات الصرف فتُفسد المتوسطات
  const { ESSENTIAL_GROUPS, FLEX_GROUPS, AMBIGUOUS_GROUPS } = await import('../src/classify.js');
  for (const c of income) {
    assert.ok(!ESSENTIAL_GROUPS.has(c.group) && !FLEX_GROUPS.has(c.group) && !AMBIGUOUS_GROUPS.has(c.group), c.id);
  }
});

// ── دورة الميزانية: شهرٌ ماليّ يبدأ يوم الراتب ────────────────────────────

test('الدورة تُسمّى بالشهر الذي تنتهي فيه', async () => {
  const { cycleKey } = await import('../src/util.js');
  // من راتبه يوم ٢٧: ما بدأ ٢٧ يوليو هو دورة أغسطس
  assert.equal(cycleKey('2026-07-26', 27), '2026-07', 'ما قبل السابع والعشرين من الدورة السابقة');
  assert.equal(cycleKey('2026-07-27', 27), '2026-08');
  assert.equal(cycleKey('2026-08-01', 27), '2026-08');
  assert.equal(cycleKey('2026-08-26', 27), '2026-08');
  assert.equal(cycleKey('2026-08-27', 27), '2026-09');
  assert.equal(cycleKey('2026-12-28', 27), '2027-01', 'وتعبر رأس السنة');
  // وبلا ضبطٍ يبقى الشهر التقويمي كما كان
  assert.equal(cycleKey('2026-08-27', 1), '2026-08');
  assert.equal(cycleKey('2026-08-27'), '2026-08');
});

test('حدّا الدورة وعدد أيامها وما مضى منها', async () => {
  const { cycleBounds, cycleProgress } = await import('../src/util.js');
  assert.deepEqual(cycleBounds('2026-08', 27), { from: '2026-07-27', to: '2026-08-26' });
  assert.deepEqual(cycleBounds('2026-08', 1), { from: '2026-08-01', to: '2026-08-31' });

  const p = cycleProgress('2026-08', 27, '2026-08-09');
  assert.equal(p.days, 31, 'من ٢٧ يوليو إلى ٢٦ أغسطس');
  assert.equal(p.elapsed, 14, 'واليوم التاسع من أغسطس هو الرابع عشر من الدورة');
});

test('دورةٌ تبدأ يومًا لا يبلغه الشهر تُقصّ إلى آخره', async () => {
  const { cycleBounds } = await import('../src/util.js');
  // من دورته تبدأ ٣١ لا يجد ٣١ في فبراير
  assert.deepEqual(cycleBounds('2026-03', 31), { from: '2026-02-28', to: '2026-03-30' });
});

test('صورة الدورة على بدايةٍ مخصَّصة، بثلاثة آفاق', async () => {
  const { cycleSnapshot } = await import('../src/analytics.js');
  const a = {
    months: [{ key: '2026-08', spend: 6200, income: 24000, byCategory: { groceries: 4000, dining: 2200 } }],
    spend: { median: 15000 },
    list: [
      { date: '2026-07-28', amount: -1000, excluded: false },
      { date: '2026-08-05', amount: -3000, excluded: false },
      { date: '2026-08-08', amount: -1500, excluded: false, merchant: 'أمس' },
      { date: '2026-08-09', amount: -700, excluded: false, merchant: 'اليوم' },
    ],
  };
  const m = cycleSnapshot(a, { today: '2026-08-09', limit: 15000, startDay: 27 });
  assert.equal(m.key, '2026-08');
  assert.equal(m.from, '2026-07-27');
  assert.equal(m.to, '2026-08-26');
  assert.equal(m.daysInMonth, 31);
  assert.equal(m.day, 14, 'التاسع من أغسطس هو الرابع عشر من دورةٍ تبدأ ٢٧');

  // اليوم: حدُّه حصّةُ يومٍ من حدّ الدورة
  assert.equal(Math.round(m.today.limit), 484);
  assert.equal(m.today.spent, 700);
  assert.ok(m.today.pace > 1.4, 'صرفُ اليوم فوق حصّته');

  // الأسبوع: كتلةُ الدورة الجارية (٨ أيام هنا)، لا سبعةٌ متدحرجة —
  // فالمتدحرج يخلط آخر أسبوعٍ بأوّل الذي بعده فلا يُقارَن أسبوعٌ بأسبوع
  assert.equal(m.week.index, 2);
  assert.equal(Math.round(m.week.limit), 3871);
  assert.equal(m.week.spent, 5200, 'من ٤ إلى ١١ أغسطس، وقد وقع فيها ٣٠٠٠ و١٥٠٠ و٧٠٠');

  assert.equal(m.last.name, 'اليوم', 'آخر عملية في الدورة');
});

test('تصفّح دورةٍ ماضية يحسبها مكتملةً لا جارية', async () => {
  const { cycleSnapshot } = await import('../src/analytics.js');
  const a = {
    months: [{ key: '2026-07', spend: 9000, income: 20000, byCategory: {} }],
    spend: { median: 15000 }, list: [],
  };
  const m = cycleSnapshot(a, { today: '2026-08-09', limit: 15000, startDay: 27, key: '2026-07' });
  assert.equal(m.isCurrent, false);
  assert.equal(m.day, m.daysInMonth, 'الدورة المنقضية مكتملة، فلا تُقاس بوتيرة نصفها');
  assert.equal(m.spent, 9000);
  assert.equal(m.today.spent, 0, 'ولا صرفَ «اليوم» في دورةٍ مضت');
});

test('توقّع الدورة القادمة: المعتاد وما يعرفه المستخدم', async () => {
  const { forecastNext } = await import('../src/analytics.js');
  const a = { spend: { median: 12000 } };
  const f = forecastNext(a, {
    today: '2026-08-09', limit: 15000, startDay: 27,
    planned: [
      { label: 'رسوم دراسية', amount: 4000, cycle: '2026-09' },
      { label: 'سفر', amount: 2500 },                       // بلا دورة ⇒ للقادمة
      { label: 'ليست لها', amount: 9999, cycle: '2026-12' },
    ],
  });
  assert.equal(f.key, '2026-09');
  assert.deepEqual([f.from, f.to], ['2026-08-27', '2026-09-26']);
  assert.equal(f.usual, 12000);
  assert.equal(f.extra, 6500, 'يُجمع المخطَّط للدورة القادمة وحدها');
  assert.equal(f.expected, 18500);
  assert.equal(f.over, 3500, 'يتجاوز الحدّ بـ٣٥٠٠');
  assert.equal(Math.round(f.dailyAllowance), 274, 'ما يبقى لكل يومٍ بعد حسم المخطَّط');
});

test('الدورة تُقسم أربعة أسابيع بلا بقيّة، ولكلٍّ حدُّه بنسبة أيامه', async () => {
  const { cycleSnapshot } = await import('../src/analytics.js');
  const a = {
    months: [{ key: '2026-08', spend: 4000, income: 0, byCategory: {} }],
    spend: { median: 15000 },
    list: [
      { date: '2026-07-28', amount: -1000, excluded: false },   // الأسبوع ١
      { date: '2026-08-06', amount: -2000, excluded: false },   // الأسبوع ٢
      { date: '2026-08-09', amount: -1000, excluded: false },   // الأسبوع ٢
    ],
  };
  const m = cycleSnapshot(a, { today: '2026-08-09', limit: 15000, startDay: 27 });
  assert.equal(m.weeks.length, 4);
  assert.deepEqual(m.weeks.map((w) => w.days), [8, 8, 8, 7], '٣١ يومًا ⇒ ٨ ٨ ٨ ٧');
  assert.equal(m.weeks[0].from, '2026-07-27');
  assert.equal(m.weeks[3].to, '2026-08-26', 'وآخرها ينتهي بآخر الدورة');
  assert.equal(m.weeks[0].spent, 1000);
  assert.equal(m.weeks[1].spent, 3000);
  assert.equal(Math.round(m.weeks[0].limit), 3871, 'حدُّه بنسبة أيامه من الدورة');
  assert.equal(m.weeks[1].isCurrent, true, 'التاسع من أغسطس في الأسبوع الثاني');
  assert.equal(m.weeks[0].isPast, true);
  assert.equal(m.week.index, 2, 'و«الأسبوع» هو الجاري لا سبعةٌ متدحرجة');
});
