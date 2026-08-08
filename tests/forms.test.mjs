// حارس عقد الحقول: كل حقلٍ في الواجهة يجب أن يطالبه نموذجٌ واحد — لا صفرٌ
// ولا اثنان. هذا الاختبار كان سيكشف عطبين وقعا فعلًا: مرشِّح المجال الذي
// ابتلعه نموذج التمويل لاشتراكهما في البادئة `f-`، وحدُّ الإنفاق الذي لم
// تعرفه بادئةٌ أصلًا فلم يُحفظ.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formOf, FINANCE_IDS, FILTER_IDS, STANDALONE_IDS } from '../src/form-ids.js';

const views = fs.readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');

/**
 * معرّفات الحقول وحدها — لا كل ما له `id` في الصفحة.
 * الحقل ما يُدخل المستخدم فيه قيمة: input أو select أو textarea. أما
 * `<div id="dropzone">` فمنطقة إفلاتٍ لها معالجها ولا تُنسب إلى نموذج.
 */
function fieldIds() {
  const ids = new Set();
  for (const m of views.matchAll(/<(?:input|select|textarea)\b[^>]*?\bid="([a-z][\w-]*)"/gs)) ids.add(m[1]);
  // numField('m-income', …) يبني الحقل برمجيًّا فلا يظهر وسمه كاملًا في النصّ
  for (const m of views.matchAll(/numField\(\s*'([^']+)'/g)) ids.add(m[1]);
  return [...ids];
}

test('كل حقلٍ في الواجهة يطالبه نموذجٌ واحد', () => {
  const orphans = fieldIds().filter((id) => formOf(id) === null);
  assert.deepEqual(orphans, [], `حقولٌ لا يعرفها أي نموذج: ${orphans.join(', ')}`);
});

test('لا حقلَ يطالبه نموذجان', () => {
  const both = [...FINANCE_IDS].filter((id) => FILTER_IDS.has(id) || STANDALONE_IDS.has(id));
  assert.deepEqual(both, [], `تعارض: ${both.join(', ')}`);
});

test('العطبان اللذان وقعا لا يعودان', () => {
  // `f-cat` مرشِّح لا تمويل — وكان يذهب إلى التمويل فيموت الترشيح
  assert.equal(formOf('f-cat'), 'filter');
  assert.equal(formOf('f-acc'), 'filter');
  assert.equal(formOf('f-uncat'), 'filter');
  assert.equal(formOf('f-exc'), 'filter');
  // و`f-amount` تمويلٌ لا مرشِّح
  assert.equal(formOf('f-amount'), 'finance');
  assert.equal(formOf('f-months'), 'finance');
  // و`b-limit` إعدادٌ يُحفظ — وكان لا يُحفظ لأن بادئته مجهولة
  assert.equal(formOf('b-limit'), 'settings');
});

test('حقول الإعدادات كلها تُنسب إلى الإعدادات', () => {
  for (const id of ['p-dbrCap', 'a-factor', 'a-own-until', 'm-income', 'b-limit']) {
    assert.equal(formOf(id), 'settings', id);
  }
});
