// تشغيل المحرّك على كشف حقيقي خارج المتصفح — للتحقق من الأرقام قبل الاعتماد.
// node tests/harness.mjs <ملف.xlsx> [ملف2.xlsx ...]

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pickStatementSheet, rowsToTransactions } from '../src/import.js';
import { applyClassification } from '../src/classify.js';
import { analyze } from '../src/analytics.js';
import { profileFromAnalytics, evaluate, planTerms, DEFAULT_POLICY } from '../src/affordability.js';
import { money, pct, num, monthLabel } from '../src/util.js';

const require = createRequire(import.meta.url);
const XLSX = require('../vendor/xlsx.full.min.js');

const files = process.argv.slice(2);
if (!files.length) { console.error('مرّر ملف كشف واحدًا على الأقل'); process.exit(1); }

const all = [];
for (const f of files) {
  const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer', codepage: 1256 });
  const sheets = {};
  for (const n of wb.SheetNames) sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
  const picked = pickStatementSheet(sheets);
  const grid = picked ? picked.grid : Object.values(sheets).flat();
  const account = f.split('/').pop().replace(/\.[^.]+$/, '').slice(0, 24);
  const res = rowsToTransactions(grid, { account, source: f, details: picked?.details });
  console.log(`\n▸ ${f}`);
  console.log(`  ورقة: ${picked?.name || '—'} | عمليات: ${res.transactions.length} | متجاوَز: ${res.skipped}`);
  console.log(`  تدقيق الأرصدة: ${res.balanceCheck?.checked ? `${res.balanceCheck.mismatches}/${res.balanceCheck.total} فرق` : 'غير متاح'}`);
  res.warnings.forEach((w) => console.log('  ⚠', w));
  all.push(...res.transactions);
}

applyClassification(all);
const a = analyze(all, { analysis: {} });

console.log('\n══ التغطية ══');
console.log(`  ${a.coverage.txCount} عملية | ${a.coverage.months} شهرًا (${a.coverage.solid} مكتملًا) | ${a.coverage.from} → ${a.coverage.to}`);
console.log(`  مستبعد: داخلي ${a.excluded.internal.length} | مرتجع ${a.excluded.reversal.length} | استثنائي ${a.excluded.extraordinary.length}`);
console.log(`  غير مصنّف: ${pct(a.coverage.uncategorizedShare)} (${money(a.coverage.uncategorizedAmount)})`);

console.log('\n══ الدخل ══');
console.log(`  وسيط الدخل المتكرر: ${money(a.income.median)} | متحفظ: ${money(a.income.p25)}`);
if (a.income.salary) console.log(`  الراتب: ${money(a.income.salary.amount)} يوم ${a.income.salary.day} (${a.income.salary.count} مرة)`);
console.log(`  وارد غير متكرر (مستبعد): ${money(a.income.oneOffTotal)} في ${a.income.oneOffCount} دفعة`);

console.log('\n══ الصرف ══');
console.log(`  وسيط شهري: ${money(a.spend.median)} | ربيع أعلى: ${money(a.spend.p75)} | تذبذب: ${pct(a.spend.cv)}`);
console.log(`  ملتزم: ${money(a.essentials.p50)} | مرن+غامض: ${money(a.discretionary.p50)}`);
console.log(`  معدل الادخار: ${pct(a.savingsRate)} | أقساط قائمة: ${money(a.existingInstallments)}`);

console.log('\n══ الأشهر ══');
a.months.forEach((m) => console.log(`  ${monthLabel(m.key).padEnd(14)} صرف ${money(m.spend).padStart(16)} | دخل ${money(m.income).padStart(16)} ${m.partial ? '(ناقص)' : ''}`));

console.log('\n══ المجالات ══');
a.categories.forEach((c) => console.log(`  ${c.ar.padEnd(22)} ${money(c.monthlyAvg).padStart(14)}/شهر | ${pct(c.share, 1).padStart(7)} | ${String(c.count).padStart(4)} عملية | ${c.group}`));

console.log('\n══ أعلى التجار ══');
a.merchants.slice(0, 12).forEach((m) => console.log(`  ${String(m.name).slice(0, 34).padEnd(36)} ${money(m.total).padStart(14)} | ${m.count} مرة`));

console.log('\n══ البنود المتكررة ══');
a.recurring.slice(0, 12).forEach((r) => console.log(`  ${String(r.label).slice(0, 30).padEnd(32)} ${money(r.amount).padStart(13)} | ${r.months} شهر | يوم ${r.day}`));

const profile = profileFromAnalytics(a);
console.log('\n══ اختبار الملاءة ══');
for (const amount of [50000, 100000, 200000, 300000]) {
  const req = { amount, months: 60, annualRate: 0.0599, mode: 'flat' };
  const ev = evaluate(profile, req, DEFAULT_POLICY);
  const plan = planTerms(profile, { amount, annualRate: 0.0599, mode: 'flat' }, DEFAULT_POLICY);
  console.log(`  ${money(amount).padStart(16)} × 60 شهرًا → قسط ${money(ev.installment).padStart(13)} | ${ev.verdictAr.padEnd(16)} (${ev.score}) | فائض ${money(ev.baseSurplus).padStart(13)} | ضغط ${money(ev.stressSurplus).padStart(13)} | أنسب مدى: ${plan.range ? `${plan.range[0]}–${plan.range[1]} شهرًا، الأفضل ${plan.best.months}` : 'لا يوجد'}`);
}
const p60 = planTerms(profile, { amount: 100000, annualRate: 0.0599, mode: 'flat' }, DEFAULT_POLICY);
console.log(`  أقصى مبلغ بأريحية (72 شهرًا): ${money(p60.maxComfortableAmount)} | مع ضغط: ${money(p60.maxTightAmount)}`);
