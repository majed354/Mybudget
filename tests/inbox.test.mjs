// اختبارات طبقة الرسائل: التحليل، والمطابقة، ورمز الصندوق.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankSMS, smsToTransaction, reconcile, nameSimilarity, boxIdFor } from '../src/inbox.js';

test('رمز الصندوق يختلف عن معرّف المزامنة ولا يكشف المفتاح', async () => {
  const { encryptSnapshot } = await import('../src/sync.js');
  const secret = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789';
  const box = await boxIdFor(secret);
  const { id } = await encryptSnapshot(secret, {});
  assert.match(box, /^[a-f0-9]{48}$/);
  assert.notEqual(box, id, 'ملحان مختلفان ⇒ رمزان مختلفان');
  assert.ok(!box.includes('ABCD'), 'لا أثر للمفتاح في الرمز');
  assert.equal(box, await boxIdFor(secret.toLowerCase().replace(/-/g, '')), 'التطبيع يتجاهل الشرطات والحالة');
});

test('تحليل رسالة شراء بنقاط البيع', () => {
  const p = parseBankSMS('شراء عبر نقاط البيع\nبطاقة مدى ****1234\nمبلغ 37.50 SAR\nلدى RKAEZ ALAKWAN\nفي 07/08/2026 14:22\nالرصيد 12,340.10');
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'pos');
  assert.equal(p.amount, 37.5);
  assert.equal(p.merchant, 'RKAEZ ALAKWAN');
  assert.equal(p.date, '2026-08-07');
  assert.equal(p.time, '14:22');
  assert.equal(p.balance, 12340.1);
  assert.equal(p.card, '1234');
});

test('تحليل رسالة براتب وارد — تُقيَّد دائنًا', () => {
  const p = parseBankSMS('إيداع راتب\nمبلغ 20,853.90 ريال\nالحساب ***456\nفي 27/08/2026');
  assert.equal(p.kind, 'salary');
  const t = smsToTransaction(p, { id: 'm1', text: 'x' });
  assert.ok(t.amount > 0, 'الراتب موجب');
  assert.equal(t.status, 'pending');
  assert.equal(t.source, 'sms');
});

test('الشراء يُقيَّد مدينًا', () => {
  const p = parseBankSMS('شراء بمبلغ 120.00 ر.س لدى Keeta في 01/09/2026');
  const t = smsToTransaction(p, { id: 'm2', text: 'y' });
  assert.equal(t.amount, -120);
});

test('الأرقام العربية تُقرأ', () => {
  const p = parseBankSMS('شراء مبلغ ٤٣٫٠٠ ريال لدى بقالة النسيم في ٠١/٠٩/٢٠٢٦');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 43);
});

test('رسالة لا تخصّ عملية تُرفض بسبب مفهوم', () => {
  assert.deepEqual(parseBankSMS('رمز التحقق 458912 لا تشاركه مع أحد').ok, false);
  assert.equal(parseBankSMS('').reason, 'رسالة فارغة');
  assert.equal(parseBankSMS('شراء لدى متجر').reason, 'لم يُعثر على مبلغ');
});

test('المطابقة تربط المعلَّق بالمؤكَّد رغم فارق يوم وقروش', () => {
  const pending = [{ id: 'p1', date: '2026-08-05', amount: -37.5, merchantHint: 'RKAEZ ALAKWAN', source: 'sms' }];
  const booked = [
    { id: 'b1', date: '2026-08-06', amount: -37.5, merchant: 'RKAEZ ALAKWAN CO' },
    { id: 'b2', date: '2026-08-06', amount: -37.4, merchant: 'محل آخر' },
  ];
  const { matched, unmatched } = reconcile(pending, booked);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].booked.id, 'b1', 'تشابه الاسم يرجّح عند تقارب المبلغ');
  assert.equal(unmatched.length, 0);
});

test('المطابقة ترفض ما تباعد تاريخه أو اختلف اتجاهه', () => {
  const pending = [{ id: 'p1', date: '2026-08-01', amount: -100, merchantHint: 'X' }];
  assert.equal(reconcile(pending, [{ id: 'b', date: '2026-08-20', amount: -100 }]).unmatched.length, 1);
  assert.equal(reconcile(pending, [{ id: 'b', date: '2026-08-01', amount: 100 }]).unmatched.length, 1);
  assert.equal(reconcile(pending, [{ id: 'b', date: '2026-08-01', amount: -140 }]).unmatched.length, 1);
});

test('لا تُطابَق عمليتان معلَّقتان بعملية مؤكَّدة واحدة', () => {
  const pending = [
    { id: 'p1', date: '2026-08-05', amount: -50, merchantHint: 'A' },
    { id: 'p2', date: '2026-08-05', amount: -50, merchantHint: 'A' },
  ];
  const booked = [{ id: 'b1', date: '2026-08-05', amount: -50, merchant: 'A' }];
  const { matched, unmatched } = reconcile(pending, booked);
  assert.equal(matched.length, 1);
  assert.equal(unmatched.length, 1, 'الثانية تبقى معلَّقة لتُراجَع لا لتُدمج خطأً');
});

test('nameSimilarity يقيس التداخل لا التطابق', () => {
  assert.ok(nameSimilarity('RKAEZ ALAKWAN', 'RKAEZ ALAKWAN CO') > 0.9);
  assert.equal(nameSimilarity('ABC', ''), 0);
  assert.ok(nameSimilarity('مطعم الأنوار', 'صيدلية النهدي') < 0.5);
});
