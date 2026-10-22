/**
 * الإهداء: المُهدي يدفع رسوم دورة ويُهديها لآخر. تراجع الإدارة الإيصال، فتُرسل بطاقة برابط يُستعمل مرة واحدة
 * وصالح حتى بداية الدورة، ويستلمها المُهدى إليه في حسابه فتُفتح له الدورة ولوحة المتابعة مباشرة.
 */
import { db, now, tx } from '../db.js';
import { config } from '../config.js';
import { normalizePhone } from '../util/phone.js';
import { randomToken } from '../util/crypto.js';
import { addDays, localDate } from '../util/time.js';
import { bad, HttpError } from '../middleware/auth.js';
import { notify } from './notify.js';
import { sendNotice } from './messaging.js';
import { getSite } from './site.js';

export const GIFT_LABEL = {
  pending: 'بانتظار المراجعة', sent: 'تم الإرسال', received: 'تم الاستلام',
  rejected: 'مرفوض', declined: 'اعتذر المُهدى إليه', transfer_requested: 'طلب تحويل بانتظار الإدارة',
};
export const GIFT_KINDS = ['remote', 'year_month'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** جهة الاتصال: رقم واتساب (E.164) أو بريد؛ يُميَّز بوجود @ */
export function parseContact(raw, country) {
  const v = String(raw || '').trim();
  if (v.includes('@')) {
    const email = v.toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 120) throw bad('صيغة البريد الإلكتروني غير صحيحة');
    return { channel: 'email', value: email };
  }
  const phone = normalizePhone(v, country || config.defaultCountry);
  if (!phone) throw bad('رقم واتساب المُهدى إليه غير صحيح');
  return { channel: 'whatsapp', value: phone };
}

export const giftLink = (g) => `${g.base_url || config.publicUrl || `http://localhost:${config.port}`}/#/gift/${g.token}`;
export const baseUrlOf = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

const courseOf = (id) => db.prepare('SELECT * FROM courses WHERE id=?').get(id);
const giverOf = (g) => db.prepare('SELECT id, name, phone FROM users WHERE id=?').get(g.giver_id);
const adminIds = () => db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
/** الاسم الذي يراه المُهدى إليه: ما اختاره المُهدي فقط */
export const fromName = (g) => (g.anonymous ? 'محب' : giverOf(g)?.name || 'محب');

const cardOf = (g) => {
  const c = courseOf(g.course_id);
  return {
    from: fromName(g), to: g.recipient_name, message: g.message, theme: getSite().gift_settings.theme, dua: getSite().gift_settings.dua,
    course: { title: c.title, start_date: c.start_date, end_date: c.end_date, time_label: c.time_label, remote: GIFT_KINDS.includes(c.kind) },
  };
};

/** صلاحية الرابط: صالح حتى بداية الدورة (يوم البداية نفسه مشمول) */
const isExpired = (g) => { const c = courseOf(g.course_id); return !!(c?.start_date && localDate() > c.start_date); };

/** ما تعرضه صفحة الاستلام (بلا أي بيانات دفع أو سبب إهداء) */
export function claimView(token) {
  const g = token ? db.prepare('SELECT * FROM gifts WHERE token=?').get(String(token)) : null;
  if (!g) return null;
  if (g.status === 'received') return { state: 'used' };
  if (g.status === 'declined') return { state: 'declined' };
  if (g.status === 'transfer_requested') return { state: 'transfer_requested', card: cardOf(g) };
  if (g.status !== 'sent') return { state: 'unavailable' };
  if (isExpired(g)) return { state: 'expired' };
  return { state: 'ok', card: cardOf(g) };
}

/** يرسل البطاقة (أو تذكيراً) للمُهدى إليه؛ البريد بلا خدمة إرسال فيُشارَك رابطه يدوياً */
export async function deliverGift(g, { reminder = false } = {}) {
  const c = courseOf(g.course_id);
  let delivery = 'manual';
  if (g.recipient_channel === 'whatsapp') {
    const link = giftLink(g);
    const res = reminder
      ? await sendNotice(g.recipient_contact, 'gift_reminder', [c.title, link])
      : await sendNotice(g.recipient_contact, 'gift_card', [fromName(g), c.title, g.message, link]);
    delivery = res.ok ? 'whatsapp_sent' : 'whatsapp_failed';
    if (!res.ok) console.error('[gift] فشل الإرسال:', res.error);
  }
  db.prepare('UPDATE gifts SET delivery=? WHERE id=?').run(delivery, g.id);
  return delivery;
}

function reserveSeat(g, c) {
  if (g.seat_reserved) return;
  if (c.seats != null && c.seats - c.seats_taken <= 0) throw new HttpError(409, 'اكتمل العدد في هذه الدورة');
  db.prepare('UPDATE courses SET seats_taken = seats_taken + 1, updated_at=? WHERE id=?').run(now(), c.id);
}

/** يفتح الهدية للإرسال: يحجز المقعد، يولّد رابطاً جديداً، ويرسل البطاقة */
async function dispatch(g, { baseUrl, to = {} } = {}) {
  const c = courseOf(g.course_id);
  if (!c || c.status !== 'open') throw bad('الدورة لم تعد متاحة');
  const t = now();
  const token = randomToken(24);
  tx(() => {
    reserveSeat(g, c);
    db.prepare(`UPDATE gifts SET status='sent', token=?, base_url=?, seat_reserved=1, reject_reason='', reviewed_at=?, sent_at=?, reminder_at=NULL, alert_at=NULL,
      recipient_name=COALESCE(?, recipient_name), recipient_contact=COALESCE(?, recipient_contact), recipient_channel=COALESCE(?, recipient_channel),
      transfer_name=NULL, transfer_contact=NULL, transfer_channel=NULL, claimed_at=NULL, claimed_by=NULL WHERE id=?`)
      .run(token, baseUrl || g.base_url || '', t, t, to.name ?? null, to.contact ?? null, to.channel ?? null, g.id);
  });
  const fresh = db.prepare('SELECT * FROM gifts WHERE id=?').get(g.id);
  await deliverGift(fresh);
  return db.prepare('SELECT * FROM gifts WHERE id=?').get(g.id);
}

export async function approveGift(g, { baseUrl }) {
  if (g.status !== 'pending') throw bad('هذه الهدية ليست بانتظار المراجعة');
  const out = await dispatch(g, { baseUrl });
  notify([g.giver_id], { type: 'gift_sent', title: 'أُرسلت هديتك', body: `راجعنا إيصالك وأرسلنا الهدية إلى ${g.recipient_name}.`, link: '#/gifts', wa: { key: 'gift_sent', params: [g.recipient_name] } });
  return out;
}

export function rejectGift(g, reason) {
  if (g.status !== 'pending') throw bad('هذه الهدية ليست بانتظار المراجعة');
  const why = String(reason || '').trim().slice(0, 300);
  if (why.length < 3) throw bad('اكتب سبب الرفض ليصل إلى المُهدي');
  db.prepare("UPDATE gifts SET status='rejected', reject_reason=?, reviewed_at=? WHERE id=?").run(why, now(), g.id);
  notify([g.giver_id], { type: 'gift_rejected', title: 'تعذّر قبول إيصال هديتك', body: `${why}. يمكنك رفع إيصال جديد من «هداياي».`, link: '#/gifts', wa: { key: 'gift_rejected', params: [g.recipient_name, why] } });
}

/** الإدارة تحوّل الهدية لشخص آخر (بعد اعتذار المُهدى إليه أو بطلبه) برابط جديد */
export async function reassignGift(g, { name, contact, country, baseUrl }) {
  if (!['sent', 'declined', 'transfer_requested'].includes(g.status)) throw bad('لا يمكن تحويل هذه الهدية في حالتها الحالية');
  const nm = String(name || '').trim().slice(0, 80);
  if (nm.length < 3) throw bad('اكتب اسم المُهدى إليه الجديد');
  const { channel, value } = parseContact(contact, country);
  return dispatch(g, { baseUrl, to: { name: nm, contact: value, channel } });
}

export async function approveTransfer(g, { baseUrl }) {
  if (g.status !== 'transfer_requested') throw bad('لا طلب تحويل لهذه الهدية');
  return dispatch(g, { baseUrl, to: { name: g.transfer_name, contact: g.transfer_contact, channel: g.transfer_channel } });
}

export function rejectTransfer(g) {
  if (g.status !== 'transfer_requested') throw bad('لا طلب تحويل لهذه الهدية');
  db.prepare("UPDATE gifts SET status='sent', transfer_name=NULL, transfer_contact=NULL, transfer_channel=NULL WHERE id=?").run(g.id);
}

/** المُهدى إليه يستلم الهدية: تُربط الدورة بحسابه فوراً وتُفتح له لوحة المتابعة (الإيصال روجع مسبقاً) */
export function claimGift(g, user) {
  if (g.status !== 'sent') throw new HttpError(410, 'هذه الهدية غير متاحة للاستلام');
  if (isExpired(g)) throw new HttpError(410, 'انتهت صلاحية رابط الهدية، تواصل مع الإدارة');
  const c = courseOf(g.course_id);
  const dup = db.prepare('SELECT * FROM course_registrations WHERE course_id=? AND phone=?').get(c.id, user.phone);
  if (dup && dup.status !== 'cancelled') throw new HttpError(409, 'أنت مسجَّل في هذه الدورة بالفعل، تواصل مع الإدارة لتحويل الهدية');
  const t = now();
  const from = g.anonymous ? '' : fromName(g);
  tx(() => {
    // المقعد محجوز من لحظة قبول الإدارة، فلا يُزاد عند الاستلام
    if (dup) {
      db.prepare("UPDATE course_registrations SET user_id=?, name=?, kind='gift', gift_from=?, status='confirmed', confirmed_at=?, reject_reason='', created_at=? WHERE id=?")
        .run(user.id, user.name, from, t, t, dup.id);
    } else {
      db.prepare("INSERT INTO course_registrations(course_id,user_id,name,phone,note,kind,gift_from,status,created_at,confirmed_at) VALUES(?,?,?,?,'','gift',?,'confirmed',?,?)")
        .run(c.id, user.id, user.name, user.phone, from, t, t);
    }
    db.prepare('UPDATE users SET tracking_access=1 WHERE id=?').run(user.id);
    db.prepare("UPDATE gifts SET status='received', claimed_at=?, claimed_by=? WHERE id=?").run(t, user.id, g.id);
  });
  notify([g.giver_id], { type: 'gift_received', title: 'استُلمت هديتك', body: `استلم ${g.recipient_name} هديتك في «${c.title}».`, link: '#/gifts', wa: { key: 'gift_received', params: [g.recipient_name, c.title] } });
  return { course: { id: c.id, title: c.title }, whatsapp_link: c.whatsapp_link || getSite().whatsapp_link || '' };
}

export function declineGift(g) {
  if (g.status !== 'sent') throw bad('لا يمكن الاعتذار عن هذه الهدية الآن');
  tx(() => {
    if (g.seat_reserved) db.prepare('UPDATE courses SET seats_taken = MAX(0, seats_taken - 1) WHERE id=?').run(g.course_id);
    db.prepare("UPDATE gifts SET status='declined', seat_reserved=0 WHERE id=?").run(g.id);
  });
  const c = courseOf(g.course_id);
  notify([g.giver_id], { type: 'gift_declined', title: 'اعتذر المُهدى إليه', body: `لم يتمكن ${g.recipient_name} من استلام هديتك في «${c.title}». ستتواصل معك الإدارة لتحويلها لشخص آخر أو لدورة قادمة.`, link: '#/gifts' });
  notify(adminIds(), { type: 'gift_declined', title: 'هدية اعتُذر عنها', body: `${g.recipient_name} — ${c.title}. حوّلها لشخص آخر أو تواصل مع المُهدي.`, link: '#/admin/registrations' });
}

export function requestTransfer(g, { name, contact, country }) {
  if (g.status !== 'sent') throw bad('لا يمكن طلب التحويل الآن');
  const nm = String(name || '').trim().slice(0, 80);
  if (nm.length < 3) throw bad('اكتب اسم الشخص الذي تريد تحويل الهدية إليه');
  const { channel, value } = parseContact(contact, country);
  db.prepare("UPDATE gifts SET status='transfer_requested', transfer_name=?, transfer_contact=?, transfer_channel=? WHERE id=?").run(nm, value, channel, g.id);
  const c = courseOf(g.course_id);
  notify(adminIds(), { type: 'gift_transfer', title: 'طلب تحويل هدية', body: `${g.recipient_name} يطلب تحويل هديته في «${c.title}» إلى ${nm}.`, link: '#/admin/registrations' });
}

/** تذكير بعد 3 أيام لما لم يُستلم، وتنبيه للإدارة إن لم يُستلم قبل بداية الدورة */
export async function runGiftChecks(nowMs = now()) {
  const today = localDate(nowMs);
  let reminded = 0; let alerted = 0;
  const due = db.prepare("SELECT * FROM gifts WHERE status='sent' AND reminder_at IS NULL AND sent_at < ?").all(nowMs - 3 * 86_400_000);
  for (const g of due) {
    if (isExpired(g)) continue;
    if (g.recipient_channel === 'whatsapp') await deliverGift(g, { reminder: true });
    else notify([g.giver_id], { type: 'gift_reminder', title: 'هديتك لم تُستلم بعد', body: `شارك رابط الهدية مع ${g.recipient_name} مرة أخرى.`, link: '#/gifts' });
    db.prepare('UPDATE gifts SET reminder_at=? WHERE id=?').run(nowMs, g.id);
    reminded += 1;
  }
  const risky = db.prepare(`SELECT g.*, c.title AS course_title FROM gifts g JOIN courses c ON c.id = g.course_id
    WHERE g.status='sent' AND g.alert_at IS NULL AND c.start_date IS NOT NULL AND c.start_date <= ?`).all(addDays(today, 1));
  for (const g of risky) {
    notify(adminIds(), { type: 'gift_unclaimed', title: 'هدية لم تُستلم قبل بداية الدورة', body: `${g.recipient_name} — ${g.course_title}. تواصل مع المُهدي لتحويلها لدورة قادمة أو لشخص آخر.`, link: '#/admin/registrations' });
    db.prepare('UPDATE gifts SET alert_at=? WHERE id=?').run(nowMs, g.id);
    alerted += 1;
  }
  return { reminded, alerted };
}

export function startGiftScheduler() {
  const run = () => runGiftChecks().catch((e) => console.error('[gifts]', e));
  setTimeout(run, 30_000).unref();
  setInterval(run, 3_600_000).unref();
}
