// اختبارات طبقة الرسائل: التحليل، والمطابقة، ورمز الصندوق.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankSMS, smsToTransaction, reconcile, nameSimilarity, boxIdFor } from '../src/inbox.js';
import { newSecret } from '../src/sync.js';

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

test('معرّف الصندوق يتطابق بين رمزٍ نقيّ وآخر لُصق به نصّ', async () => {
  // لو افترق التطبيع بين sync وinbox لأودع الجوال في صندوقٍ لا يقرأه الحاسب
  const clean = newSecret();
  const glued = `${clean} دخول أنشئ رمزًا جديدًا تابع على هذا الجهاز فقط`;
  assert.equal(await boxIdFor(glued), await boxIdFor(clean));
  assert.notEqual(await boxIdFor(clean), await boxIdFor(newSecret()));
});

// ── الوصل بين طبقة الرسائل ومحرّك الاستبعاد ───────────────────────────────
// طبقة الرسائل تعرف من النصّ أن الطرف حسابُك، والتصنيف يعيد حساب النوع من
// النصّ نفسه فلا يعرف ذلك. واختبارُ الطبقة وحدها كان يمرّ بينما تنكسر الدورة.

test('الحوالة إلى حسابك تبقى مستبعدة عبر الدورة كاملة لا في طبقة الرسائل وحدها', async () => {
  const { applyClassification } = await import('../src/classify.js');
  const { markExclusions } = await import('../src/analytics.js');
  const sms = 'حوالة محلية صادرة مقبولة\nالى:حسابي في الراجحي\nمبلغ:5000 SAR\nفي:2026/09/10 18:23';
  const t = smsToTransaction(parseBankSMS(sms, { sender: 'BankAlbilad' }), { id: 'm1', text: sms });
  const list = [t];
  applyClassification(list);
  markExclusions(list, { analysis: {} });
  assert.equal(list[0].type, 'internal', 'وإلا عاد نوعها «حوالة صادرة» فمُحي استبعادها');
  assert.equal(list[0].excluded, true, 'وإلا حُسب التحويل مع المشتريات التي موّلها');
});

test('حوالة الرسائل إلى حسابك تخضع لنقطة التحوّل كسائر الداخلي', async () => {
  const { applyClassification } = await import('../src/classify.js');
  const { markExclusions } = await import('../src/analytics.js');
  const mk = (d) => {
    const sms = `حوالة محلية صادرة مقبولة\nالى:حسابي في الراجحي\nمبلغ:5000 SAR\nفي:${d} 18:23`;
    return smsToTransaction(parseBankSMS(sms, { sender: 'BankAlbilad' }), { id: `m${d}`, text: sms });
  };
  const list = [mk('2026/06/10'), mk('2026/09/10')];
  applyClassification(list);
  markExclusions(list, { analysis: { ownTransfersSpendUntil: '2026-08-09' } });
  assert.equal(list[0].excluded, false, 'قبل التحوّل: التحويل هو الصرف');
  assert.equal(list[1].excluded, true, 'بعده: التفصيل يصل من الرسائل فيُستبعد التحويل');
});

test('سداد فاتورة البطاقة بصيغة الراجحي يُعرف فلا يُحسب مع مشترياتها', () => {
  const p = parseBankSMS('خصم مستحقات البطاقات الائتمانية\nمبلغ: 2984.44 SAR\nفي: 06/08/2026');
  assert.equal(p.kind, 'card_payment');
  const t = smsToTransaction(p, { id: 'c1', text: 'x' });
  assert.equal(t.excluded, true);
});

test('سجلّ الحصاد: يجمع اليوم، ويقلّم القديم، ويعدّ الأسبوع', async () => {
  const { recordDrain, lastDays, pruneLog } = await import('../src/inbox.js');
  let log = {};
  log = recordDrain(log, '2026-08-09', 3);
  log = recordDrain(log, '2026-08-09', 2);   // سحبتان في يومٍ واحد تُجمعان
  log = recordDrain(log, '2026-08-07', 4);
  log = recordDrain(log, '2026-08-09', 0);   // سحبةٌ بلا جديد لا تُسجَّل
  assert.equal(log['2026-08-09'], 5);
  assert.equal(log['2026-08-08'], undefined);

  const week = lastDays(log, '2026-08-09', 7);
  assert.equal(week.rows.length, 7);
  assert.equal(week.rows[0].date, '2026-08-09', 'الأحدث أولًا');
  assert.equal(week.total, 9);

  const old = pruneLog({ '2026-08-09': 1, '2025-01-01': 9 }, '2026-08-09');
  assert.deepEqual(Object.keys(old), ['2026-08-09'], 'ما جاوز ثلاثين يومًا يُطرح');
});

test('اللصق: يفصل الرسائل بسطرٍ فارغ ولا يضاعف ما لُصق مرتين', async () => {
  const { parsePasted } = await import('../src/inbox.js');
  const two = `شراء عبر نقاط البيع
لدى:JAVA JOY C
مبلغ:74 SAR
8/8/26 23:23

شراء إنترنت بـSR 237.13
لـExpress F
رصيد:8835.8 SR
8/8/26 20:55`;

  const r = parsePasted(two, { today: '2026-08-09' });
  assert.equal(r.total, 2, 'السطر الفارغ يفصل، وأسطرُ الرسالة الواحدة لا تلتبس به');
  assert.equal(r.added.length, 2);
  assert.equal(r.failed.length, 0);
  assert.equal(r.added[0].amount, -74);
  assert.equal(r.added[0].date, '2026-08-08');
  assert.equal(r.added[1].amount, -237.13);

  // المعرّف من مضمون الرسالة لا من لحظة اللصق: فبصمتها لا تتغيّر بإعادته
  const again = parsePasted(two, { today: '2026-08-09' });
  assert.deepEqual(again.added.map((t) => t.hash), r.added.map((t) => t.hash),
    'وإلا ضاعف اللصقُ الثاني العملياتِ على من ظنّ أن الأول لم ينجح');
});

test('اللصق يفرز ما لم يُفهم ولا يبتلعه', async () => {
  const { parsePasted } = await import('../src/inbox.js');
  const r = parsePasted('شراء عبر نقاط البيع\nلدى:X\nمبلغ:10 SAR\n8/8/26 10:00\n\nكلام لا معنى له', { today: '2026-08-09' });
  assert.equal(r.added.length, 1);
  assert.equal(r.failed.length, 1);
  assert.ok(r.failed[0].reason);
});

// حين لا تصل رسائل مصرفٍ بعينه، لا يُعرف أين انقطع الطريق. فيُسجَّل من وصل.
test('سجلّ المصادر: يعدّ ويؤرّخ ويُقلّم ما جاوز ثلاثين يومًا', async () => {
  const { recordSenders } = await import('../src/inbox.js');
  let log = recordSenders({}, ['BankAlbilad', 'Alrajhi', 'BankAlbilad'], '2026-08-01');
  assert.deepEqual(log.BankAlbilad, { n: 2, last: '2026-08-01' });
  assert.deepEqual(log.Alrajhi, { n: 1, last: '2026-08-01' });

  log = recordSenders(log, ['Alrajhi'], '2026-08-11');
  assert.deepEqual(log.Alrajhi, { n: 2, last: '2026-08-11' });
  assert.equal(log.BankAlbilad.last, '2026-08-01', 'من لم تصل منه رسالةٌ يبقى بتاريخه');

  const pruned = recordSenders(log, [], '2026-09-05');
  assert.ok(!pruned.BankAlbilad, 'ما جاوز ثلاثين يومًا يسقط');
  assert.ok(pruned.Alrajhi, 'والقريب يبقى');
});

test('السحب يخبر بمن وصل، ولو لم يصر عمليةً', async (t) => {
  const { drain } = await import('../src/inbox.js');
  const msgs = [
    { id: 'a', sender: 'BankAlbilad', text: 'شراء نقاط بيع\nمدى1234 Apple Pay\nبـ55 SAR\nمنمتجر\n2026-08-10 21:07', receivedAt: '2026-08-10T18:07:00Z' },
    { id: 'b', sender: '', text: 'مشتريات انترنت\nمدى1234\nبـ20 SAR\nمنمتجر آخر', receivedAt: '2026-08-10T18:10:00Z' },
    { id: 'c', sender: 'Unknown-X', text: 'نصٌّ لا يدلّ على شيء', receivedAt: '2026-08-10T18:12:00Z' },
  ];
  const calls = [];
  global.fetch = async (url, opt) => {
    calls.push([opt?.method || 'GET', url]);
    if ((opt?.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ messages: msgs }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  t.after(() => { delete global.fetch; });

  const out = await drain('a'.repeat(32));
  assert.deepEqual(out.arrived, ['BankAlbilad', 'بنك البلاد', 'Unknown-X'],
    'المرسِل أوّلًا، فإن غاب فالمصرف من نصّ الرسالة');
  assert.equal(out.added.length, 2);
  assert.equal(out.failed.length, 1, 'ما لم يُفهم يبقى ليُراجَع');
});

/**
 * الرسالة الواحدة قد تصل مرتين: بإعادة محاولةٍ من أتمتة الجوال، أو بأتمتتين
 * يلتقط شرطاهما رسالةً واحدة. وكانت البصمة تُبنى من معرّف الإيداع فتُضاعَف.
 */
test('هويّةُ الرسالة مضمونُها لا لحظةُ وصولها', async () => {
  const { parseBankSMS, smsToTransaction, parsePasted } = await import('../src/inbox.js');
  const { dedupe } = await import('../src/import.js');
  const T = 'شراء نقاط بيع\nمدى5002 Apple Pay\nبـ440 SAR\nمنمتجر\n2026-08-10 21:07';
  const p = parseBankSMS(T, { today: '2026-08-11' });
  const a = smsToTransaction(p, { id: 'إيداع-١', text: T }, 'إشعارات البنك');
  const b = smsToTransaction(p, { id: 'إيداع-٢', text: T }, 'إشعارات البنك');

  assert.equal(a.hash, b.hash, 'إيداعان لرسالةٍ واحدة');
  const { fresh, dups } = dedupe([a, b], new Set());
  assert.equal(fresh.length, 1, 'لا تُحتسب مرتين');
  assert.equal(dups.length, 1);

  // ولا تُبتلع عمليتان مختلفتان: قوالب المصارف الثلاثة كلُّها تحمل وقتها
  const T2 = T.replace('21:07', '21:40');
  const c = smsToTransaction(parseBankSMS(T2, { today: '2026-08-11' }), { id: 'إيداع-٣', text: T2 }, 'إشعارات البنك');
  assert.notEqual(a.hash, c.hash, 'شراءان بالمبلغ نفسه في وقتين');

  // واللصق والسحب على هويةٍ واحدة: من لصق ما وصل تلقائيًا لا يُضاعفه
  const pasted = parsePasted(T, { today: '2026-08-11', accountLabel: 'إشعارات البنك' });
  assert.equal(pasted.added[0].hash, a.hash, 'الملصوقة والمسحوبة رسالةٌ واحدة');
});

test('رسالةٌ بلا نصّ لا تُسقط البصمة', async () => {
  const { parseBankSMS, smsToTransaction } = await import('../src/inbox.js');
  const p = parseBankSMS('شراء نقاط بيع\nمدى5002\nبـ7 SAR\nمنمتجر\n2026-08-10 21:07', { today: '2026-08-11' });
  const t = smsToTransaction(p, { id: 'x', text: '' }, 'إشعارات البنك');
  assert.ok(t.hash, 'يرجع إلى معرّف الإيداع');
});

// السحب يمحو ما فُهم من الصندوق، فإن لم يظهر أثرُه لم يبقَ ما يُراجَع
test('السحب يعيد نصَّ ما وصل بحكمه، لا عدَده فقط', async (t) => {
  const { drain } = await import('../src/inbox.js');
  const msgs = [
    { id: 'a', sender: 'BankAlbilad', text: 'شراء نقاط بيع\nمدى1234 Apple Pay\nبـ55 SAR\nمنمتجر\n2026-08-12 21:07', receivedAt: '2026-08-12T18:07:00Z' },
    { id: 'b', sender: 'BankAlbilad', text: 'مُدخل الاختصار', receivedAt: '2026-08-12T18:10:00Z' },
  ];
  global.fetch = async (url, opt) => ({ ok: true, status: 200, json: async () => ((opt?.method || 'GET') === 'GET' ? { messages: msgs } : { ok: true }) });
  t.after(() => { delete global.fetch; });

  const { raw } = await drain('a'.repeat(32));
  assert.equal(raw.length, 2, 'كلُّ ما وصل، لا ما فُهم منه');
  assert.equal(raw[0].ok, true);
  assert.match(raw[0].text, /نقاط بيع/, 'النصّ كما وصل ليُقارَن بالرسالة');
  assert.equal(raw[0].sender, 'BankAlbilad');
  assert.equal(raw[1].ok, false, 'وحقلٌ أُسيء إعداده يظهر بنصّه فيُعرف');
  assert.ok(raw[1].reason);
});
