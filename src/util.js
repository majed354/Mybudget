// أدوات مشتركة: تنسيق، أرقام عربية، إحصاء وصفي.

/** رقم النسخة — يظهر في الإعدادات ليُعرف أي شيفرة تعمل فعلًا على الجهاز. */
export const APP_VERSION = '1.5.1';

export const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** يحوّل الأرقام العربية/الفارسية إلى لاتينية ويزيل المحارف الاتجاهية. */
export function normalizeDigits(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d])
    .replace(/[‎‏‪-‮؜]/g, '')
    .replace(/٫/g, '.')   // الفاصلة العشرية العربية
    .replace(/٬/g, ',');  // فاصل الآلاف العربي
}

/** يستخرج عددًا من نص قد يحوي فواصل آلاف أو إشارة سالبة بين قوسين. */
export function parseNumber(raw) {
  if (raw == null) return null;
  let s = normalizeDigits(raw).trim();
  if (!s) return null;
  // الإشارة السالبة قد تقع خلف رمز العملة: «SAR -2,984.44» و«ر.س -50.00».
  // فيُفتَّش عنها في كلّ ما يسبق أوّل رقم، لا في أوّل النصّ وحده — إذ كان
  // الفحص على أوّله فلا يجدها، ثم تُمحى مع سائر الحروف، فينقلب المدين
  // دائنًا. ولا تُجرَّد الحروف قبل الفحص: نقطةُ «ر.س» تنجو منها فتُفسد الرقم.
  const firstDigit = s.search(/\d/);
  if (firstDigit < 0) return null;
  const neg = /[-(]/.test(s.slice(0, firstDigit)) || /-\s*$/.test(s);
  s = s.slice(firstDigit).replace(/[^\d.,]/g, '');
  if (!s) return null;
  // لو كان آخر فاصل «,» ويليه رقمان فهو عشري (نادر) وإلا فهو فاصل آلاف
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot && s.length - lastComma === 3) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

const MONEY_FMT = new Intl.NumberFormat('ar-SA-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT_FMT = new Intl.NumberFormat('ar-SA-u-nu-latn', { maximumFractionDigits: 0 });

export function money(n, opts = {}) {
  if (n == null || !isFinite(n)) return '—';
  const v = opts.round ? INT_FMT.format(Math.round(n)) : MONEY_FMT.format(n);
  return opts.bare ? v : `${v} ر.س`;
}
export function num(n, digits = 0) {
  if (n == null || !isFinite(n)) return '—';
  return new Intl.NumberFormat('ar-SA-u-nu-latn', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}
export function pct(n, digits = 1) {
  if (n == null || !isFinite(n)) return '—';
  return `${num(n * 100, digits)}٪`;
}

const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
/** "2026-03" → "مارس 2026" */
export function monthLabel(key) {
  if (!key) return '—';
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1] || m} ${y}`;
}
export function monthKey(isoDate) { return String(isoDate).slice(0, 7); }
export function dateLabel(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** يحوّل صيغ التواريخ الشائعة في كشوف البنوك السعودية إلى ISO. */
export function toISODate(raw, opts = {}) {
  if (!raw) return null;
  const s = normalizeDigits(raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    return iso(+m[1], +m[2], +m[3]);
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += y > 50 ? 1900 : 2000;
    // dd/mm افتراضًا (السائد في البنوك السعودية) ما لم يستحل ذلك
    let d = a, mo = b;
    if (opts.monthFirst || (b > 12 && a <= 12)) { d = b; mo = a; }
    if (mo > 12 || d > 31) return null;
    return iso(y, mo, d);
  }
  // 12 Mar 2026 / 12-MAR-26
  const EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})/))) {
    const mo = EN[m[2].toLowerCase()];
    if (!mo) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return iso(y, mo, +m[1]);
  }
  return null;
}
function iso(y, m, d) {
  if (!(y >= 1990 && y <= 2100) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** يضيف أشهرًا إلى تاريخ ISO. */
export function addMonths(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  return t.toISOString().slice(0, 10);
}

// ── إحصاء وصفي ────────────────────────────────────────────────────────────
export function sum(a) { return a.reduce((s, x) => s + (x || 0), 0); }
export function mean(a) { return a.length ? sum(a) / a.length : 0; }
export function median(a) { return percentile(a, 0.5); }

export function percentile(arr, p) {
  const a = arr.filter((x) => isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  if (a.length === 1) return a[0];
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/** الانحراف المطلق المتوسط عن الوسيط — أمتن من الانحراف المعياري أمام القيم الشاذة. */
export function mad(arr) {
  if (!arr.length) return 0;
  const m = median(arr);
  return median(arr.map((x) => Math.abs(x - m)));
}

/** معامل الاختلاف (تشتت نسبي). */
export function cv(arr) {
  const m = mean(arr);
  if (!m) return 0;
  const sd = Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
  return sd / Math.abs(m);
}

/** ميل الاتجاه الخطي (وحدة/شهر) عبر المربعات الصغرى. */
export function trendSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(values);
  let num2 = 0, den = 0;
  values.forEach((y, i) => { num2 += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den ? num2 / den : 0;
}

export function groupBy(arr, fn) {
  const map = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

export function uid() {
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/**
 * تجزئة مستقرة لكشف التكرار عند إعادة الاستيراد.
 *
 * لا يُعتمد على «الرقم المرجعي» وحده: بنك البلاد يضع في أقساط التمويل رقمَ
 * العقد (LD…) لا رقم العملية، فيتكرر الرقم نفسه كل شهر. الاعتماد عليه مفتاحًا
 * يبتلع أقساطًا حقيقية بلا أثر. فالمفتاح هو التاريخ والمبلغ والحساب، والمرجعُ
 * تمييزٌ إضافي، وترتيبُ الظهور (occ) يفصل المتطابقات داخل الملف نفسه.
 */
export function hashTx(t, occ = 0) {
  const key = [
    t.account || '',
    t.date || '',
    Math.round((t.amount || 0) * 100),
    t.ref || (t.desc || '').slice(0, 60),
    `#${occ}`,
  ].join('|');
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
