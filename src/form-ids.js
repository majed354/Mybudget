// عقد معرّفات الحقول: أيّ حقلٍ يخصّ أيّ نموذج.
//
// كان التوجيه بالبادئات، وهو هشّ بطبعه: `f-cat` مرشِّحٌ و`f-amount` تمويل،
// وكلاهما يبدأ بـ`f-` — فسبق شرطُ التمويل شرطَ المرشِّح، فبقي مرشِّح المجال
// والحساب لا يعمل بلا خطأٍ ظاهر. ثم أُضيف `b-limit` فلم تعرفه بادئةٌ أصلًا،
// فكان الحدّ الشهري لا يُحفظ.
//
// فالعضوية هنا صريحة لا مستنتجة، ويحرسها اختبارٌ يقارن هذه المجموعات بما في
// الواجهة فعلًا: كل حقلٍ يجب أن يطالبه نموذجٌ واحد، لا صفرٌ ولا اثنان.

/** حقول نموذج التمويل في شاشة الملاءة. */
export const FINANCE_IDS = new Set(['f-amount', 'f-months', 'f-rate', 'f-mode', 'f-known']);

/** حقول ترشيح قائمة العمليات. */
export const FILTER_IDS = new Set(['q', 'f-cat', 'f-acc', 'f-uncat', 'f-exc']);

/** حقول شاشة الإعدادات: السياسة، والمعالجة، والتجاوز اليدوي، والميزانية. */
export const SETTINGS_RE = /^(p|a|m|b)-/;

/** حقول لها معالجٌ خاصّ بها، فلا تُنسب إلى نموذج. */
export const STANDALONE_IDS = new Set([
  'file-input', 'acc-name', 'pdf-pass', 'gate-code', 'paste-text',
  'tag-cat', 'tag-sub', 'tag-exclude',   // محرّر التصنيف: يُقرأ عند الحفظ لا عند التغيير
]);

export function formOf(id) {
  if (!id) return null;
  if (FINANCE_IDS.has(id)) return 'finance';
  if (FILTER_IDS.has(id)) return 'filter';
  if (STANDALONE_IDS.has(id)) return 'standalone';
  if (SETTINGS_RE.test(id)) return 'settings';
  return null;
}
