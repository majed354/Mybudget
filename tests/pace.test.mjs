import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paceGrade } from '../src/views.js';

// حدود السلّم: القيمة على الحدّ تنتمي إلى الدرجة الأدنى، فلا تُترك ثغرة
test('سلّم الوتيرة: خمس درجات بحدودٍ مغلقة من أعلى', () => {
  const cases = [
    [0, '▲▲', 'good'], [0.70, '▲▲', 'good'],
    [0.7001, '▲', 'good'], [0.95, '▲', 'good'],
    [0.9501, '●', 'ok'], [1.05, '●', 'ok'],
    [1.0501, '▼', 'warn'], [1.30, '▼', 'warn'],
    [1.3001, '▼▼', 'bad'], [99, '▼▼', 'bad'],
  ];
  for (const [pace, m, cls] of cases) {
    const g = paceGrade(pace, 0);
    assert.equal(g.mark, m, `الرمز عند ${pace}`);
    assert.equal(g.cls, cls, `اللون عند ${pace}`);
  }
});

test('العبارة تُنتقى باليوم فتثبت في اليوم الواحد وتدور بين الأيام', () => {
  const a = paceGrade(0.5, 7), b = paceGrade(0.5, 7), c = paceGrade(0.5, 8);
  assert.equal(a.say, b.say, 'اليوم الواحد لا يعطي عبارتين');
  assert.notEqual(a.say, c.say, 'يومان لا يعطيان عبارة واحدة');
  assert.ok(a.say.length > 0);
});

// عبارةٌ مشجّعة فوق رقمٍ متجاوز تُفسد الأداة: التجاوز يُحطّ ولو حسنت الوتيرة
test('لا مجاملة: كل درجات التجاوز عباراتُها زاجرة', () => {
  for (const pace of [1.06, 1.3, 2, 10]) {
    const g = paceGrade(pace, 0);
    assert.ok(['warn', 'bad'].includes(g.cls), `${pace} يجب ألّا يكون أخضر`);
    assert.ok(/خفِّف|تجاوزت|أوقف|بعيد/.test(g.say), `عبارة ${pace}: ${g.say}`);
  }
  for (const pace of [0, 0.5, 0.94]) {
    assert.equal(paceGrade(pace, 0).cls, 'good', `${pace} يجب أن يكون أخضر`);
  }
});

test('وتيرةٌ غير رقمية تُعامل صفرًا لا تنهار', () => {
  for (const bad of [null, undefined, NaN, Infinity]) {
    assert.ok(paceGrade(bad, 0).mark, String(bad));
  }
});
