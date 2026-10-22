/**
 * الموقع التعريفي العام (قبل تسجيل الدخول): المحتوى القابل للتحرير من الإدارة، والدورات.
 */
import { db, getSetting, setSetting } from '../db.js';
import { HttpError } from '../middleware/auth.js';
import { money } from './store.js';

const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export const SITE_DEFAULTS = {
  brand: 'مثاني',
  hero: {
    eyebrow: 'دورة الاستشفاء',
    title: 'رحلة هادئة إلى <b>طمأنينة القلب</b>',
    text: 'دورة الاستشفاء رفيقٌ لطيف يعينك على ملازمة الذكر والدعاء، بخطوات يسيرة تناسب يومك مهما كان مزدحماً.',
    primary: { label: 'سجّل الآن', href: '#/register' },
    secondary: { label: 'أهدِ دورة', href: '#/gift' },
  },
  about: [
    { icon: '🌿', title: 'الفكرة', text: 'رحلة تعافٍ عملية نحو اليقين والاستغناء بالله.' },
    { icon: '🎯', title: 'الأهداف', text: 'أن ننتقل بك من دائرة الحيرة والبحث عن الحلول عند الآخرين، إلى دائرة اليقين والاستغناء بالله — بخارطة طريق عملية لا دروس عابرة.' },
    { icon: '🧭', title: 'المنهجية', text: 'لقاءات مختصرة، وورد يومي واضح، ومتابعة عبر المنصة، وتذكير مشجّع بلا إحراج ولا مقارنة.' },
  ],
  paths: [
    { icon: '💻', title: 'دورات عن بُعد', text: 'لقاءات مباشرة تحضرها من بيتك، مع تسجيلات تعود إليها متى شئت.', href: '#/site/courses', cta: 'الدورات المتاحة' },
    { icon: '🤲', title: 'العضوية الدائمة', text: 'انتماء مستمر: أوراد ومكتبة ومجتمع ومتابعة طوال العام.', href: '#/site/membership', cta: 'تفاصيل العضوية' },
    { icon: '🗓️', title: 'خطة العام', text: 'اثنتا عشرة دورة على مدار العام. احجز مقعدك مبكراً في الدورة التي تناسبك.', href: '#/site/year-plan', cta: 'خطة العام' },
    { icon: '🏕️', title: 'الخلوات الحضورية', text: 'أيام تنقطع فيها للذكر في مكان هادئ، بعيداً عن الزحام.', href: '#/site/retreats', cta: 'الخلوات القادمة' },
  ],
  gift: {
    title: 'أهدِ دورة لمن تحب',
    text: 'هدية تبقى أثراً: أهدِ دورة الاستشفاء لمريض أو مكروب أو صديق، وتصله بطاقة إهداء لطيفة باسمك أو دون اسم.',
    cta: 'أهدِ دورة الآن',
  },
  faq: [
    { q: 'هل الدورة مناسبة لكل الأعمار؟', a: 'نعم، لغتها بسيطة وخطواتها يسيرة، ويشارك فيها الكبير والصغير.' },
    { q: 'ماذا لو فاتني لقاء؟', a: 'تجد تسجيل اللقاء في حسابك، وتتابع وردك في المنصة متى تيسّر لك.' },
    { q: 'كم تستغرق المتابعة اليومية؟', a: 'دقائق معدودة: تسجّل وردك بضغطة، وتتابع تقدّمك في صفحة واحدة.' },
    { q: 'هل بياناتي محفوظة؟', a: 'نعم، بياناتك وأورادك خاصة بك، ولا تظهر لغيرك، ولا نشارك أرقام الهواتف.' },
  ],
  contact: { whatsapp: '', email: '', note: 'للاستفسار تواصل معنا، ويسعدنا أن نعينك على البدء.' },
  hide_full_courses: false,          // الدورات المكتملة: باهتة (false) أو مخفية (true)
  bank_note: 'بعد التسجيل تصلك تعليمات الدفع، ويؤكد الفريق مقعدك.',
  payment: { phone: '', holder: '' },   // رقم التحويل الافتراضي واسم صاحبه (لكل دورة رقمها الخاص إن حُدّد)
  thanks_text: 'جزاك الله خيراً على تسجيلك. اللهم بارك لنا ولهم في أوقاتنا وأعمالنا، واجعل هذه الدورة سبباً لطمأنينة القلوب وصلاح الحال.',
  gift_settings: {                        // نظام الإهداء: الرسالة الافتراضية وشكل البطاقة ونص الدعاء
    message: 'أهديك هذا المقعد في رحلة نور وشفاء، أسأل الله أن يكتب لك فيها السكينة والطمأنينة 🌿',
    theme: 'green',                       // green | peach | sand
    dua: 'اللهم اجعل هذه الهدية سبباً لشفاء القلوب وطمأنينة الصدور، وبارك لمن أهدى ولمن قَبِل.',
  },
  whatsapp_link: '',                     // رابط مجتمع واتساب العام (يُستعمل للدورة التي لا رابط خاصاً لها)
  receipt_retention_days: 0,             // حذف صور الإيصالات بعد هذه الأيام من التفعيل (0 = لا تُحذف)
};

export function getSite() {
  const saved = getSetting('site', {}) || {};
  return { ...SITE_DEFAULTS, ...saved, hero: { ...SITE_DEFAULTS.hero, ...(saved.hero || {}) }, gift: { ...SITE_DEFAULTS.gift, ...(saved.gift || {}) }, contact: { ...SITE_DEFAULTS.contact, ...(saved.contact || {}) }, payment: { ...SITE_DEFAULTS.payment, ...(saved.payment || {}) }, gift_settings: { ...SITE_DEFAULTS.gift_settings, ...(saved.gift_settings || {}) } };
}
export const setSite = (patch) => setSetting('site', { ...(getSetting('site', {}) || {}), ...patch });

/** الترتيب بصيغة المؤنث: العاشرة، الحادية عشرة… تُستعمل في تسمية دورات الخطة */
const ONES_F = ['', 'الحادية', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة'];
const TENS_F = ['', 'العاشرة', 'العشرون', 'الثلاثون', 'الأربعون', 'الخمسون', 'الستون', 'السبعون', 'الثمانون', 'التسعون'];
const UNITS_F = ['', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة'];
export function ordinalFem(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1) return '';
  if (num < 10) return UNITS_F[num];
  if (num === 10) return 'العاشرة';
  if (num < 20) return `${ONES_F[num % 10]} عشرة`;
  if (num % 10 === 0) return TENS_F[num / 10];
  return `${ONES_F[num % 10]} و${TENS_F[Math.floor(num / 10)]}`;
}

export const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/** حالة المقاعد: متاح / قليل / ممتلئ */
export function seatState(c) {
  if (c.status === 'closed') return { key: 'closed', label: 'التسجيل مغلق', open: false };
  if (c.seats == null) return { key: 'open', label: 'متاح', open: true, left: null };
  const left = Math.max(0, c.seats - c.seats_taken);
  if (left === 0) return { key: 'full', label: 'ممتلئ', open: false, left: 0 };
  if (left <= Math.max(3, Math.ceil(c.seats * 0.2))) return { key: 'few', label: `مقاعد قليلة (${left})`, open: true, left };
  return { key: 'open', label: `متاح (${left} مقعداً)`, open: true, left };
}

/** رابط مجتمع واتساب: https فقط ومن نطاقات واتساب؛ يُرجع '' إن كان فارغاً ويرمي عند عدم الصلاحية */
export function cleanWhatsappLink(v) {
  const link = String(v || '').trim().slice(0, 300);
  if (!link) return '';
  let ok = false;
  try { const u = new URL(link); ok = u.protocol === 'https:' && ['chat.whatsapp.com', 'wa.me', 'whatsapp.com', 'www.whatsapp.com'].includes(u.hostname); } catch { /* */ }
  if (!ok) throw new HttpError(400, 'رابط مجتمع واتساب غير صالح (مثل https://chat.whatsapp.com/…)');
  return link;
}

/** رقم التحويل للدورة: رقمها الخاص إن حُدّد، وإلا الرقم العام */
export function paymentFor(courseId) {
  const site = getSite().payment;
  const row = db.prepare('SELECT pay_phone FROM courses WHERE id=?').get(courseId);
  return { phone: row?.pay_phone || site.phone, holder: site.holder };
}
export const STATUS_LABEL = { draft: 'مسودة', open: 'منشورة', closed: 'مكتملة', archived: 'مؤرشفة' };
/** حالات خطة العام بمسمياتها الخاصة */
export const YEAR_STATUS_LABEL = { draft: 'مسودة', open: 'منشورة', closed: 'منتهية', archived: 'ملغاة' };

export function courseOut(c, { admin = false, full = false } = {}) {
  const seat = seatState(c);
  const left = c.seats == null ? null : Math.max(0, c.seats - c.seats_taken);
  const out = {
    id: c.id, kind: c.kind, title: c.title, summary: c.summary, month: c.month,
    start_date: c.start_date, end_date: c.end_date, time_label: c.time_label, duration_label: c.duration_label,
    instructor: c.instructor, place: c.place, has_image: !!c.image_name,
    price_minor: c.price_minor, price: c.price_minor ? money(c.price_minor) : 'مجاناً', free: c.price_minor === 0,
    course_no: c.course_no, ordinal: c.course_no ? ordinalFem(c.course_no) : '',
    seats: c.seats, seats_left: left, seat_state: seat.key, seat_label: seat.label,
    can_register: seat.open && c.status === 'open',
    updated_at: c.updated_at,
  };
  if (full) Object.assign(out, {
    description: c.description, goals: parseList(c.goals), topics: parseList(c.topics), faq: parseList(c.faq), schedule: parseList(c.schedule),
    attend_note: c.attend_note,
  });
  if (admin) Object.assign(out, {
    status: c.status, status_label: (c.kind === 'year_month' ? YEAR_STATUS_LABEL : STATUS_LABEL)[c.status], seats_taken: c.seats_taken, sort: c.sort,
    description: c.description, goals: parseList(c.goals), topics: parseList(c.topics), faq: parseList(c.faq), schedule: parseList(c.schedule),
    attend_link: c.attend_link, attend_note: c.attend_note, created_at: c.created_at,
    pay_phone: c.pay_phone, whatsapp_link: c.whatsapp_link, thanks_text: c.thanks_text,
  });
  return out;
}

export function listCourses(kind, { admin = false } = {}) {
  const rows = db.prepare(
    `SELECT * FROM courses WHERE kind = ?${admin ? '' : " AND status IN ('open','closed')"} ORDER BY sort, month, start_date, id`,
  ).all(kind);
  const out = rows.map((c) => courseOut(c, { admin }));
  if (admin || !getSite().hide_full_courses) return out;
  return out.filter((c) => c.can_register);   // الإدارة تختار إخفاء المكتملة
}

export const getCourse = (id, opts) => {
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(id));
  return c ? courseOut(c, opts) : null;
};

/** خطة العام مرتبة زمنياً، مع تحديد الدورة القادمة تلقائياً بحسب التاريخ */
export function yearPlan({ admin = false, today } = {}) {
  const day = today || new Date(Date.now() + 240 * 60_000).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT * FROM courses WHERE kind='year_month'${admin ? '' : " AND status IN ('open','closed')"} ORDER BY start_date, course_no, id`,
  ).all();
  const out = rows.map((c) => {
    const o = courseOut(c, { admin });
    o.is_past = !!(c.end_date && c.end_date < day);
    o.can_register = o.can_register && !o.is_past;
    if (o.is_past) { o.seat_state = 'closed'; o.seat_label = 'انتهت'; }
    return o;
  });
  const next = out.find((c) => !c.is_past && c.status !== 'draft' && c.status !== 'archived')
    || out.find((c) => !c.is_past);
  if (next) next.is_next = true;
  return out;
}
