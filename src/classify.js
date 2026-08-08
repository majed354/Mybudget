// تصنيف العمليات: نوع العملية، ثم استخراج اسم التاجر، ثم مجال الصرف.

// ── أنواع العمليات ────────────────────────────────────────────────────────
export const TYPES = {
  pos:            { ar: 'نقاط بيع', icon: '💳' },
  ecom:           { ar: 'شراء إلكتروني', icon: '🌐' },
  atm_out:        { ar: 'سحب نقدي', icon: '🏧' },
  cash_in:        { ar: 'إيداع نقدي', icon: '💵' },
  bill:           { ar: 'سداد فاتورة', icon: '🧾' },
  standing_order: { ar: 'أمر مستديم', icon: '🔁' },
  loan:           { ar: 'قسط تمويل', icon: '🏦' },
  financing:      { ar: 'صرف تمويل', icon: '📥' },
  transfer_out:   { ar: 'حوالة صادرة', icon: '📤' },
  transfer_in:    { ar: 'حوالة واردة', icon: '📩' },
  internal:       { ar: 'تحويل بين حساباتي', icon: '🔄' },
  fee:            { ar: 'رسوم بنكية', icon: '✂️' },
  salary:         { ar: 'راتب', icon: '💰' },
  other:          { ar: 'أخرى', icon: '•' },
};

const TYPE_RULES = [
  [/تحويل من حساب (لحساب|الى حساب)|بين حسابات العميل|own\s*account/i, 'internal'],
  [/رواتب|payroll|salary/i, 'salary'],
  [/نقاط بيع|نقاط البيع|point of sale|\bpos\b/i, 'pos'],
  [/شراء بواسطة الأنترنت|تجارة الكترونية|e-?commerce|online purchase/i, 'ecom'],
  [/سحب آلي|سحب نقدي|صراف|\batm\b/i, 'atm_out'],
  [/(ايداع|إيداع) نقدي|cash deposit/i, 'cash_in'],
  [/رسوم|عمولة|\bcharge\b|\bfee\b/i, 'fee'],
  [/(سداد|دفع).*(فاتورة|قسط|رسوم)|sadad/i, null], // يُفصَّل أدناه
  [/أمر مستديم|امر مستديم|standing order/i, 'standing_order'],
  [/commodity payable|payable amount/i, 'financing'],
  [/قسط تمويل|تمويل شخصي|مرابحة|تورق|installment/i, 'loan'],
  [/وارد|واردة|incoming/i, 'transfer_in'],
  [/صادر|صادرة|حوالة|حواله|outgoing|transfer/i, 'transfer_out'],
];

export function classifyType(desc, amount, bankType) {
  const d = `${bankType || ''} ${desc || ''}`;
  // «سداد» تفصيل: قسط تمويل ≠ فاتورة ≠ رسوم
  if (/سداد|دفع فاتورة/.test(d)) {
    if (/قسط|تمويل/.test(d)) return 'loan';
    if (/رسوم/.test(d)) return 'fee';
    if (/فاتورة/.test(d)) return 'bill';
  }
  for (const [re, type] of TYPE_RULES) {
    if (!type) continue;
    if (re.test(d)) {
      if (type === 'salary' && amount < 0) continue;
      if (type === 'transfer_out' && amount > 0) return 'transfer_in';
      if (type === 'transfer_in' && amount < 0) return 'transfer_out';
      if (type === 'atm_out' && amount > 0) return 'cash_in';
      return type;
    }
  }
  return 'other';
}

// ── استخراج اسم التاجر ────────────────────────────────────────────────────
// نص كشف بنك البلاد يخرج من الـ PDF مبعثر الاتجاه، فاسم التاجر يُقسم على سطرين:
// عَجُزه في أول السطر الذي فيه رقم الجهاز، وصدره بعد عبارة «موقع قناة تقديم الخدمة».

const CHANNEL_PHRASE = 'موقع قناة تقديم الخدمة';
const CHANNEL_PARTIALS = ['موقع قناة تقديم الخدمة', 'موقع قناة تقديم', 'موقع قناة', 'موقع'];
const BANK_NAMES = /(مؤسسة الراجحي المصرفية للاستثمار|الراجحي|البنك السعودي البريطاني|البنك السعودي للاستثمار|البنك التجاري الوطني|البنك العربي الوطني|بنك البلاد|بنك الرياض|مصرف الإنماء|الإنماء|بنك الجزيرة|البنك الأهلي|بنك الأول|ساب|AL RAJHI BANK|RAJHI|RIYAD BANK|ALINMA|SNB|SABB|\bANB\b)/gi;
const NOISE = /(الرقم المرجعي للعملية|الرقم المرجعي|رقم مرجع العملية|مرجع العملية|اسم قناة تقديم الخدمة|اسم قناة تقديم|قناة تقديم الخدمة|نوع العملية|للعملية|الخدمة|الرقم|المرجعي)/g;
const CITY_RE = /\b(MAKKAH|MECCA|JEDDAH|RIYADH|TAIF|MADINA|MEDINA|YANBU|DAMMAM|KHOBAR|ABHA|TABUK|HAIL|JAZAN|NAJRAN|BURAIDAH|ALKHOBAR|WESTERN REGIO[N]?)\b/i;

// ── الحوالات: المستفيد والغرض ─────────────────────────────────────────────
// كشف بنك البلاد يذكر في تفاصيل كل حوالة «الغرض» الذي اختاره المُرسِل،
// و«شخصي في بنك آخر» تعني تحويلًا إلى حساب المستخدم نفسه لدى بنك آخر —
// وهذه أهم إشارة في الكشف كله، إذ تفصل نقلَ المال عن الصرف.

export const PURPOSE_SELF = 'شخصي في بنك آخر';
const PURPOSES = [
  [/شخصي في بنك آخر/, PURPOSE_SELF],
  [/شراء\s*\/?\s*بيع بضاع/, 'شراء أو بيع بضاعة'],
  [/تحويلات عائلية|إعالة/, 'إعالة'],
  [/تبرع|صدقة/, 'تبرع'],
  [/راتب|أجور/, 'رواتب'],
];

/** @returns {{iban:string, purpose:string}} */
export function extractTransferInfo(t) {
  const txt = String(t.details || t.desc || '').replace(/\n/g, ' ');
  const iban = (txt.match(/SA\d{2}[A-Z0-9]{18,22}/) || txt.match(/\b\d{15}\b/) || [''])[0];
  let purpose = '';
  for (const [re, label] of PURPOSES) if (re.test(txt)) { purpose = label; break; }
  return { iban, purpose };
}

/** @returns {{name:string, city:string, channel:string}} */
export function extractMerchant(t) {
  const full = t.details || '';
  const src = full || t.desc || '';
  if (!src) return { name: '', city: '', channel: '' };

  const lines = String(src).split('\n').map((s) => s.trim()).filter(Boolean);
  let head = '', tail = '', city = '', channel = '';

  for (const ln of lines) {
    let i = -1, phrase = '';
    for (const p of CHANNEL_PARTIALS) {
      const k = ln.indexOf(p);
      if (k >= 0) { i = k; phrase = p; break; }
    }
    if (i >= 0 && !head) {
      head = ln.slice(i + phrase.length).trim();
      const before = ln.slice(0, i);
      const cm = before.match(CITY_RE);
      if (cm) city = cm[1].toUpperCase();
    }
    if (!city) { const cm = ln.match(CITY_RE); if (cm) city = cm[1].toUpperCase(); }
    if (/Apple pay|Electronic|مدى أثير|Mada Atheer/i.test(ln)) {
      channel = /Apple pay/i.test(ln) ? 'Apple Pay' : (/Electronic/i.test(ln) ? 'إلكتروني' : 'مدى');
    }
  }

  for (const ln of lines) {
    if (!ln.includes('+')) continue;
    const parts = ln.split('+').map((s) => s.trim()).filter(Boolean);
    const hasTerminal = parts.some((p) => /^\d{10,}$/.test(p) || /^[A-Z0-9]{6,12}$/.test(p));
    if (!hasTerminal) continue;
    const cand = parts.filter((p) => !/^\d{6,}$/.test(p) && !new RegExp(BANK_NAMES.source, 'i').test(p) && p.length > 1);
    const named = cand.find((p) => /\s/.test(p) || /[a-z]/.test(p) || /[؀-ۿ]/.test(p));
    if (named) tail = named;
    break;
  }

  let name = clean(`${head} ${tail}`);
  // السطر الأول في التفاصيل هو نوع العملية، فنتخطّاه — إلا أن يكون النص سطرًا واحدًا
  if (!name) name = clean(lines.length > 1 ? lines.slice(1).join(' ') : lines.join(' '));
  return { name, city, channel };
}

// رموز أجهزة الشبكة وبطاقات الدفع تتسرّب إلى النص، ولو بقيت لأفسدت تجميع التجار.
const TERMINAL_CODES = /\b([A-Z]{2,4}S2I\d{1,3}|NCRWRG\d*|RAJHIA[A-Z0-9]*|[A-Z]{2,5}\d{2}[A-Z]\d{6,})\b/g;
const CARD_NOISE = /(\*{3,}\d*|\d{6}\*+\d*|Apple\s*pay|Google\s*pay|Electronic|بطاقة مدى|مدى أثير|فيزا|ماستر ?كارد|نوع العملية|عملية شراء|شراء بواسطة|نقاط البيع|تقديم الخدمة|اسم قناة|قناة|تقديم|نوع|الخدمة)/gi;

function clean(s) {
  let x = String(s || '')
    .replace(NOISE, ' ')
    .replace(TERMINAL_CODES, ' ')
    .replace(BANK_NAMES, ' ')
    .replace(CITY_RE, ' ')
    .replace(CARD_NOISE, ' ')
    .replace(/FT\d{8,}|LD\d{6,}|BPP[A-Z0-9]{6,}/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/[+/:،|*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // بقايا أرقام لاصقة بآخر الاسم مثل Al Rkhaa7783
  x = x.replace(/(\D)\d{3,}\b/g, '$1').trim();
  // العبارات النمطية في ذيل السطر تلتصق باسم التاجر بعد بعثرة الاتجاه.
  // نقطعها متى سبقها اسم لاتيني مفهوم، ونُبقيها إن كان الاسم نفسه عربيًا.
  const TAIL = /(شركة|العملية|بواسطة|بطاقة|الائتمان|سحب نقدي|مؤسسة|المصرفية|للاستثمار|تاريخ|وقت|رقم|فرع|المدينة|موقع)/;
  const cut = x.search(TAIL);
  if (cut > 0 && /[A-Za-z]{3}/.test(x.slice(0, cut))) x = x.slice(0, cut).trim();
  x = x.replace(/^[\s\-_.]+|[\s\-_.]+$/g, '');
  return x.length < 2 ? '' : x.slice(0, 60);
}

/** مفتاح تجميع التاجر — يوحّد الاختلافات الطفيفة في الكتابة. */
export function merchantKey(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\b(EST|ESTT|ESTABLISHMENT|CO|COMPANY|LLC|FOR|THE|AL|BIN|IBN|MOASSAT|MHL|MAHL)\b/g, ' ')
    .replace(/[^A-Z؀-ۿ0-9]/g, '')
    .slice(0, 24);
}

// ── مجالات الصرف ──────────────────────────────────────────────────────────
export const CATEGORIES = [
  { id: 'housing',   ar: 'سكن وإيجار',           group: 'ملتزم',    color: '#6366f1' },
  { id: 'utilities', ar: 'فواتير ومرافق',         group: 'ملتزم',    color: '#0ea5e9' },
  { id: 'telecom',   ar: 'اتصالات وإنترنت',       group: 'ملتزم',    color: '#38bdf8' },
  { id: 'education', ar: 'تعليم',                 group: 'ملتزم',    color: '#14b8a6' },
  { id: 'insurance', ar: 'تأمين',                 group: 'ملتزم',    color: '#22c55e' },
  { id: 'debt',      ar: 'أقساط وتمويل',          group: 'ملتزم',    color: '#ef4444' },
  { id: 'support',   ar: 'إعالة والتزامات أسرية', group: 'ملتزم',    color: '#f97316' },
  { id: 'fees',      ar: 'رسوم بنكية وحكومية',    group: 'ملتزم',    color: '#475569' },
  { id: 'groceries', ar: 'بقالة وتموين',          group: 'شبه ثابت', color: '#84cc16' },
  { id: 'transport', ar: 'وقود ومواصلات',         group: 'شبه ثابت', color: '#f59e0b' },
  { id: 'health',    ar: 'صحة وأدوية',            group: 'شبه ثابت', color: '#10b981' },
  { id: 'services',  ar: 'خدمات منزلية',          group: 'شبه ثابت', color: '#0891b2' },
  { id: 'dining',    ar: 'مطاعم وقهوة',           group: 'مرن',      color: '#e11d48' },
  { id: 'shopping',  ar: 'تسوق وملابس',           group: 'مرن',      color: '#d946ef' },
  { id: 'tech',      ar: 'إلكترونيات وأجهزة',     group: 'مرن',      color: '#8b5cf6' },
  { id: 'subs',      ar: 'اشتراكات وترفيه',       group: 'مرن',      color: '#a855f7' },
  { id: 'sports',    ar: 'رياضة ولياقة',          group: 'مرن',      color: '#f43f5e' },
  { id: 'travel',    ar: 'سفر وفنادق',            group: 'مرن',      color: '#06b6d4' },
  { id: 'gifts',     ar: 'هدايا ومناسبات',        group: 'مرن',      color: '#fb7185' },
  { id: 'charity',   ar: 'زكاة وصدقة',            group: 'مرن',      color: '#34d399' },
  { id: 'cash',      ar: 'سحب نقدي',              group: 'غامض',     color: '#94a3b8' },
  { id: 'transfers', ar: 'تحويلات لأشخاص',        group: 'غامض',     color: '#64748b' },
  { id: 'invest',    ar: 'ادخار واستثمار',        group: 'ادخار',    color: '#0d9488' },
  { id: 'other',     ar: 'غير مصنّف',             group: 'غامض',     color: '#9ca3af' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const GROUP_OF = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.group]));
export const ESSENTIAL_GROUPS = new Set(['ملتزم', 'شبه ثابت']);
export const FLEX_GROUPS = new Set(['مرن']);
export const AMBIGUOUS_GROUPS = new Set(['غامض']);

// قاموس تجار السوق السعودي — أسماء نقاط البيع تُكتب لاتينية غالبًا وبإملاء حر.
const MERCHANT_RULES = [
  // منصات معروفة تُحسم أولًا قبل الكلمات العامة
  [/AMAZON|NOON|SHEIN|ALIEXPRESS|NAMSHI|TEMU|IHERB|TABBY|TAMARA|MADFU/i, 'shopping'],
  [/KEETA|HUNGERSTATION|JAHEZ|TALABAT|MRSOOL|NINJA|DELIVERY HERO|CHEFZ|Express Food/i, 'dining'],
  [/STC ?PAY|BARQ|URPAY|WALLET|MAHFAZA/i, 'transfers'],
  // منصات التمويل الجماعي: المال يخرج استثمارًا لا استهلاكًا
  [/RAQAMYAH|LENDO|FORUS|MANAFA|SUKUK|TADAWUL|DERAYAH|ALJAZIRA CAPITAL|رقمية|منافع/i, 'invest'],
  [/SNAP ?FIN|SULFAH|TAMWEEL|FINANC/i, 'debt'],
  [/RESTURANT|RESTAURANT|REST\b|MATAM|MTAM|BUFFET|BUFET|CAFE|COFFEE|KAHWA|QAHWA|BURGER|PIZZA|SHAWARM|SHAWERM|BROAST|GRILL|MANDI|KABSA|FOUL|FUL\b|TAMIAH|TAAMIAH|MOAJANAT|MUAJANAT|FATEER|JUICE|BEVERAG|CHOCOLA|HALWA|BAKER|MKHBZ|MAKHBAZ|SWEET|HALAWIYAT|ICE ?CREAM|DONUT|KUDU|HERFY|ALBAIK|AL ?BAIK|MCDONALD|STARBUCKS|DUNKIN|BASKIN|SUBWAY|KFC|PAPA JOHN|DOMINO|TAZAJ|MAESTRO|BARN|DOSE|HALF ?MILLION|JAVA|CAFETERIA|KAFETERIA|MHAMES|MANAQISH|MNAQISH|MANTO|MKHA\b|MOKHA|HALAWANI|BISCOTI|BISCUIT|ZAFARAN|CATERING|FRIED FOOD|HANEETH|HANITH|MATEAM|MTAAM|MATAAM|SHABYAT|ALSHABYAT|SNABEL|SANABEL|SHAWAYA|MALHAM|ALKALDAH|MOKHTAR ALSHAM|JAVA|DIWANIYA|مطعم|مطاعم|كافيه|قهوة|مخبز|حلويات|بوفيه|عصير|مشويات|بيت المعجنات/i, 'dining'],
  [/PHARMAC|SAIDALIA|SYDLIA|NAHDI|DAWAA|AL ?DAWAA|WHITES|HOSPITAL|MUSTASHFA|CLINIC|MAJMA TIBBI|MEDICAL|DENTAL|OPTICAL|OPTIC|NAZARAT|LAB\b|MOKHTABAR|صيدلي|مستشفى|عيادة|طبي|مختبر|أسنان/i, 'health'],
  [/MARKET|SUPERMARKET|HYPER|BAQALA|BAKALA|TAMWEEN|TMWYNAT|TAMWINAT|FOODSTUFF|GROCER|MHAMS|MHAMES ARD|TAHON|TAHOON|TMWENAT|TMWYNAT|TAMWINAT|\bMKT\b|KHAYRAT|BAKALAH|BQALA|PANDA|OTHAIM|TAMIMI|CARREFOUR|LULU|DANUBE|BINDAWOOD|MANUEL|NESTO|FARM SUPER|SPAR|أسواق|بقالة|تموينات|سوبرماركت|هايبر|مواد غذائية/i, 'groceries'],
  [/SASCO|ALDREES|AL ?DREES|PETROL|GAS ?STATION|MAHATA|BENZIN|FUEL|ARAMCO|SAPTCO|UBER|CAREEM|JEENY|TAXI|LIMO|PARKING|MAWQIF|TOLL|SPEED TRACK|CAR WASH|GHASEEL|\bGS\b|DOKAN CAR|GAS ?ST|TIRE|KAWTCH|WORKSHOP|WARSHA|SPARE PART|QITA GHIAR|محطة|وقود|بنزين|مواصلات|أجرة|غسيل سيارات|قطع غيار|ورشة/i, 'transport'],
  [/LAUNDR|LAUNDER|MAGHSALA|MGHSL|DRY ?CLEAN|CLEANING|NADAFA|MAINTENANCE|SIANA|PLUMB|ELECTRIC[A-Z]* SERVICE|CARPENT|NAJAR|مغسلة|تنظيف|صيانة|سباك|نجار|كهربائي/i, 'services'],
  [/STC|MOBILY|ZAIN|SALAM|GO TELECOM|TELECOM|JAWWAL|شحن رصيد|اتصالات|موبايلي|زين|سوا/i, 'telecom'],
  [/JARIR|\bEXTRA\b|XCITE|APPLE STORE|ITUNES|APP STORE|SAMSUNG|HUAWEI|LAPTOP|COMPUTER|MOBILE SHOP|JAWALAT|COPUTAR|COMPUTAR|جرير|اكسترا|إلكترونيات|جوالات|حاسب/i, 'tech'],
  [/NETFLIX|SPOTIFY|SHAHID|OSN|STARZ|GOOGLE|APPLE\.COM|ITUNES|PLAYSTATION|XBOX|STEAM|GAME|CINEMA|MUVI|VOX|AMC|ENTERTAIN|MALAHI|THEME PARK|سينما|ترفيه|ملاهي|اشتراك/i, 'subs'],
  [/GYM|FITNESS|SPORT|NADI|PADEL|FOOTBALL|MALAB|SWIM|YOGA|BODY|نادي|رياض|لياقة|ملعب|بادل/i, 'sports'],
  [/HOTEL|FUNDUQ|RESORT|MUNTAJA|BOOKING|AIRLINE|AIRWAYS|FLYNAS|FLYADEAL|SAUDIA|AIRPORT|TRAVEL|SIYAHA|TOURISM|فندق|منتجع|طيران|مطار|سفر|سياحة/i, 'travel'],
  [/MALL|FASHION|BOUTIQUE|CLOTH|MALABES|TEXTILE|QUMASH|SHOES|AHDIYA|PERFUME|OUD|ATTAR|OTOOR|COSMETIC|MAKEUP|BEAUTY|SALON|HALAQA|BARBER|MOZAYIN|GOLD|DHAHAB|JEWEL|MOJAWHARAT|WATCH|SAAT|FURNITURE|ATHATH|MSHGHAL|MSHGHL|MASHGHAL|TAILOR|KHAYYAT|ABAYAT|ALABAYAT|FLOWER|ZOHOOR|WARD\b|CANDLE|LAMSAT|JAMAL EST|MFARSH|MFRSH|ALBARKAH LLMFARSH|HOME ?CENTER|IKEA|SACO|TOYS|أزياء|ملابس|أحذية|عطور|عود|تجميل|صالون|حلاق|ذهب|مجوهرات|أثاث|هدايا/i, 'shopping'],
  [/SCHOOL|MADRASA|ACADEMY|AKADIMIA|INSTITUTE|MAHAD|UNIVERSITY|JAMIA|TRAINING|TADREEB|COURSE|DOWRA|NURSERY|HADANA|KINDERGART|LIBRARY|MAKTABA|مدرسة|أكاديمية|معهد|جامعة|تدريب|دورة|حضانة|روضة|مكتبة/i, 'education'],
  [/INSURANCE|ATZAMEEN|TAMEEN|TAAMEEN|TAWUNIYA|BUPA|MEDGULF|WALAA|SALAMA|تأمين|بوبا|التعاونية/i, 'insurance'],
  [/CHARIT|JAMEIAH|JAMIYAH|JAMIYA|WAQF|SADAQA|ZAKAT|EHSAN|EHSAAN|جمعية|وقف|صدقة|زكاة|إحسان|تبرع/i, 'charity'],
  [/REAL ?ESTATE|AQAR|EJAR|IJAR|RENT|MASKAN|عقار|إيجار|أجرة سكن|إسكان/i, 'housing'],
  [/ELECTRICITY|SEC\b|WATER|MIYAH|NATIONAL WATER|كهرباء|المياه|الصرف الصحي/i, 'utilities'],
  [/ABSHER|MOI|MUROOR|JAWAZAT|AHWAL|MUNICIPAL|AMANA|BALADIYA|TRAFFIC FINE|MUKHALAFA|أبشر|المرور|الجوازات|الأحوال|أمانة|بلدية|مخالفة|رسوم حكومية/i, 'fees'],
];

/** يخمّن المجال من اسم التاجر — لا يُستخدم إلا حين لا توجد قاعدة مستخدم. */
export function guessCategoryFromMerchant(name) {
  if (!name) return null;
  for (const [re, cat] of MERCHANT_RULES) if (re.test(name)) return cat;
  return null;
}

/** المجال المستنتج من الغرض المعلن في الحوالة. */
export const PURPOSE_CATEGORY = {
  'شراء أو بيع بضاعة': 'shopping',
  'إعالة': 'support',
  'تبرع': 'charity',
};

/** المجال المستنتج من نوع العملية وحده. */
export function defaultCategory(type) {
  switch (type) {
    case 'bill': return 'utilities';
    case 'standing_order': return 'support';
    case 'loan': return 'debt';
    case 'atm_out': return 'cash';
    case 'transfer_out': return 'transfers';
    case 'fee': return 'fees';
    default: return 'other';
  }
}

// ── قواعد المستخدم ────────────────────────────────────────────────────────
// {id, field:'merchant'|'desc'|'amount'|'type', op, value, value2, category, priority}

export function ruleMatches(rule, t) {
  const v = rule.value;
  switch (rule.field) {
    case 'merchant': {
      const k = t.merchantKey || '';
      const n = String(t.merchant || '').toUpperCase();
      if (rule.op === 'key') return k && k === v;
      return n.includes(String(v).toUpperCase());
    }
    case 'desc': {
      const d = `${t.desc || ''} ${t.details || ''}`;
      if (rule.op === 'regex') { try { return new RegExp(v, 'i').test(d); } catch { return false; } }
      return d.includes(v);
    }
    case 'type': return t.type === v;
    case 'amount': {
      const a = Math.abs(t.amount);
      if (rule.op === 'equals') return Math.abs(a - Math.abs(Number(v))) < 0.005;
      if (rule.op === 'range') return a >= Number(v) && a <= Number(rule.value2);
      return false;
    }
    default: return false;
  }
}

/**
 * يبني حقول التصنيف لكل عملية.
 * السلطة: وسم المستخدم ← قواعده ← قاموس التجار ← نوع العملية.
 */
export function applyClassification(transactions, rules = [], own = {}) {
  const sorted = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const ownIbans = new Set(own.ibans || []);
  const ownMerchants = new Set(own.merchants || []);
  for (const t of transactions) {
    t.type = classifyType(t.desc, t.amount, t.bankType);
    if (t.type === 'transfer_out' || t.type === 'transfer_in') {
      const info = extractTransferInfo(t);
      t.beneficiaryIban = info.iban;
      t.purpose = info.purpose;
      // الحوالة إلى حسابك في بنك آخر نقلُ مالٍ لا صرف
      if (t.purpose === PURPOSE_SELF || ownIbans.has(t.beneficiaryIban)) t.type = 'internal';
    }
    if (t.type === 'pos' || t.type === 'ecom' || t.type === 'atm_out') {
      // رسالة البنك تذكر اسم التاجر صريحًا، فلا حاجة لانتزاعه من نصّ الكشف
      const m = t.merchantHint ? { name: t.merchantHint, city: '', channel: 'SMS' } : extractMerchant(t);
      t.merchant = m.name;
      t.city = m.city;
      t.channel = m.channel;
      t.merchantKey = merchantKey(m.name);
      // شحنُ محفظتك (STC Pay، برق…) نقلُ مالٍ لا صرف — ما دمت وسمتها بذلك
      if (t.merchantKey && ownMerchants.has(t.merchantKey)) t.type = 'internal';
    }
    if (t.categorySource === 'user') continue;
    const rule = sorted.find((r) => ruleMatches(r, t));
    if (rule) { t.category = rule.category; t.categorySource = 'rule'; t.ruleId = rule.id; continue; }
    const guess = guessCategoryFromMerchant(t.merchant);
    if (guess) { t.category = guess; t.categorySource = 'merchant'; t.ruleId = null; continue; }
    const byPurpose = PURPOSE_CATEGORY[t.purpose];
    if (byPurpose) { t.category = byPurpose; t.categorySource = 'purpose'; t.ruleId = null; continue; }
    t.category = defaultCategory(t.type);
    t.categorySource = 'auto';
    t.ruleId = null;
  }
  return transactions;
}

// الالتزامات الدورية تتكرّر بمبلغٍ ثابت، وقد يكون للنوع الواحد التزامان
// مختلفان (أمر مستديم بـ٢١٠٥ وآخر بـ٣٣٠)، فتعميمُ الوسم بالنوع يخلط بينهما.
const FIXED_AMOUNT_TYPES = new Set(['standing_order', 'loan', 'bill', 'fee']);

/** قاعدة مقترحة من وسمٍ يدوي، لتعميمه على أشباه العملية لا على ما يخالفها. */
export function suggestRule(t, category) {
  if (t.merchantKey) return { field: 'merchant', op: 'key', value: t.merchantKey, category, label: t.merchant };
  const amountRule = { field: 'amount', op: 'equals', value: Math.abs(t.amount), category, label: `مبلغ ${Math.abs(t.amount)}` };
  if (FIXED_AMOUNT_TYPES.has(t.type)) return amountRule;
  if (t.type && t.type !== 'pos') return { field: 'type', op: 'equals', value: t.type, category, label: TYPES[t.type]?.ar };
  return amountRule;
}
