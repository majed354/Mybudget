// عقد ملخّص أداة الشاشة — يحرسه الخادم لا العميل.
//
// هذا الملخّص هو الطريق الوحيد الذي يخرج منه رقمٌ بلا تشفير، وباختيارٍ صريح
// من صاحب النسخة. وما يُنشر بلا تشفير يجب ألّا يتّسع بسهو: فلو أخطأ التطبيق
// يومًا وأرسل عمليةً أو رصيدًا أو رقم حساب، رُدّ الطلب من الخادم — الحارس
// هنا لا هناك، لأن حارس العميل يسقط بأول خطأ في العميل.

/**
 * رقمُ عقد الملخّص.
 *
 * جهازٌ عالقٌ على نسخةٍ قديمة كان ينشر فوق الحديثة فيدهسها: نسخةٌ لا تعرف
 * دورة الراتب تنشر «اليوم ١٠ من ٣١» بحساب الشهر التقويمي، فتتذبذب الأداة
 * بين حسابين لا يعلم صاحبها لأيّهما يصدّق. وحقولُ الملخّص كلُّها مسموحة في
 * العقدين، فلم يكن للحارس ما يميّز بينهما.
 *
 * فرُقّم العقد: العقد الثاني يعرف الدورة وآفاقها (`dayLimit` و`weekSpent`
 * و`weekLimit`)، والخادم يردّ ما دونه. فيبقى القديم يقرأ ولا يكتب حتى
 * يُحدَّث، ولا يُفسد على الحديث نشرَه.
 */
export const SUMMARY_V = 2;

/** الحقول المسموحة وأنواعها. `list` قائمة عناصر، و`entry` عنصرٌ واحد. */
export const ALLOWED = {
  v: 'number',
  month: 'string',        // 2026-08
  day: 'number',
  daysInMonth: 'number',
  spent: 'number',
  limit: 'number',
  remaining: 'number',
  saved: 'number',
  income: 'number',
  pace: 'number',
  projected: 'number',
  todaySpent: 'number',
  dayLimit: 'number',
  weekSpent: 'number',
  weekLimit: 'number',
  todayCount: 'number',
  monthCount: 'number',
  top: 'list',            // حتى ثلاثة مجالات: {n, a}
  last: 'entry',          // آخر عملية: {n, a, d}
  at: 'string',
};

export const MAX_TOP = 3;
export const MAX_TEXT = 40;

function checkEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'عنصر غير صالح';
  for (const [k, v] of Object.entries(e)) {
    if (!['n', 'a', 'd'].includes(k)) return `مفتاح غير مسموح: ${k}`;
    if (k === 'a') { if (!Number.isFinite(v)) return 'مبلغ غير صالح'; continue; }
    if (typeof v !== 'string' || v.length > MAX_TEXT) return 'نصّ غير صالح';
  }
  return null;
}

/** @returns {string|null} سببُ الرفض، أو null إن كان الملخّص مقبولًا. */
export function validateSummary(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'الجسم ليس كائنًا';
  if (!Number.isFinite(obj.v) || obj.v < SUMMARY_V) {
    return `نسخة التطبيق التي تنشر قديمة (عقد ${obj.v ?? '؟'} دون ${SUMMARY_V}) — حدِّثها`;
  }
  for (const [k, v] of Object.entries(obj)) {
    const want = ALLOWED[k];
    if (!want) return `حقل غير مسموح: ${k}`;
    if (want === 'list') {
      if (!Array.isArray(v)) return `${k} يجب أن يكون قائمة`;
      if (v.length > MAX_TOP) return `${k} أطول من الحد`;
      for (const e of v) { const bad = checkEntry(e); if (bad) return `${k}: ${bad}`; }
      continue;
    }
    if (want === 'entry') {
      if (v === null) continue;
      const bad = checkEntry(v);
      if (bad) return `${k}: ${bad}`;
      continue;
    }
    if (typeof v !== want) return `نوع غير صحيح للحقل ${k}`;
    if (want === 'string' && v.length > MAX_TEXT) return `قيمة أطول من الحد في ${k}`;
    if (want === 'number' && !Number.isFinite(v)) return `رقم غير صالح في ${k}`;
  }
  return null;
}
