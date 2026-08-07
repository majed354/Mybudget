// يسرد المبالغ «الغامضة» كي يفسّرها صاحب الحساب: تحويلات، سحب نقدي، غير مصنّف.
// node tests/ambiguous.mjs <ملف.xlsx> [...]

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pickStatementSheet, rowsToTransactions } from '../src/import.js';
import { applyClassification } from '../src/classify.js';
import { analyze } from '../src/analytics.js';
import { money, monthLabel, groupBy, sum } from '../src/util.js';

const require = createRequire(import.meta.url);
const XLSX = require('../vendor/xlsx.full.min.js');

const all = [];
for (const f of process.argv.slice(2)) {
  const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer', codepage: 1256 });
  const sheets = {};
  for (const n of wb.SheetNames) sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
  const picked = pickStatementSheet(sheets);
  const account = /ثاني/.test(f) ? 'الثاني' : 'الرئيسي';
  all.push(...rowsToTransactions(picked.grid, { account, details: picked?.details }).transactions);
}
applyClassification(all);
const a = analyze(all, { analysis: {} });

/** يستخرج اسم المستفيد ورقم الآيبان من نص الحوالة. */
function payee(t) {
  const txt = (t.details || t.desc || '').replace(/\n/g, ' ');
  const iban = txt.match(/SA\d{22}/)?.[0] || '';
  const name = txt.match(/[A-Z][A-Z\s]{6,40}(?=\s*,|\s*رقم)/)?.[0]?.trim()
    || txt.match(/[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,4}/)?.[0] || '';
  return { name: name.replace(/\s+/g, ' ').trim(), iban };
}

const rows = a.list.filter((t) => !t.excluded && t.amount < 0);
const section = (title, list) => {
  if (!list.length) return;
  console.log(`\n${'═'.repeat(70)}\n${title} — ${list.length} عملية، ${money(sum(list.map((t) => -t.amount)))}\n${'═'.repeat(70)}`);
  for (const t of list.sort((x, y) => x.date.localeCompare(y.date))) {
    const p = payee(t);
    console.log(`${t.date}  ${money(-t.amount).padStart(14)}  ${t.account.padEnd(8)} ${(p.name || t.merchant || '—').slice(0, 32).padEnd(34)} ${p.iban || t.ref || ''}`);
  }
};

// التجميع بالآيبان: المستفيد الواحد يُفسَّر مرة واحدة لا في كل حوالة
const ibanOf = (t) => (t.details || t.desc || '').replace(/\n/g, ' ').match(/SA\d{22}/)?.[0] || '';
const nameByIban = new Map();
for (const t of a.list) {
  const ib = ibanOf(t);
  if (!ib) continue;
  const nm = payee(t).name;
  if (nm && !nameByIban.has(ib)) nameByIban.set(ib, nm);
}
const outs = a.list.filter((t) => !t.excluded && t.amount < 0 && t.type === 'transfer_out');
const ins = a.list.filter((t) => t.amount > 0 && /حوالة|حواله/.test(t.bankType || ''));
const inByIban = new Set(ins.map(ibanOf).filter(Boolean));

console.log(`\n${'═'.repeat(78)}\nالتحويلات الصادرة مجمَّعة بالمستفيد — ${outs.length} حوالة، ${money(sum(outs.map((t) => -t.amount)))}\n${'═'.repeat(78)}`);
const byIban = groupBy(outs, (t) => ibanOf(t) || 'بلا آيبان');
const groups = [...byIban.entries()].map(([ib, list]) => ({
  iban: ib,
  name: nameByIban.get(ib) || payee(list[0]).name || '—',
  n: list.length,
  total: sum(list.map((t) => -t.amount)),
  first: list.map((t) => t.date).sort()[0],
  last: list.map((t) => t.date).sort().pop(),
  twoWay: inByIban.has(ib),
})).sort((x, y) => y.total - x.total);
for (const g of groups) {
  console.log(`${money(g.total).padStart(15)} | ${String(g.n).padStart(2)} حوالة | ${g.first} → ${g.last} | ${g.name.slice(0, 24).padEnd(26)} | ${g.iban}${g.twoWay ? '  ⇄ يرد منه أيضًا' : ''}`);
}

section('تفصيل التحويلات الصادرة', outs);
section('سحب نقدي من الصراف', rows.filter((t) => t.type === 'atm_out'));

const unc = rows.filter((t) => (t.category || 'other') === 'other');
console.log(`\n${'═'.repeat(70)}\nمشتريات غير مصنّفة — ${unc.length} عملية، ${money(sum(unc.map((t) => -t.amount)))}\n${'═'.repeat(70)}`);
const byMerchant = groupBy(unc, (t) => t.merchantKey || 'بلا اسم');
const merged = [...byMerchant.entries()]
  .map(([, list]) => ({ name: list[0].merchant || '(بلا اسم تاجر)', city: list[0].city || '', n: list.length, total: sum(list.map((t) => -t.amount)) }))
  .sort((x, y) => y.total - x.total);
for (const m of merged) console.log(`${money(m.total).padStart(14)}  ${String(m.n).padStart(3)} مرة  ${m.name.slice(0, 38).padEnd(40)} ${m.city}`);

console.log(`\n${'═'.repeat(70)}\nالخلاصة الشهرية للغامض\n${'═'.repeat(70)}`);
const amb = rows.filter((t) => ['transfers', 'cash', 'other'].includes(t.category || 'other'));
const byMonth = groupBy(amb, (t) => t.date.slice(0, 7));
for (const [k, list] of [...byMonth.entries()].sort()) {
  const tr = sum(list.filter((t) => t.category === 'transfers').map((t) => -t.amount));
  const ca = sum(list.filter((t) => t.category === 'cash').map((t) => -t.amount));
  const ot = sum(list.filter((t) => (t.category || 'other') === 'other').map((t) => -t.amount));
  console.log(`${monthLabel(k).padEnd(14)} تحويلات ${money(tr).padStart(14)} | نقدي ${money(ca).padStart(12)} | غير مصنّف ${money(ot).padStart(12)}`);
}
