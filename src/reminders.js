// التذكيرات: تُشتقّ من كشوفك نفسها لا من إعدادات تكتبها.
//
// حدّ تقني يجب أن يكون صريحًا: الويب لا يوقظ التطبيق وهو مغلق ما لم يوجد
// خادم دفع (Web Push). فهذه التذكيرات تظهر حين تفتح التطبيق أو يكون عاملًا،
// وهو ما يناسب تذكيرًا شهريًا لا إنذارًا لحظيًا.

import { monthKey, sum } from './util.js';

/**
 * @param {object} a  مخرجات analyze
 * @param {string} today تاريخ ISO
 * @returns {Array<{id, title, body, kind, dueDay}>}
 */
export function computeReminders(a, today = new Date().toISOString().slice(0, 10)) {
  if (!a) return [];
  const out = [];
  const day = Number(today.slice(8, 10));
  const thisMonth = today.slice(0, 7);

  // ١) الكشف قديم: البيانات لا تصف حاضرك
  const last = a.coverage?.to;
  if (last) {
    const lastDate = lastDayOf(last, a);
    const gap = daysBetween(lastDate, today);
    if (gap >= 35) {
      out.push({
        id: `stale:${thisMonth}`,
        kind: 'import',
        title: 'حدِّث كشف الحساب',
        body: `آخر عملية مسجّلة قبل ${Math.round(gap)} يومًا. استورد كشفًا جديدًا لتبقى أرقام الملاءة صادقة.`,
      });
    }
  }

  // ٢) الأقساط والالتزامات الثابتة: تنبيه قبل يومين من موعدها
  for (const r of a.recurring || []) {
    if (!(r.type === 'loan' || r.type === 'standing_order')) continue;
    const diff = r.day - day;
    if (diff < 0 || diff > 2) continue;
    out.push({
      id: `due:${r.key}:${thisMonth}`,
      kind: 'commitment',
      dueDay: r.day,
      title: diff === 0 ? 'التزام يُستحقّ اليوم' : `التزام بعد ${diff} يوم`,
      body: `${r.label} — ${Math.round(r.amount)} ر.س يوم ${r.day} من الشهر.`,
    });
  }

  // ٣) الراتب: تذكير بمراجعة الميزانية يوم نزوله
  if (a.income?.salary && a.income.salary.day === day) {
    out.push({
      id: `salary:${thisMonth}`,
      kind: 'income',
      dueDay: day,
      title: 'يوم الراتب',
      body: `الراتب ${Math.round(a.income.salary.amount)} ر.س. راجع خطة الشهر قبل أن يُصرف.`,
    });
  }

  // ٤) تجاوز الوتيرة: أنفقتَ حتى اليوم أكثر مما اعتدت في مثل هذا اليوم
  const pace = spendPace(a, today);
  if (pace && pace.ratio >= 1.25 && pace.spent > 500) {
    out.push({
      id: `pace:${thisMonth}`,
      kind: 'pace',
      title: 'وتيرة الصرف أعلى من المعتاد',
      body: `أنفقت ${Math.round(pace.spent)} ر.س حتى اليوم ${day}، مقابل ${Math.round(pace.usual)} ر.س في مثل هذه الفترة عادةً.`,
    });
  }

  return out;
}

/** الإنفاق حتى يوم كذا من الشهر الحالي، مقابل المعتاد في الفترة نفسها. */
export function spendPace(a, today) {
  const day = Number(today.slice(8, 10));
  const cur = today.slice(0, 7);
  const rows = (a.list || []).filter((t) => !t.excluded && t.amount < 0);
  const upTo = (mk) => sum(rows.filter((t) => monthKey(t.date) === mk && Number(t.date.slice(8, 10)) <= day).map((t) => -t.amount));

  const spent = upTo(cur);
  const past = (a.solidMonths || []).filter((m) => m.key !== cur).map((m) => upTo(m.key)).filter((v) => v > 0);
  if (past.length < 3) return null;
  const usual = past.slice().sort((x, y) => x - y)[Math.floor(past.length / 2)];
  if (!usual) return null;
  return { spent, usual, ratio: spent / usual };
}

function lastDayOf(monthKeyStr, a) {
  const dates = (a.list || []).map((t) => t.date).filter((d) => d.startsWith(monthKeyStr));
  return dates.sort().pop() || `${monthKeyStr}-28`;
}

function daysBetween(from, to) {
  return (Date.parse(to) - Date.parse(from)) / 86400000;
}

// ── العرض عبر عامل الخدمة ────────────────────────────────────────────────

export async function ensurePermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

/** يعرض ما استحقّ ولم يُعرض بعد، ويعيد ما عُرض. */
export async function fireDue(reminders, alreadyShown = []) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return [];
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  const seen = new Set(alreadyShown);
  const fired = [];
  for (const r of reminders) {
    if (seen.has(r.id)) continue;
    const payload = { type: 'notify', title: r.title, body: r.body, tag: r.id, url: './index.html' };
    if (reg?.active) reg.active.postMessage(payload);
    else if (reg) await reg.showNotification(r.title, { body: r.body, tag: r.id, dir: 'rtl', lang: 'ar' });
    else new Notification(r.title, { body: r.body, dir: 'rtl', lang: 'ar' });
    fired.push(r.id);
  }
  return fired;
}
