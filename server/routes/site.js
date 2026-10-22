import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { db, now, tx } from '../db.js';
import { config } from '../config.js';
import { normalizePhone } from '../util/phone.js';
import { checkReceipt, dropFile, receiptUpload } from '../util/receipts.js';
import { cleanBody, cleanTitle } from '../util/sanitize.js';
import { bad, HttpError, notFound } from '../middleware/auth.js';
import { notify } from '../services/notify.js';
import { getCourse, getSite, listCourses, MONTHS, paymentFor, yearPlan } from '../services/site.js';

/** محتوى الموقع العام — متاح للزائر قبل تسجيل الدخول */
const r = Router();

r.get('/home', (req, res) => {
  const site = getSite();
  const year = listCourses('year_month');
  res.json({
    brand: site.brand, hero: site.hero, about: site.about, paths: site.paths, gift: site.gift,
    contact: site.contact, months: MONTHS,
    courses: listCourses('remote').filter((c) => c.can_register).slice(0, 3),
    year_preview: year.slice(0, 12),
    membership: listCourses('membership')[0] || null,
    signed_in: !!req.user,
  });
});

r.get('/about', (_req, res) => {
  const site = getSite();
  res.json({ about: site.about, faq: site.faq, hero: site.hero });
});

r.get('/courses', (_req, res) => {
  const courses = listCourses('remote');
  const months = [...new Set(courses.map((c) => (c.start_date ? Number(c.start_date.slice(5, 7)) : null)).filter(Boolean))].sort((a, b) => a - b);
  res.json({ courses, months, month_names: MONTHS, hide_full: !!getSite().hide_full_courses });
});

r.get('/courses/:id', (req, res) => {
  const c = getCourse(req.params.id, { full: true });
  if (!c || !['open', 'closed'].includes(db.prepare('SELECT status FROM courses WHERE id=?').get(Number(req.params.id))?.status)) throw notFound('الدورة غير موجودة');
  res.json({ course: c, bank_note: getSite().bank_note, payment: paymentFor(Number(req.params.id)) });
});

r.get('/courses/:id/image', (req, res) => {
  const row = db.prepare('SELECT image_name, image_mime, status FROM courses WHERE id=?').get(Number(req.params.id));
  if (!row || !row.image_name || !['open', 'closed'].includes(row.status)) throw notFound();
  const abs = path.join(config.uploadDir, path.basename(row.image_name));
  if (!fs.existsSync(abs)) throw notFound();
  res.setHeader('Content-Type', row.image_mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(abs, { dotfiles: 'allow' });
});

// ---------------------------------------------------------------- التسجيل في دورة
/** ما يظهر للمشترك بعد تسجيله: نص الشكر والدعاء، ورابط مجتمع واتساب الخاص بالدورة */
function thanksFor(courseRow) {
  return { thanks_text: courseRow.thanks_text || getSite().thanks_text, whatsapp_link: courseRow.whatsapp_link || getSite().whatsapp_link || '' };
}
/** المسجَّل دخوله يشترك لنفسه بباقة بياناته المحفوظة، دون إعادة كتابة الاسم والهاتف؛ الإهداء يبقى باسم ورقم المُهدى إليه */
function registrant(req, b, kind) {
  if (req.user && kind === 'self') return { name: req.user.name, phone: req.user.phone };
  const name = cleanTitle(b.name, 80);
  if (name.length < 3) throw bad('اكتب الاسم كاملاً');
  const phone = normalizePhone(b.phone, b.country || config.defaultCountry);
  if (!phone) throw bad('رقم الهاتف غير صحيح');
  return { name, phone };
}
const regLimit = rateLimit({ windowMs: 3_600_000, limit: config.isTest ? 1000 : 12, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كثيرة، حاول لاحقاً' } });

/** الدورة المدفوعة تتطلب إيصال تحويل من الجميع (عضواً كان أو زائراً، لنفسه أو إهداءً) */
const needsReceipt = (paid) => paid;

r.post('/register', regLimit, receiptUpload.single('receipt'), (req, res) => {
  try {
    const b = req.body || {};
    const row = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(b.course_id));
    if (!row || row.status !== 'open') throw bad('هذه الدورة غير متاحة للتسجيل');
    if (row.seats != null && row.seats - row.seats_taken <= 0) throw new HttpError(409, 'اكتمل العدد في هذه الدورة');
    const kind = b.kind === 'gift' ? 'gift' : 'self';
    const { name, phone } = registrant(req, b, kind);
    const note = cleanBody(b.note || '', 400);
    const gift_from = kind === 'gift' ? cleanTitle(b.gift_from || '', 80) : '';
    const receipt = checkReceipt(req.file, needsReceipt(row.price_minor > 0));

    const id = tx(() => {
      const dup = db.prepare("SELECT id, status, user_id, receipt_name FROM course_registrations WHERE course_id=? AND phone=?").get(row.id, phone);
      // طلب قائم بلا إيصال لصاحب الحساب نفسه (مثلاً سُجّل قبل إنشاء الحساب) يُكمَل، أما ما أُرسل إيصاله فيبقى مسجلاً
      const own = dup && dup.status === 'pending' && !dup.receipt_name && req.user && phone === req.user.phone;
      if (dup && dup.status !== 'cancelled' && !own) throw new HttpError(409, 'هذا الرقم مسجَّل في الدورة بالفعل');
      const t = now();
      if (own) {
        // طلب قائم لصاحب الحساب نفسه: يُكمَل بالإيصال ويُربط بحسابه، بلا مقعد إضافي
        db.prepare('UPDATE course_registrations SET user_id=?, name=?, note=?, kind=?, gift_from=?, created_at=?, receipt_name=COALESCE(?, receipt_name), receipt_mime=COALESCE(?, receipt_mime) WHERE id=?')
          .run(req.user.id, name, note, kind, gift_from, t, receipt?.name ?? null, receipt?.mime ?? null, dup.id);
        return dup.id;
      }
      const rid = dup
        ? (db.prepare("UPDATE course_registrations SET name=?, note=?, kind=?, gift_from=?, status='pending', reject_reason='', reviewed_at=NULL, confirmed_at=NULL, created_at=?, receipt_name=?, receipt_mime=? WHERE id=?").run(name, note, kind, gift_from, t, receipt?.name ?? null, receipt?.mime ?? null, dup.id), dup.id)
        : db.prepare('INSERT INTO course_registrations(course_id,user_id,name,phone,note,kind,gift_from,created_at,receipt_name,receipt_mime) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(row.id, req.user?.id ?? null, name, phone, note, kind, gift_from, t, receipt?.name ?? null, receipt?.mime ?? null).lastInsertRowid;
      db.prepare('UPDATE courses SET seats_taken = seats_taken + 1, updated_at=? WHERE id=?').run(t, row.id);
      return Number(rid);
    });

    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
    notify(admins, { type: 'course_registration', title: receipt ? 'تسجيل جديد مع إيصال تحويل' : 'تسجيل جديد في دورة', body: `${name} — ${row.title}`, link: '#/admin/courses' });
    res.status(201).json({
      id, message: 'تم تسجيلك بإذن الله',
      course: { id: row.id, title: row.title, price: getCourse(row.id).price, free: row.price_minor === 0 },
      bank_note: getSite().bank_note, receipt: !!receipt, ...thanksFor(row),
    });
  } catch (e) { dropFile(req.file); throw e; }
});
const yearPayload = () => {
  const courses = yearPlan();
  return { months: MONTHS, courses, next_id: courses.find((c) => c.is_next)?.id ?? null, bank_note: getSite().bank_note, payment: getSite().payment };
};
r.get('/year', (_req, res) => res.json(yearPayload()));
r.get('/year-plan', (_req, res) => res.json(yearPayload()));

/** تسجيل في أكثر من دورة دفعة واحدة مع ملخص قبل الدفع */
r.post('/register-many', regLimit, receiptUpload.single('receipt'), (req, res) => {
  try {
    const b = req.body || {};
    const raw = typeof b.course_ids === 'string' ? b.course_ids.split(',') : b.course_ids; // multipart يرسلها نصاً مفصولاً بفواصل
    const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Boolean))].slice(0, 12);
    if (!ids.length) throw bad('اختر دورة واحدة على الأقل');
    const kind = b.kind === 'gift' ? 'gift' : 'self';
    const { name, phone } = registrant(req, b, kind);
    const note = cleanBody(b.note || '', 400);
    const gift_from = kind === 'gift' ? cleanTitle(b.gift_from || '', 80) : '';
    const paidAny = ids.some((id) => db.prepare("SELECT price_minor FROM courses WHERE id=? AND status='open'").get(id)?.price_minor > 0);
    const receipt = checkReceipt(req.file, needsReceipt(paidAny));

    const done = []; const skipped = [];
    tx(() => {
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM courses WHERE id=?').get(id);
        if (!row || row.status !== 'open') { skipped.push({ id, reason: 'غير متاحة' }); continue; }
        if (row.seats != null && row.seats - row.seats_taken <= 0) { skipped.push({ id, title: row.title, reason: 'اكتمل العدد' }); continue; }
        const dup = db.prepare('SELECT id, status FROM course_registrations WHERE course_id=? AND phone=?').get(id, phone);
        if (dup && dup.status !== 'cancelled') { skipped.push({ id, title: row.title, reason: 'مسجَّل مسبقاً' }); continue; }
        const t = now();
        if (dup) db.prepare("UPDATE course_registrations SET name=?, note=?, kind=?, gift_from=?, status='pending', reject_reason='', reviewed_at=NULL, confirmed_at=NULL, created_at=?, receipt_name=?, receipt_mime=? WHERE id=?").run(name, note, kind, gift_from, t, receipt?.name ?? null, receipt?.mime ?? null, dup.id);
        else db.prepare('INSERT INTO course_registrations(course_id,user_id,name,phone,note,kind,gift_from,created_at,receipt_name,receipt_mime) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, req.user?.id ?? null, name, phone, note, kind, gift_from, t, receipt?.name ?? null, receipt?.mime ?? null);
        db.prepare('UPDATE courses SET seats_taken = seats_taken + 1, updated_at=? WHERE id=?').run(t, id);
        done.push({ id, title: row.title, price_minor: row.price_minor, whatsapp_link: row.whatsapp_link || getSite().whatsapp_link || '' });
      }
    });
    if (!done.length) throw new HttpError(409, skipped[0]?.reason === 'مسجَّل مسبقاً' ? 'أنت مسجَّل في هذه الدورات بالفعل' : 'لم تعد هذه الدورات متاحة للتسجيل');
    const total = done.reduce((a, x) => a + x.price_minor, 0);
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
    notify(admins, { type: 'course_registration', title: receipt ? 'تسجيل جديد في خطة العام مع إيصال' : 'تسجيل جديد في خطة العام', body: `${name} — ${done.length} دورة`, link: '#/admin/courses?kind=year_month' });
    res.status(201).json({ done, skipped, total_minor: total, bank_note: getSite().bank_note, receipt: !!receipt, thanks_text: getSite().thanks_text });
  } catch (e) { dropFile(req.file); throw e; }
});
r.get('/membership', (_req, res) => res.json({ plans: listCourses('membership') }));
r.get('/retreats', (_req, res) => res.json({ courses: listCourses('retreat') }));

export default r;
