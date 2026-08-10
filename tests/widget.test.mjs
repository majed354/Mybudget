// اختبارات حارس ملخّص أداة الشاشة — هو ما يمنع اتّساع ما يُنشر بلا تشفير.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSummary, SUMMARY_V } from '../src/widget-schema.js';
import { widgetSummary, newWidgetToken } from '../src/sync.js';

const good = {
  v: SUMMARY_V, dayLimit: 387.1, weekSpent: 1400, weekLimit: 2709.68, month: '2026-08', day: 8, daysInMonth: 31,
  spent: 6000, limit: 12000, remaining: 6000, saved: 14000, income: 20000,
  pace: 1.55, projected: 23250, todaySpent: 210, todayCount: 2, monthCount: 26,
  top: [{ n: 'بقالة وتموين', a: 3000 }],
  last: { n: 'ماركت الخير', a: 210, d: '2026-08-08' },
  at: '2026-08-08T12:00:00Z',
};

test('الملخّص المجمَّع يُقبل', () => {
  assert.equal(validateSummary(good), null);
});

test('الخادم يردّ ما تجاوز المجمَّع — لا يتجاهله', () => {
  // هذه هي الضمانة: خطأٌ في العميل لا يُخرج تفصيلًا
  assert.match(validateSummary({ ...good, transactions: [{ a: 1 }] }), /غير مسموح/);
  assert.match(validateSummary({ ...good, balance: 419692 }), /غير مسموح/);
  assert.match(validateSummary({ ...good, iban: 'SA79...' }), /غير مسموح/);
  assert.match(validateSummary({ ...good, top: [{ n: 'س', a: 1, x: 'زائد' }] }), /غير مسموح/);
});

test('الحدود مصانة: طول النصّ، وعدد المجالات، وصحّة الأرقام', () => {
  assert.match(validateSummary({ ...good, month: 'م'.repeat(41) }), /أطول/);
  assert.match(validateSummary({ ...good, top: [1, 2, 3, 4].map(() => ({ n: 'س', a: 1 })) }), /أطول/);
  assert.match(validateSummary({ ...good, spent: NaN }), /غير صالح/);
  assert.match(validateSummary({ ...good, spent: '6000' }), /نوع غير صحيح/);
  assert.match(validateSummary([]), /ليس كائنًا/);
});

test('آخر عملية قد تكون معدومة ولا يُعدّ ذلك خطأً', () => {
  assert.equal(validateSummary({ ...good, last: null }), null);
});

test('ما يبنيه التطبيق يمرّ من حارس الخادم', () => {
  // العقد بين الطرفين: لو زاد `widgetSummary` حقلًا نسي الحارسُ إجازته، سقط هنا
  const m = {
    key: '2026-08', day: 8, daysInMonth: 31, spent: 6000, income: 20000, saved: 14000,
    limit: 12000, remaining: 6000, pace: 1.55, projected: 23250,
    todaySpent: 210, todayCount: 2, monthCount: 26,
    top: [{ ar: 'بقالة وتموين', amount: 3000 }, { ar: 'مطاعم وقهوة', amount: 2000 }],
    last: { name: 'ماركت الخير', amount: 210, date: '2026-08-08' },
  };
  assert.equal(validateSummary(widgetSummary(m, '2026-08-08T12:00:00Z')), null);
});

test('رمز الأداة عشوائي بطول ٤٨ محرفًا وليس مشتقًّا من مفتاح المزامنة', () => {
  const a = newWidgetToken(), b = newWidgetToken();
  assert.match(a, /^[a-f0-9]{48}$/);
  assert.notEqual(a, b);
});

/**
 * الحمولة أدناه هي ما نشره جهازُ صاحب النسخة العالقُ فعلًا يوم ٢٦٠٨١٠:
 * `day: 10` بحساب الشهر التقويمي بينما دورته تبدأ ٢٧ فيومُها ١٥، وبلا
 * `dayLimit` ولا `weekSpent` ولا `weekLimit` — إذ لا تعرفها تلك النسخة.
 * وكانت تمرّ لأن كل حقولها مسموحة، فتدهس ما نشرته النسخة الحديثة.
 */
const STALE = {
  v: 1, month: '2026-08', day: 10, daysInMonth: 31,
  spent: 7852.97, limit: 10000, remaining: 2147.03, saved: -7819.82,
  income: 33.15, pace: 2.43, projected: 24344.21,
  todaySpent: 0, todayCount: 0, monthCount: 29,
  top: [{ n: 'وقود ومواصلات', a: 4219 }], last: { n: 'Renad Moh', a: 22, d: '2026-08-09' },
  at: '2026-08-10T02:00:35.853Z',
};

test('ملخّصٌ من نسخةٍ لا تعرف الدورة يُردّ', () => {
  const bad = validateSummary(STALE);
  assert.ok(bad, 'كان يمرّ فيدهس الحديث');
  assert.match(bad, /قديمة/);
});

test('ملخّصُ العقد الحاليّ يُقبل', () => {
  const fresh = { ...STALE, v: SUMMARY_V, day: 15, dayLimit: 322.58, weekSpent: 1200, weekLimit: 2580.65 };
  assert.equal(validateSummary(fresh), null);
});

test('رقمُ العقد لا يُغفل ولا يُزوَّر', () => {
  for (const v of [undefined, null, '2', NaN, 0, 1, -1]) {
    assert.ok(validateSummary({ ...STALE, v }), `عقد ${String(v)} يجب أن يُردّ`);
  }
  assert.equal(validateSummary({ ...STALE, v: SUMMARY_V + 1 }), null, 'عقدٌ أحدث يُقبل: الخادم لا يسبق العميل');
});

test('الملخّص الذي يبنيه التطبيق يحمل رقم العقد', async () => {
  const { widgetSummary } = await import('../src/sync.js');
  const m = {
    key: '2026-08', day: 15, daysInMonth: 31, spent: 7852.97, limit: 10000,
    remaining: 2147.03, saved: -7819.82, income: 33.15, pace: 2.43, projected: 24344.21,
    todaySpent: 0, today: { limit: 322.58 }, week: { spent: 1200, limit: 2580.65 },
    monthCount: 29, top: [], last: null,
  };
  const s = widgetSummary(m, '2026-08-10T02:00:00.000Z');
  assert.equal(s.v, SUMMARY_V);
  assert.equal(validateSummary(s), null, 'ما يبنيه التطبيق يجب أن يجتاز حارسَه');
});
