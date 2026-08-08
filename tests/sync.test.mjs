// اختبارات المزامنة المشفَّرة والتذكيرات.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSecret, encryptSnapshot, decryptSnapshot, mergeSnapshots , planSync } from '../src/sync.js';
import { pruneDeleted } from '../src/store.js';
import { computeReminders, spendPace } from '../src/reminders.js';

test('المفتاح المولَّد عشوائي وبطول كافٍ', () => {
  const a = newSecret(), b = newSecret();
  assert.notEqual(a, b);
  assert.equal(a.replace(/-/g, '').length, 32);
  assert.match(a, /^[A-Z2-9-]+$/);
});

test('التشفير وفكّه رحلة ذهاب وعودة', async () => {
  const secret = newSecret();
  const snapshot = { version: 1, transactions: [{ hash: 'x', amount: -50, date: '2026-01-01' }], settings: { a: 1 } };
  const { blob, id } = await encryptSnapshot(secret, snapshot);
  assert.match(blob, /^v1\./);
  assert.match(id, /^[a-f0-9]{48}$/, 'المعرّف تجزئة سداسية لا المفتاح نفسه');
  assert.ok(!blob.includes('2026-01-01'), 'لا يظهر أي نصّ صريح في الكتلة');
  assert.deepEqual(await decryptSnapshot(secret, blob), snapshot);
});

test('نسخة بحجم واقعي (~١ ميغابايت) تُشفَّر وتُفكّ', async () => {
  // نسخة المستخدم الحقيقية: ٧٣٨ عملية ⇒ ١٬٠٧٨٬٤٨٨ بايت. الاختبارات الصغيرة
  // كانت تمرّ بينما الرفع الحقيقي يرمي RangeError من نشر البايتات وسائطَ،
  // فبقي الخادم فارغًا. الحجم هنا جزءٌ من الاختبار لا زينة.
  const secret = newSecret();
  const row = (i) => ({
    hash: `h${i}`, id: `id-${i}`, date: '2026-03-05', amount: -123.45,
    desc: 'شراء نقاط بيع ٤٥٢٧ ماركت الخير الرياض'.repeat(4),
    details: 'الغرض من العملية: شخصي — رقم المرجع ٢٠٢٦٠٣٠٥٩٩٩ — الرصيد بعد العملية'.repeat(8),
  });
  const snapshot = { version: 1, transactions: Array.from({ length: 738 }, (_, i) => row(i)), settings: {}, rules: [] };
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  assert.ok(bytes > 1_000_000, `الاختبار بلا معنى دون حجمٍ واقعي (${bytes})`);

  const { blob } = await encryptSnapshot(secret, snapshot);
  const back = await decryptSnapshot(secret, blob);
  assert.equal(back.transactions.length, 738);
  assert.deepEqual(back.transactions[737], snapshot.transactions[737], 'آخر عملية تصل سليمة');
});

test('حدود التقطيع في الترميز لا تُفسد بايتًا', async () => {
  // ٣٢٧٦٨ حدُّ الدفعة: نختبر ما قبله وما بعده وما يساويه تمامًا
  const secret = newSecret();
  for (const n of [0x8000 - 1, 0x8000, 0x8000 + 1, 0x8000 * 3 + 7]) {
    const payload = { blobLike: 'ن'.repeat(n) };
    const { blob } = await encryptSnapshot(secret, payload);
    assert.deepEqual(await decryptSnapshot(secret, blob), payload, `انكسر عند ${n}`);
  }
});

test('مفتاح خاطئ لا يفكّ الكتلة', async () => {
  const { blob } = await encryptSnapshot(newSecret(), { transactions: [] });
  await assert.rejects(() => decryptSnapshot(newSecret(), blob), /تأكّد من مفتاح المزامنة/);
});

test('المفتاح لا يُشتقّ منه المعرّف عكسيًا، والتطبيع يتجاهل الشرطات وحالة الحرف', async () => {
  const s = newSecret();
  const a = await encryptSnapshot(s, { x: 1 });
  const b = await encryptSnapshot(s.replace(/-/g, '').toLowerCase(), { x: 1 });
  assert.equal(a.id, b.id, 'الصياغتان تؤدّيان إلى المعرّف نفسه');
});

test('الدمج يوحّد العمليات ولا يدهس الوسم اليدوي', () => {
  const local = {
    exportedAt: '2026-08-02T00:00:00Z',
    transactions: [
      { hash: 'a', date: '2026-01-01', category: 'travel', categorySource: 'user' },
      { hash: 'b', date: '2026-01-02', category: 'other', categorySource: 'auto' },
    ],
    settings: { policy: { dbrCap: 0.3 } }, rules: [{ field: 'merchant', op: 'key', value: 'X', category: 'dining' }],
  };
  const remote = {
    exportedAt: '2026-08-01T00:00:00Z',
    transactions: [
      { hash: 'a', date: '2026-01-01', category: 'dining', categorySource: 'merchant' },
      { hash: 'c', date: '2026-01-03', category: 'health', categorySource: 'merchant' },
    ],
    settings: { policy: { dbrCap: 0.45 } }, rules: [{ field: 'type', op: 'equals', value: 'atm_out', category: 'cash' }],
  };
  const m = mergeSnapshots(local, remote);
  assert.equal(m.transactions.length, 3, 'اتحاد العمليات بلا تكرار');
  assert.equal(m.transactions.find((t) => t.hash === 'a').category, 'travel', 'الوسم اليدوي يفوز');
  assert.equal(m.settings.policy.dbrCap, 0.3, 'الإعدادات من النسخة الأحدث');
  assert.equal(m.rules.length, 2, 'القواعد تُدمج بلا تكرار');
});

test('الإعدادات تُؤخذ ممّن غيّرها أخيرًا لا ممّن صدّر أخيرًا', () => {
  // exportAll يختم exportedAt بلحظة التصدير، فالمحلّي أحدثُ دائمًا. لو رُجّح
  // به لَما وصل الجهازَ شيءٌ ممّا ضُبط على الآخر — ووسمُ الحسابات منه.
  const local = {
    exportedAt: '2026-08-08T10:00:00Z', settingsAt: '2026-08-01T00:00:00Z',
    transactions: [], settings: { ownAccounts: { ibans: [] } }, rules: [],
  };
  const remote = {
    exportedAt: '2026-08-07T09:00:00Z', settingsAt: '2026-08-06T00:00:00Z',
    transactions: [], settings: { ownAccounts: { ibans: ['SA79'] } }, rules: [],
  };
  const m = mergeSnapshots(local, remote);
  assert.deepEqual(m.settings.ownAccounts.ibans, ['SA79'], 'الجهاز الآخر غيّر الإعدادات بعدُ فتفوز');
  assert.equal(m.settingsAt, '2026-08-06T00:00:00Z', 'الختم ينتقل مع الفائز');
});

test('نسخة قديمة بلا ختم تغيير ترجع إلى ختم التصدير', () => {
  const local = { exportedAt: '2026-08-02T00:00:00Z', transactions: [], settings: { a: 1 }, rules: [] };
  const remote = { exportedAt: '2026-08-01T00:00:00Z', transactions: [], settings: { a: 2 }, rules: [] };
  assert.equal(mergeSnapshots(local, remote).settings.a, 1);
});

test('المحذوف لا يعود من الجهاز الآخر', () => {
  // الصورة الحقيقية: عمليةٌ معلَّقة من رسالة البنك طُوبقت بنظيرتها في الكشف
  // فحُذفت هنا؛ ولو عادت من هناك لَحُسب المبلغ مرتين.
  const local = {
    exportedAt: '2026-08-08T00:00:00Z', transactions: [{ hash: 'booked', date: '2026-08-01' }],
    deleted: { pending1: '2026-08-08T00:00:00Z' }, settings: {}, rules: [],
  };
  const remote = {
    exportedAt: '2026-08-07T00:00:00Z',
    transactions: [{ hash: 'booked', date: '2026-08-01' }, { hash: 'pending1', date: '2026-08-01' }],
    settings: {}, rules: [],
  };
  const m = mergeSnapshots(local, remote);
  assert.deepEqual(m.transactions.map((t) => t.hash), ['booked'], 'المطابَقة لا تُنقض بالمزامنة');
  assert.equal(m.deleted.pending1, '2026-08-08T00:00:00Z', 'الشاهد يبقى ليبلغ بقية الأجهزة');
});

test('شاهد الحذف يُرفع ولو تساوى العددان', () => {
  // حُذفت واحدة وأُضيفت أخرى: العدد نفسه، والشاهد لم يبلغ الخادم بعد
  const local = {
    exportedAt: '2026-08-08T00:00:00Z', transactions: [{ hash: 'new', date: '2026-08-02' }],
    deleted: { old: '2026-08-08T00:00:00Z' }, settings: {}, rules: [],
  };
  const remote = { exportedAt: '2026-08-07T00:00:00Z', transactions: [{ hash: 'old', date: '2026-08-01' }], settings: {}, rules: [] };
  const p = planSync(local, remote);
  assert.equal(p.merged.transactions.length, 1);
  assert.equal(p.push, true, 'وإلا عادت المحذوفة من الخادم في السحبة التالية');
});

test('شواهد الحذف تُقلَّم بعد ١٨٠ يومًا ولا تكبر بلا حدّ', () => {
  const now = Date.parse('2026-08-08T00:00:00Z');
  const map = { fresh: '2026-08-01T00:00:00Z', stale: '2025-01-01T00:00:00Z' };
  const out = pruneDeleted(map, now);
  assert.deepEqual(Object.keys(out), ['fresh']);
});

test('الدمج يحتمل غياب أحد الطرفين', () => {
  const local = { transactions: [{ hash: 'a', date: '2026-01-01' }] };
  assert.equal(mergeSnapshots(local, null), local);
  assert.equal(mergeSnapshots(null, local), local);
});

// ── التذكيرات ─────────────────────────────────────────────────────────────
const analysis = (over = {}) => ({
  coverage: { to: '2026-07' },
  list: [{ date: '2026-07-20', amount: -100, excluded: false }],
  recurring: [
    { key: 'r1', type: 'loan', label: 'قسط تمويل', amount: 6650, day: 27 },
    { key: 'r2', type: 'standing_order', label: 'أمر مستديم', amount: 2105, day: 28 },
    { key: 'r3', type: 'pos', label: 'مطعم', amount: 40, day: 5 },
  ],
  income: { salary: { amount: 23979, day: 27 } },
  solidMonths: [],
  ...over,
});

test('تذكير الالتزام يسبق موعده بيومين لا أكثر', () => {
  const ids = (d) => computeReminders(analysis(), d).map((r) => r.kind);
  assert.ok(ids('2026-07-25').includes('commitment'), 'قبل يومين يُنبَّه');
  assert.ok(ids('2026-07-27').includes('commitment'), 'يوم الاستحقاق يُنبَّه');
  assert.ok(!ids('2026-07-20').includes('commitment'), 'قبل أسبوع لا يُنبَّه');
  // ولا يُنبَّه على المتكرر غير الملتزم (مطعم يوم ٥)
  assert.equal(computeReminders(analysis(), '2026-07-05').filter((r) => r.kind === 'commitment').length, 0);
});

test('تذكير الراتب يوم نزوله', () => {
  assert.ok(computeReminders(analysis(), '2026-07-27').some((r) => r.kind === 'income'));
  assert.ok(!computeReminders(analysis(), '2026-07-26').some((r) => r.kind === 'income'));
});

test('تذكير تحديث الكشف حين يقدُم آخر تسجيل', () => {
  assert.ok(!computeReminders(analysis(), '2026-08-01').some((r) => r.kind === 'import'), 'بعد ١٢ يومًا لا تذكير');
  assert.ok(computeReminders(analysis(), '2026-09-01').some((r) => r.kind === 'import'), 'بعد ٤٣ يومًا يُذكَّر');
});

test('spendPace يقارن الإنفاق حتى اليوم بمثله في الأشهر السابقة', () => {
  const list = [];
  for (const m of ['01', '02', '03']) list.push({ date: `2026-${m}-05`, amount: -1000, excluded: false });
  list.push({ date: '2026-04-05', amount: -2000, excluded: false });
  const a = {
    coverage: { to: '2026-04' }, list, recurring: [], income: {},
    solidMonths: ['2026-01', '2026-02', '2026-03', '2026-04'].map((key) => ({ key })),
  };
  const pace = spendPace(a, '2026-04-10');
  assert.equal(pace.spent, 2000);
  assert.equal(pace.usual, 1000);
  assert.equal(pace.ratio, 2);
  assert.ok(computeReminders(a, '2026-04-10').some((r) => r.kind === 'pace'));
});

test('لا تذكيرات بلا تحليل', () => {
  assert.deepEqual(computeReminders(null, '2026-07-27'), []);
});

// ── تقارب الجهازين ────────────────────────────────────────────────────────
const snap = (n, extra = {}) => ({
  version: 1,
  exportedAt: extra.at || '2026-08-01T00:00:00Z',
  transactions: Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, date: '2026-08-01', amount: -10 })),
  settings: extra.settings || null, rules: extra.rules || [], accounts: {},
});

test('جهاز ممتلئ وخادم فارغ ⇒ يرفع', () => {
  const p = planSync(snap(8), null);
  assert.equal(p.push, true, 'وإلا بقي الجهاز الثاني لا يجد شيئًا');
  assert.equal(p.merged.transactions.length, 8);
});

test('جهاز فارغ وخادم فارغ ⇒ لا شيء يُرفع', () => {
  assert.equal(planSync(snap(0), null).push, false);
});

test('جهاز فارغ وخادم ممتلئ ⇒ ينزل بلا رفع', () => {
  const p = planSync(snap(0), snap(8));
  assert.equal(p.merged.transactions.length, 8);
  assert.equal(p.added, 8);
  assert.equal(p.push, false, 'لا داعي لرفع ما هو على الخادم أصلًا');
});

test('كل طرف فيه ما ليس في الآخر ⇒ يتّحدان ويُرفع الاتحاد', () => {
  const a = snap(0); a.transactions = [{ hash: 'x1', date: '2026-08-01', amount: -5 }];
  const b = snap(0); b.transactions = [{ hash: 'x2', date: '2026-08-02', amount: -7 }];
  const p = planSync(a, b);
  assert.equal(p.merged.transactions.length, 2);
  assert.equal(p.push, true, 'الخادم ينقصه ما على الجهاز');
  assert.equal(p.added, 1);
});

test('الطرفان متطابقان ⇒ لا رفع ولا تغيير', () => {
  const p = planSync(snap(5), snap(5));
  assert.equal(p.push, false);
  assert.equal(p.added, 0);
});
