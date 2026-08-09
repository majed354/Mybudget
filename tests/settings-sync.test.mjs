import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots } from '../src/sync.js';

const snap = (stamps, settings, extra = {}) => ({
  version: 1,
  settingsAt: Object.values(stamps).sort().pop() || null,
  settingsStamps: stamps,
  settings,
  transactions: [], rules: [], accounts: {}, deleted: {},
  ...extra,
});

const OLD = '2026-07-20T09:00:00Z';
const SET = '2026-08-01T10:00:00Z';
const NEW = '2026-08-05T12:00:00Z';

/**
 * العطب الذي جعل أداة الشاشة تتذبذب بين «١٤ من ٣١» و«٩ من ٣١»:
 * تفعيلُ الأداة على الحاسوب رفع ختمَه الواحد، فورث سيادةَ بابٍ لم يمسّه،
 * فعادت `cycleStartDay` من ٢٧ إلى ١ فحُسبت الدورةُ بالشهر الميلادي.
 */
test('تغييرُ بابٍ لا يورث سيادةَ ما لم يُغيَّر', () => {
  const phone = snap(
    { budget: SET, widget: OLD, analysis: OLD },
    { budget: { cycleStartDay: 27, monthlyLimit: 10000 }, widget: { enabled: false }, analysis: { excludeInternal: true } },
  );
  const laptop = snap(
    { budget: OLD, widget: NEW, analysis: OLD },
    { budget: { cycleStartDay: 1, monthlyLimit: 10000 }, widget: { enabled: true, token: 'x' }, analysis: { excludeInternal: true } },
  );

  for (const [a, b, who] of [[laptop, phone, 'الحاسوب يدمج'], [phone, laptop, 'الجوال يدمج']]) {
    const m = mergeSnapshots(a, b);
    assert.equal(m.settings.budget.cycleStartDay, 27, `${who}: يوم بداية الدورة`);
    assert.equal(m.settings.widget.enabled, true, `${who}: تفعيل الأداة`);
  }
});

test('الأختام تُدمج بالأحدث لكل باب، والختم الواحد يبقى للنسخ القديمة', () => {
  const a = snap({ budget: SET, widget: OLD }, { budget: { x: 1 }, widget: { y: 1 } });
  const b = snap({ budget: OLD, widget: NEW }, { budget: { x: 2 }, widget: { y: 2 } });
  const m = mergeSnapshots(a, b);
  assert.deepEqual(m.settingsStamps, { budget: SET, widget: NEW });
  assert.equal(m.settingsAt, NEW, 'الختم الواحد = أحدثُ الأبواب، يقرأه جهازٌ لم يُحدَّث');
});

// جهازٌ على نسخةٍ أقدم لا يبعث خريطة: يُحمل ختمُه الواحد على أبوابه كلها
test('التوافق مع لقطةٍ بلا خريطة أختام', () => {
  const modern = snap({ budget: SET }, { budget: { cycleStartDay: 27 } });
  const legacy = { version: 1, settingsAt: OLD, settings: { budget: { cycleStartDay: 1 } }, transactions: [], rules: [], accounts: {}, deleted: {} };
  assert.equal(mergeSnapshots(modern, legacy).settings.budget.cycleStartDay, 27, 'الأحدث يفوز');
  assert.equal(mergeSnapshots(legacy, modern).settings.budget.cycleStartDay, 27, 'ولو كان القديم محلّيًا');

  const legacyNewer = { ...legacy, settingsAt: NEW };
  assert.equal(mergeSnapshots(modern, legacyNewer).settings.budget.cycleStartDay, 1, 'ختمُ القديم إن كان أحدث يسود — كما كان');
});

// بابٌ أُضيف في نسخةٍ أحدث يجب ألّا يسقط لأن الطرف الآخر لا يعرفه
test('بابٌ عند طرفٍ دون الآخر يُؤخذ لا يُسقط', () => {
  const withNew = snap({ subcategories: NEW }, { subcategories: { food: ['قهوة'] } });
  const without = snap({ budget: SET }, { budget: { cycleStartDay: 27 } });
  const m = mergeSnapshots(without, withNew);
  assert.deepEqual(m.settings.subcategories, { food: ['قهوة'] });
  assert.equal(m.settings.budget.cycleStartDay, 27);
});
