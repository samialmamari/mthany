/**
 * مراجعة طلبات التسجيل في الدورات: القبول (يفتح لوحة المتابعة) والرفض بسبب والإلغاء، وحذف الإيصالات بعد التفعيل.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, now, tx } from '../db.js';
import { config } from '../config.js';
import { bad } from '../middleware/auth.js';
import { notify } from './notify.js';
import { getSite } from './site.js';

export const REG_LABEL = { pending: 'بانتظار المراجعة', confirmed: 'تم التفعيل', rejected: 'مرفوض', cancelled: 'ملغى' };

/** الحالة المعروضة: المرفوض هو الملغى الذي له سبب */
export const regState = (r) => (r.status === 'cancelled' ? (r.reject_reason ? 'rejected' : 'cancelled') : r.status);

/** صاحب الحساب المرتبط بالطلب (بالمعرّف، وإلا برقم الهاتف) */
export const regUser = (reg) => (reg.user_id ? db.prepare('SELECT * FROM users WHERE id=?').get(reg.user_id) : null)
  || db.prepare('SELECT * FROM users WHERE phone=?').get(reg.phone) || null;

/** to: pending | confirmed | rejected | cancelled */
export function reviewRegistration(reg, to, { reason = '', actorId = null } = {}) {
  if (!['pending', 'confirmed', 'rejected', 'cancelled'].includes(to)) throw bad('حالة غير صالحة');
  const why = to === 'rejected' ? String(reason || '').trim().slice(0, 300) : '';
  if (to === 'rejected' && why.length < 3) throw bad('اكتب سبب الرفض ليصل إلى المشترك');
  const status = to === 'rejected' ? 'cancelled' : to;
  const t = now();
  tx(() => {
    db.prepare('UPDATE course_registrations SET status=?, confirmed_at=?, reject_reason=?, reviewed_at=?, reviewed_by=? WHERE id=?')
      .run(status, to === 'confirmed' ? t : null, why, t, actorId, reg.id);
    // المقعد محجوز ما دام الطلب قائماً، ويعود عند الرفض أو الإلغاء
    if (status === 'cancelled' && reg.status !== 'cancelled') db.prepare('UPDATE courses SET seats_taken = MAX(0, seats_taken - 1) WHERE id=?').run(reg.course_id);
    if (status !== 'cancelled' && reg.status === 'cancelled') db.prepare('UPDATE courses SET seats_taken = seats_taken + 1 WHERE id=?').run(reg.course_id);
    if (to === 'confirmed') {
      const u = regUser(reg);
      if (u) db.prepare('UPDATE users SET tracking_access=1 WHERE id=?').run(u.id);
    }
  });
  const user = regUser(reg);
  const course = db.prepare('SELECT title FROM courses WHERE id=?').get(reg.course_id);
  if (user && course && to === 'confirmed') {
    notify([user.id], { type: 'registration_confirmed', title: 'تم تفعيل لوحة المتابعة', body: `قُبل إيصالك في «${course.title}». ابدأ متابعتك من لوحتك.`, link: '#/my', wa: { key: 'access_activated', params: [course.title] } });
  } else if (user && course && to === 'rejected') {
    notify([user.id], { type: 'registration_rejected', title: 'تعذّر قبول الإيصال', body: `${course.title}: ${why}. يمكنك رفع إيصال جديد.`, link: `#/site/register?c=${reg.course_id}`, wa: { key: 'receipt_rejected', params: [course.title, why] } });
  }
  return { status: regState({ status, reject_reason: why }) };
}

/**
 * حذف اسم من المسجلين نهائياً: يعود المقعد إن كان محجوزاً (المرفوض والملغى عاد مقعدهما سابقاً)،
 * ويُحذف ملف الإيصال بعد زوال آخر إشارة إليه (قد يخدم دفعة واحدة لعدة دورات أو إيصال هدية).
 * لا يمس حساب الشخص ولا وصوله إلى لوحة المتابعة؛ للأخير زر «قفل الوصول» المستقل.
 */
export function deleteRegistration(reg) {
  tx(() => {
    db.prepare('DELETE FROM course_registrations WHERE id=?').run(reg.id);
    if (reg.status !== 'cancelled') db.prepare('UPDATE courses SET seats_taken = MAX(0, seats_taken - 1) WHERE id=?').run(reg.course_id);
  });
  if (reg.receipt_name
    && !db.prepare('SELECT 1 FROM course_registrations WHERE receipt_name=?').get(reg.receipt_name)
    && !db.prepare('SELECT 1 FROM gifts WHERE receipt_name=?').get(reg.receipt_name)) {
    fs.rmSync(path.join(config.uploadDir, path.basename(reg.receipt_name)), { force: true });
  }
}

/** يمنح أو يسحب الوصول إلى لوحة المتابعة يدوياً */
export function setAccess(reg, open) {
  const u = regUser(reg);
  if (!u) throw bad('لا حساب مرتبط بهذا الطلب');
  db.prepare('UPDATE users SET tracking_access=? WHERE id=?').run(open ? 1 : 0, u.id);
  return u.id;
}

/** حذف صور الإيصالات بعد عدد أيام من تفعيل الطلب (0 = لا تُحذف) */
export function purgeReceipts() {
  const days = Number(getSite().receipt_retention_days) || 0;
  if (days <= 0) return 0;
  const cutoff = now() - days * 86_400_000;
  const rows = db.prepare("SELECT id, receipt_name FROM course_registrations WHERE status='confirmed' AND receipt_name IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_at < ?").all(cutoff);
  for (const r of rows) {
    db.prepare('UPDATE course_registrations SET receipt_name=NULL, receipt_mime=NULL WHERE id=?').run(r.id);
    // الملف قد يخدم عدة طلبات (دفعة واحدة): يُحذف بعد زوال آخر إشارة إليه
    if (!db.prepare('SELECT 1 FROM course_registrations WHERE receipt_name=?').get(r.receipt_name)) {
      fs.rmSync(path.join(config.uploadDir, path.basename(r.receipt_name)), { force: true });
    }
  }
  return rows.length;
}

export function startReceiptPurge() {
  const run = () => { try { purgeReceipts(); } catch (e) { console.error('[receipts]', e); } };
  run();
  setInterval(run, 6 * 3_600_000).unref();
}
