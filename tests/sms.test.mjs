// اختبارات على قوالب حقيقية من البلاد والراجحي وstc bank — بنصّها كما وصلت.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankSMS, smsToTransaction } from '../src/inbox.js';
import { detectBank } from '../src/sms-formats.js';

const SMS = {
  albiladTransfer: `حوالة محلية صادرة مقبولة
عبر:RJHI
من:0007
الى:شركة العامودي للتجارة
ايبان:4589
مبلغ:3960 SAR
رسوم:0.58 SAR
في:2026/08/06 18:23
مرجع:FT26218000471106`,

  albiladEcom: `مشتريات إنترنت
بطاقة: **5762; مدى, Apple Pay
مبلغ: 129 SAR
رقم الحساب: xx026
لدى: Keeta
5/8/26 21:59`,

  albiladStanding: `امر مستديم حوالة صادرة محلية
الي: البنك السعودي للاستثمار
المرسل: ماجد ابراهيم الجهنى
حساب المرسل: xx0007
المستقبل: حسابي أمازون
حساب المستقبل: xx0024
مبلغ: 2105.75 SAR
الرسوم: 5.75 ريال
في: 07/28/26 01:01`,

  albiladPos: `شراء نقاط بيع
مدى5002 Apple Pay
بـ5 SAR
منamer saed


2026-07-26 18:04`,

  rajhiPos: `شراء عبر نقاط البيع
بطاقة:2143 ;فيزا-ابل باي
لدى:BAJH TRAD
مبلغ:129.12 SAR
رصيد:9072.93 SAR
؜7/8/26 18:58`,

  rajhiCardPayment: `بطاقة فيزا:سداد بـSR 3216.26
عبر2143;فيزا
رصيد:7579.16 SR
؜1/8/26 13:42`,

  stcLocal: `شراء إنترنت
عبر: *5106, Visa
ب: 221 SAR
من: APPLE.
سعر تحويل العملات: 1
ضريبة القيمة المضافة: 0.00 SAR
رسوم العملية: 4.42 SAR
إجمالى المبلغ المستحق: 225.42 SAR
الرصيد المتبقى: 2298.2 SAR
الدولة: IE
فى: 06/08/26 09:57`,

  stcForeign: `شراء إنترنت
عبر: *5106, Visa
ب: 213.13 USD
من: OPENAI
سعر تحويل العملات: 3.757003
ضريبة القيمة المضافة: 0.00 SAR
رسوم العملية: 16.01 SAR
إجمالى المبلغ المستحق: 816.74 SAR
الرصيد المتبقى: 2532.79 SAR
الدولة: US
فى: 06/08/26 02:18`,
};

test('تمييز المصرف من شكل الرسالة', () => {
  assert.equal(detectBank(SMS.albiladEcom).id, 'albilad');
  assert.equal(detectBank(SMS.rajhiPos).id, 'rajhi');
  assert.equal(detectBank(SMS.stcLocal).id, 'stc');
});

test('البلاد — حوالة صادرة: الرسوم تُضمّ للمبلغ كما يخصمها البنك', () => {
  const p = parseBankSMS(SMS.albiladTransfer);
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'transfer_out');
  assert.equal(p.amount, 3960.58, '3960 + 0.58 رسوم');
  assert.equal(p.fee, 0.58);
  assert.equal(p.merchant, 'شركة العامودي للتجارة');
  assert.equal(p.date, '2026-08-06');
  assert.equal(p.time, '18:23');
  assert.equal(p.ref, 'FT26218000471106');
  assert.equal(p.self, false);
});

test('البلاد — مشتريات إنترنت', () => {
  const p = parseBankSMS(SMS.albiladEcom);
  assert.equal(p.kind, 'ecom');
  assert.equal(p.amount, 129);
  assert.equal(p.merchant, 'Keeta');
  assert.equal(p.card, '5762');
  assert.equal(p.date, '2026-08-05');
});

test('البلاد — أمر مستديم: يُقرأ المستفيد والمبلغ والتاريخ المقلوب', () => {
  const p = parseBankSMS(SMS.albiladStanding);
  assert.equal(p.kind, 'standing_order');
  assert.equal(p.amount, 2111.5, '2105.75 + 5.75 رسوم');
  assert.equal(p.self, true, '«حسابي أمازون» ⇒ المستفيد أنت');
  assert.equal(p.date, '2026-07-28', 'التاريخ هنا شهر/يوم/سنة فيُقلب');
});

test('البلاد — نقاط بيع بصيغة مضغوطة و«من» ملتصقة بالاسم', () => {
  const p = parseBankSMS(SMS.albiladPos);
  assert.equal(p.kind, 'pos');
  assert.equal(p.amount, 5);
  assert.equal(p.merchant, 'amer saed');
  assert.equal(p.card, '5002');
  assert.equal(p.date, '2026-07-26');
});

test('الراجحي — نقاط بيع مع الرصيد وعلامة الاتجاه قبل التاريخ', () => {
  const p = parseBankSMS(SMS.rajhiPos);
  assert.equal(p.kind, 'pos');
  assert.equal(p.amount, 129.12);
  assert.equal(p.merchant, 'BAJH TRAD');
  assert.equal(p.balance, 9072.93);
  assert.equal(p.card, '2143');
  assert.equal(p.date, '2026-08-07', 'محرف علامة الاتجاه لا يفسد قراءة التاريخ');
});

test('الراجحي — سداد البطاقة تحويلٌ داخلي لا مصروف', () => {
  const p = parseBankSMS(SMS.rajhiCardPayment);
  assert.equal(p.kind, 'card_payment');
  assert.equal(p.amount, 3216.26, 'المبلغ بعد «بـSR» لا قبله');
  const t = smsToTransaction(p, { id: 'm', text: SMS.rajhiCardPayment });
  assert.equal(t.excluded, true, 'تسديد بطاقتك من حسابك ليس إنفاقًا جديدًا');
});

test('stc bank — شراء محلي: يُؤخذ الإجمالي المستحق لا المبلغ قبل الرسوم', () => {
  const p = parseBankSMS(SMS.stcLocal);
  assert.equal(p.kind, 'ecom');
  assert.equal(p.amount, 225.42, '221 + 4.42 رسوم = الإجمالي المستحق');
  assert.equal(p.merchant, 'APPLE');
  assert.equal(p.balance, 2298.2);
  assert.equal(p.country, 'IE');
  assert.equal(p.date, '2026-08-06');
});

test('stc bank — شراء بالدولار: يُحتسب الإجمالي بالريال لا الرقم بالعملة الأجنبية', () => {
  const p = parseBankSMS(SMS.stcForeign);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 816.74, 'لا 213.13');
  assert.equal(p.foreign, 'USD');
  assert.equal(p.merchant, 'OPENAI');
  const t = smsToTransaction(p, { id: 'm', text: SMS.stcForeign });
  assert.equal(t.amount, -816.74);
});

test('رسالة بعملة أجنبية بلا إجمالي بالريال تُرفض بدل أن تُحتسب خطأً', () => {
  const p = parseBankSMS(`شراء إنترنت\nعبر: *5106, Visa\nب: 50 USD\nمن: SOMEWHERE\nفى: 06/08/26 09:57`);
  assert.equal(p.ok, false);
  assert.match(p.reason, /USD/);
});

test('رسالة رمز تحقق لا تُقيَّد عمليةً', () => {
  const p = parseBankSMS('رمز التحقق 458912 لا تشاركه مع أحد');
  assert.equal(p.ok, false);
});

test('اتجاه المبلغ صحيح: الشراء مدين والراتب دائن', () => {
  const buy = smsToTransaction(parseBankSMS(SMS.rajhiPos), { id: '1', text: 'x' });
  assert.ok(buy.amount < 0);
  const pay = parseBankSMS('إيداع راتب\nمبلغ: 20853.90 SAR\nفي: 27/08/2026');
  assert.equal(pay.kind, 'salary');
  assert.ok(smsToTransaction(pay, { id: '2', text: 'y' }).amount > 0);
});

test('الأمر المستديم إلى حسابك يبقى محسوبًا — مالٌ مرصود لا فائض', () => {
  const p = parseBankSMS(SMS.albiladStanding);
  const t = smsToTransaction(p, { id: 'm', text: SMS.albiladStanding });
  assert.equal(p.self, true);
  assert.equal(t.excluded, false, 'ما يخرج كل شهر في موعده التزامٌ ولو ذهب إلى حسابك');
});

test('الحوالة العابرة إلى حسابك تُستبعد', () => {
  const sms = `حوالة محلية صادرة مقبولة\nالى:حسابي في الراجحي\nمبلغ:5000 SAR\nفي:2026/08/06 18:23`;
  const t = smsToTransaction(parseBankSMS(sms), { id: 'm', text: sms });
  assert.equal(t.excluded, true);
});
