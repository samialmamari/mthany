import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db, now, tx } from '../db.js';
import { config } from '../config.js';
import { randomToken } from '../util/crypto.js';
import { cleanBody, cleanTitle } from '../util/sanitize.js';
import { extOf, IMAGE_TYPES, validSignature } from '../util/files.js';
import { isDate, isTime } from '../util/time.js';
import { bad, forbidden, HttpError, notFound } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { removeStoredFile } from '../services/submissions.js';
import { cleanWhatsappLink, courseOut, getSite, ordinalFem, setSite, STATUS_LABEL, YEAR_STATUS_LABEL, yearPlan } from '../services/site.js';
import { deleteRegistration, REG_LABEL, regState, regUser, reviewRegistration, setAccess } from '../services/registrations.js';

/** إدارة الدورات: للمدير وحده */
const r = Router();
r.use((req, _res, next) => (req.user.role === 'admin' ? next() : next(forbidden('إدارة الدورات للمدير فقط'))));

const upload = multer({
  storage: multer.diskStorage({ destination: config.uploadDir, filename: (_q, f, cb) => cb(null, `crs-${randomToken(16)}.${extOf(f.originalname)}`) }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_q, f, cb) => (IMAGE_TYPES[extOf(f.originalname)] ? cb(null, true) : cb(new HttpError(400, 'صورة الدورة يجب أن تكون jpg أو png أو webp'))),
});
const KINDS = ['remote', 'year_month', 'membership', 'retreat'];
const STATUSES = Object.keys(STATUS_LABEL);
const list = (v, max, len) => (Array.isArray(v) ? v : String(v ?? '').split('\n'))
  .map((x) => cleanTitle(typeof x === 'string' ? x : '', len)).filter(Boolean).slice(0, max);

function fields(b, ex = {}) {
  const kind = KINDS.includes(b.kind) ? b.kind : (ex.kind || 'remote');
  const title = cleanTitle(b.title, 140);
  if (title.length < 3) throw bad('اسم الدورة مطلوب');
  const status = STATUSES.includes(b.status) ? b.status : 'draft';
  const price_minor = Number(b.price_minor);
  if (!Number.isInteger(price_minor) || price_minor < 0 || price_minor > 100_000_000) throw bad('السعر غير صالح');
  let seats = null;
  if (b.seats !== '' && b.seats != null) {
    seats = Number(b.seats);
    if (!Number.isInteger(seats) || seats < 0 || seats > 100_000) throw bad('عدد المقاعد غير صالح');
  }
  for (const d of [b.start_date, b.end_date]) if (d && !isDate(d)) throw bad('التاريخ غير صالح');
  if (b.start_date && b.end_date && b.end_date < b.start_date) throw bad('تاريخ النهاية قبل البداية');
  let month = null;
  if (kind === 'year_month') {
    month = Number(b.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw bad('اختر شهر المحطة');
  }
  const attend_link = String(b.attend_link || '').trim().slice(0, 500);
  if (attend_link) {
    try { const u = new URL(attend_link); if (!['http:', 'https:'].includes(u.protocol)) throw 0; }
    catch { throw bad('رابط الحضور غير صالح (يبدأ بـ http أو https)'); }
  }
  const whatsapp_link = cleanWhatsappLink(b.whatsapp_link);
  let schedule = [];
  if (b.schedule !== undefined) {
    const raw = typeof b.schedule === 'string' ? JSON.parse(b.schedule || '[]') : (b.schedule || []);
    schedule = (Array.isArray(raw) ? raw : []).slice(0, 40)
      .map((x) => ({ when: cleanTitle(x.when, 80), what: cleanTitle(x.what, 200) })).filter((x) => x.when || x.what);
  }
  let faq = [];
  if (b.faq !== undefined) {
    const raw = typeof b.faq === 'string' ? JSON.parse(b.faq || '[]') : (b.faq || []);
    faq = (Array.isArray(raw) ? raw : []).slice(0, 12)
      .map((x) => ({ q: cleanTitle(x.q, 160), a: cleanBody(x.a, 600) })).filter((x) => x.q && x.a);
  }
  return {
    kind, title, status, price_minor, seats, month, attend_link, whatsapp_link,
    pay_phone: cleanTitle(b.pay_phone || '', 30),
    thanks_text: cleanBody(b.thanks_text || '', 500),
    summary: cleanBody(b.summary || '', 300),
    description: cleanBody(b.description || '', 4000),
    instructor: cleanTitle(b.instructor || '', 80),
    time_label: cleanTitle(b.time_label || '', 80),
    duration_label: cleanTitle(b.duration_label || '', 80),
    place: cleanTitle(b.place || '', 120),
    attend_note: cleanBody(b.attend_note || '', 500),
    start_date: b.start_date || null, end_date: b.end_date || null,
    goals: JSON.stringify(list(typeof b.goals === 'string' && b.goals.startsWith('[') ? JSON.parse(b.goals) : b.goals, 12, 160)),
    topics: JSON.stringify(list(typeof b.topics === 'string' && b.topics.startsWith('[') ? JSON.parse(b.topics) : b.topics, 20, 160)),
    faq: JSON.stringify(faq), schedule: JSON.stringify(schedule),
    course_no: b.course_no === '' || b.course_no == null ? null : Number(b.course_no),
    sort: Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0,
  };
}

const YEAR_COLS = ['course_no', 'title', 'start_date', 'end_date', 'time_label', 'price_minor', 'seats', 'status'];
const COLS = ['kind', 'title', 'summary', 'description', 'instructor', 'goals', 'topics', 'faq', 'schedule', 'month', 'start_date', 'end_date',
  'time_label', 'duration_label', 'place', 'attend_link', 'attend_note', 'price_minor', 'seats', 'status', 'sort', 'course_no', 'pay_phone', 'whatsapp_link', 'thanks_text'];

r.get('/courses', (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const rows = db.prepare(`SELECT * FROM courses${kind ? ' WHERE kind = ?' : ''} ORDER BY sort, start_date, id`).all(...(kind ? [kind] : []));
  const counts = Object.fromEntries(db.prepare("SELECT course_id, COUNT(*) c FROM course_registrations WHERE status<>'cancelled' GROUP BY course_id").all().map((x) => [x.course_id, x.c]));
  res.json({
    courses: rows.map((c) => ({ ...courseOut(c, { admin: true }), registrations: counts[c.id] || 0 })),
    settings: { hide_full_courses: !!getSite().hide_full_courses, payment: getSite().payment, thanks_text: getSite().thanks_text, whatsapp_link: getSite().whatsapp_link, receipt_retention_days: getSite().receipt_retention_days },
    statuses: STATUS_LABEL,
  });
});

r.get('/courses/:id', (req, res) => {
  const c = getCourseRow(req.params.id);
  res.json({ course: courseOut(c, { admin: true }) });
});
function getCourseRow(id) {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(id));
  if (!c) throw notFound('الدورة غير موجودة');
  return c;
}

function withImage(req, fn) {
  const f = req.file;
  try {
    if (f && !validSignature(f)) throw bad('الصورة تالفة أو لا تطابق امتدادها');
    return fn(f);
  } catch (e) { if (f) removeStoredFile(f.filename); throw e; }
}

r.post('/courses', upload.single('image'), (req, res) => {
  withImage(req, (img) => {
    const f = fields(req.body || {});
    const t = now();
    const id = db.prepare(
      `INSERT INTO courses(${COLS.join(',')},image_name,image_mime,seats_taken,created_at,updated_at)
       VALUES(${COLS.map(() => '?').join(',')},?,?,0,?,?)`,
    ).run(...COLS.map((c) => f[c]), img?.filename ?? null, img ? IMAGE_TYPES[extOf(img.originalname)] : null, t, t).lastInsertRowid;
    audit(req.user.id, 'course.add', 'course', Number(id), { title: f.title, status: f.status });
    res.status(201).json({ id, message: 'تم حفظ الدورة' });
  });
});

r.put('/courses/:id', upload.single('image'), (req, res) => {
  withImage(req, (img) => {
    const ex = getCourseRow(req.params.id);
    const f = fields(req.body || {}, ex);
    if (f.seats != null && f.seats < ex.seats_taken) throw bad(`لا يمكن جعل المقاعد أقل من المسجَّلين (${ex.seats_taken})`);
    db.prepare(`UPDATE courses SET ${COLS.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...COLS.map((c) => f[c]), now(), ex.id);
    if (img) {
      db.prepare('UPDATE courses SET image_name=?, image_mime=? WHERE id=?').run(img.filename, IMAGE_TYPES[extOf(img.originalname)], ex.id);
      if (ex.image_name) removeStoredFile(ex.image_name);
    } else if (req.body.remove_image === '1' && ex.image_name) {
      db.prepare('UPDATE courses SET image_name=NULL, image_mime=NULL WHERE id=?').run(ex.id);
      removeStoredFile(ex.image_name);
    }
    audit(req.user.id, 'course.edit', 'course', ex.id, { title: f.title, status: f.status });
    res.json({ ok: true, message: 'تم حفظ التعديلات' });
  });
});

/** تغيير سريع للحالة أو الترتيب */
r.patch('/courses/:id', (req, res) => {
  const ex = getCourseRow(req.params.id);
  const sets = {};
  if (req.body?.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) throw bad('حالة غير صالحة');
    sets.status = req.body.status;
  }
  if (req.body?.sort !== undefined) {
    const n = Number(req.body.sort);
    if (!Number.isInteger(n)) throw bad('ترتيب غير صالح');
    sets.sort = n;
  }
  if (!Object.keys(sets).length) throw bad('لا تغييرات');
  const cols = Object.keys(sets);
  db.prepare(`UPDATE courses SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => sets[c]), now(), ex.id);
  audit(req.user.id, 'course.patch', 'course', ex.id, { title: ex.title, ...sets });
  res.json({ course: courseOut(db.prepare('SELECT * FROM courses WHERE id=?').get(ex.id), { admin: true }) });
});

/** نسخ دورة سابقة لإنشاء جديدة بسرعة */
r.post('/courses/:id/duplicate', (req, res) => {
  const ex = getCourseRow(req.params.id);
  const t = now();
  const id = db.prepare(
    `INSERT INTO courses(${COLS.join(',')},image_name,image_mime,seats_taken,created_at,updated_at)
     VALUES(${COLS.map(() => '?').join(',')},?,?,0,?,?)`,
  ).run(...COLS.map((c) => (c === 'title' ? `${ex.title} (نسخة)` : c === 'status' ? 'draft' : ex[c])), ex.image_name, ex.image_mime, t, t).lastInsertRowid;
  audit(req.user.id, 'course.duplicate', 'course', Number(id), { from: ex.id });
  res.status(201).json({ id, message: 'نُسخت الدورة كمسودة' });
});

r.delete('/courses/:id', (req, res) => {
  const ex = getCourseRow(req.params.id);
  const regs = db.prepare("SELECT COUNT(*) c FROM course_registrations WHERE course_id=? AND status<>'cancelled'").get(ex.id).c;
  if (regs) throw new HttpError(409, `للدورة ${regs} تسجيلاً؛ أرشفها بدل حذفها للحفاظ على السجلات`);
  db.prepare('DELETE FROM courses WHERE id=?').run(ex.id);
  if (ex.image_name) removeStoredFile(ex.image_name);
  audit(req.user.id, 'course.delete', 'course', ex.id, { title: ex.title });
  res.json({ ok: true, message: 'تم حذف الدورة' });
});

// ---------------------------------------------------------------- خطة العام
r.get('/year-plan', (_req, res) => {
  const courses = yearPlan({ admin: true });
  const counts = Object.fromEntries(db.prepare("SELECT course_id, COUNT(*) c FROM course_registrations WHERE status<>'cancelled' GROUP BY course_id").all().map((x) => [x.course_id, x.c]));
  res.json({ courses: courses.map((c) => ({ ...c, registrations: counts[c.id] || 0 })), statuses: YEAR_STATUS_LABEL });
});

/** حفظ صف واحد من جدول الخطة */
r.patch('/year-plan/:id', (req, res) => {
  const ex = getCourseRow(req.params.id);
  const b = req.body || {};
  const sets = {};
  if (b.course_no !== undefined) {
    const n = b.course_no === '' ? null : Number(b.course_no);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 500)) throw bad('رقم الدورة غير صالح');
    sets.course_no = n;
  }
  if (b.title !== undefined) { const t = cleanTitle(b.title, 140); if (t.length < 3) throw bad('اسم الدورة مطلوب'); sets.title = t; }
  for (const k of ['start_date', 'end_date']) {
    if (b[k] === undefined) continue;
    if (b[k] && !isDate(b[k])) throw bad('التاريخ غير صالح');
    sets[k] = b[k] || null;
  }
  const start = sets.start_date ?? ex.start_date; const end = sets.end_date ?? ex.end_date;
  if (start && end && end < start) throw bad('تاريخ النهاية قبل البداية');
  if (b.time_label !== undefined) sets.time_label = cleanTitle(b.time_label, 80);
  if (b.price_minor !== undefined) {
    const n = Number(b.price_minor);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw bad('السعر غير صالح');
    sets.price_minor = n;
  }
  if (b.seats !== undefined) {
    const n = b.seats === '' || b.seats === null ? null : Number(b.seats);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 100_000)) throw bad('عدد المقاعد غير صالح');
    if (n !== null && n < ex.seats_taken) throw bad(`المقاعد أقل من المسجَّلين (${ex.seats_taken})`);
    sets.seats = n;
  }
  if (b.status !== undefined) {
    if (!Object.keys(YEAR_STATUS_LABEL).includes(b.status)) throw bad('حالة غير صالحة');
    sets.status = b.status;
  }
  if (!Object.keys(sets).length) throw bad('لا تغييرات');
  const cols = Object.keys(sets);
  db.prepare(`UPDATE courses SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => sets[c]), now(), ex.id);
  audit(req.user.id, 'course.year_edit', 'course', ex.id, { title: sets.title ?? ex.title, keys: cols });
  const regs = db.prepare("SELECT COUNT(*) c FROM course_registrations WHERE course_id=? AND status<>'cancelled'").get(ex.id).c;
  const dateChanged = (sets.start_date !== undefined && sets.start_date !== ex.start_date) || (sets.end_date !== undefined && sets.end_date !== ex.end_date);
  res.json({
    ok: true,
    message: dateChanged && regs ? `تم الحفظ — تنبيه: ${regs} مسجَّلاً في هذه الدورة، أبلغهم بتغيير الموعد` : 'تم حفظ التعديلات',
    warn: dateChanged && regs > 0, registrations: regs,
  });
});

/** تمديد الخطة: يضيف الأشهر التالية تلقائياً بأرقام متسلسلة */
r.post('/year-plan/extend', (req, res) => {
  const count = Math.min(24, Math.max(1, Number(req.body?.count) || 12));
  const last = db.prepare("SELECT * FROM courses WHERE kind='year_month' ORDER BY start_date DESC, course_no DESC LIMIT 1").get();
  const base = last || { course_no: 9, start_date: new Date().toISOString().slice(0, 10), end_date: null, time_label: 'بعد صلاة العشاء', price_minor: 5000, seats: 40 };
  let [y, m] = (base.start_date || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  // الترقيم يتبع أكبر رقم موجود لا أحدث تاريخ، كي لا يتكرر رقم إن عُدّلت المواعيد
  let no = Number(db.prepare("SELECT MAX(course_no) m FROM courses WHERE kind='year_month'").get().m || base.course_no || 9);
  const span = base.start_date && base.end_date ? Math.round((Date.parse(base.end_date) - Date.parse(base.start_date)) / 86_400_000) : 12;
  const added = [];
  const t = now();
  tx(() => {
    for (let i = 0; i < count; i++) {
      m += 1; if (m > 12) { m = 1; y += 1; }
      no += 1;
      const start = `${y}-${String(m).padStart(2, '0')}-15`;
      const end = new Date(Date.parse(`${start}T00:00:00Z`) + span * 86_400_000).toISOString().slice(0, 10);
      db.prepare(
        `INSERT INTO courses(kind,title,summary,description,goals,topics,faq,schedule,instructor,month,start_date,end_date,time_label,duration_label,place,attend_link,attend_note,price_minor,seats,seats_taken,status,sort,course_no,created_at,updated_at)
         VALUES('year_month',?,?,'','[]','[]','[]','[]',?,?,?,?,?,?,'',?,?,?,?,0,'draft',?,?,?,?)`,
      ).run(`دورة الاستشفاء — الدورة ${ordinalFem(no)}`, base.summary || '', base.instructor || '', m, start, end,
        base.time_label || 'بعد صلاة العشاء', base.duration_label || '', base.attend_link || '', base.attend_note || '',
        base.price_minor ?? 5000, base.seats ?? 40, no, no, t, t);
      added.push({ no, start, end });
    }
  });
  audit(req.user.id, 'course.year_extend', 'course', null, { count: added.length });
  res.status(201).json({ added, message: `أُضيفت ${added.length} دورة كمسودات — راجع مواعيدها ثم انشرها` });
});

// ---------------------------------------------------------------- المسجّلون

r.get('/courses/:id/registrations', (req, res) => {
  const c = getCourseRow(req.params.id);
  const rows = db.prepare('SELECT * FROM course_registrations WHERE course_id=? ORDER BY id DESC').all(c.id);
  res.json({
    course: { id: c.id, title: c.title, seats: c.seats, seats_taken: c.seats_taken },
    registrations: rows.map(({ receipt_name, receipt_mime, ...x }) => ({ ...x, has_receipt: !!receipt_name, status_view: regState(x), status_label: REG_LABEL[regState(x)], kind_label: x.kind === 'gift' ? 'إهداء' : 'تسجيل ذاتي' })),
  });
});

/** إيصال التحويل (للمدير وحده) */
r.get('/registrations/:id/receipt', (req, res) => {
  const row = db.prepare('SELECT receipt_name, receipt_mime FROM course_registrations WHERE id=?').get(Number(req.params.id));
  if (!row?.receipt_name) throw notFound('لا إيصال لهذا التسجيل');
  const abs = path.join(config.uploadDir, path.basename(row.receipt_name));
  if (!fs.existsSync(abs)) throw notFound('ملف الإيصال غير موجود');
  res.setHeader('Content-Type', row.receipt_mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(abs, { dotfiles: 'allow' });
});

r.get('/courses/:id/registrations.csv', (req, res) => {
  const c = getCourseRow(req.params.id);
  const rows = db.prepare('SELECT * FROM course_registrations WHERE course_id=? ORDER BY id').all(c.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['#', 'الاسم', 'الهاتف', 'النوع', 'من', 'الحالة', 'مرجع الدفع', 'تاريخ التسجيل'];
  const lines = rows.map((x, i) => [i + 1, x.name, x.phone, x.kind === 'gift' ? 'إهداء' : 'تسجيل ذاتي', x.gift_from, REG_LABEL[regState(x)], x.payment_ref,
    new Date(x.created_at + config.tzOffsetMin * 60_000).toISOString().slice(0, 16).replace('T', ' ')].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="course-${c.id}-registrations.csv"`);
  res.send('﻿' + [head.map(esc).join(','), ...lines].join('\r\n'));
});

const getReg = (id) => db.prepare('SELECT * FROM course_registrations WHERE id=?').get(Number(id)) || (() => { throw notFound(); })();

/** قبول (يفتح المنصة) أو رفض بسبب أو إلغاء أو إعادة للمراجعة */
r.patch('/registrations/:id', (req, res) => {
  const reg = getReg(req.params.id);
  const to = req.body?.status;
  const out = reviewRegistration(reg, to, { reason: req.body?.reason, actorId: req.user.id });
  audit(req.user.id, `course.reg_${to}`, 'registration', reg.id, { course_id: reg.course_id, name: reg.name });
  res.json({ ok: true, ...out });
});

/** حذف اسم من المسجلين نهائياً (مع طلبه وإيصاله)؛ يتيح للشخص التسجيل من جديد */
r.delete('/registrations/:id', (req, res) => {
  const reg = getReg(req.params.id);
  deleteRegistration(reg);
  audit(req.user.id, 'course.reg_deleted', 'registration', reg.id, { course_id: reg.course_id, name: reg.name, status: regState(reg), kind: reg.kind });
  res.json({ ok: true });
});

/** قبول جماعي لعدة طلبات */
r.post('/registrations/bulk-confirm', (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 200);
  if (!ids.length) throw bad('اختر طلباً واحداً على الأقل');
  let done = 0;
  for (const id of ids) {
    const reg = db.prepare('SELECT * FROM course_registrations WHERE id=?').get(id);
    if (!reg || reg.status === 'confirmed') continue;
    reviewRegistration(reg, 'confirmed', { actorId: req.user.id });
    audit(req.user.id, 'course.reg_confirmed', 'registration', reg.id, { course_id: reg.course_id, name: reg.name, bulk: true });
    done += 1;
  }
  res.json({ ok: true, confirmed: done });
});

/** فتح أو قفل وصول صاحب الطلب إلى لوحة المتابعة يدوياً */
r.patch('/registrations/:id/access', (req, res) => {
  const reg = getReg(req.params.id);
  const uid = setAccess(reg, !!req.body?.open);
  audit(req.user.id, req.body?.open ? 'course.access_open' : 'course.access_lock', 'user', uid, { registration: reg.id });
  res.json({ ok: true, access: !!req.body?.open });
});

/** قسم «المسجلون الجدد»: الطلبات مرتبة من الأحدث، مع إحصاءات عامة فقط */
r.get('/registrations-board', (req, res) => {
  const courseId = Number(req.query.course_id) || null;
  const status = ['pending', 'confirmed', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT cr.*, c.title AS course_title FROM course_registrations cr JOIN courses c ON c.id = cr.course_id
    ${courseId ? 'WHERE cr.course_id = ?' : ''} ORDER BY cr.id DESC LIMIT 1000`).all(...(courseId ? [courseId] : []));
  const stats = { total: rows.length, pending: 0, confirmed: 0, rejected: 0 };
  const items = [];
  for (const x of rows) {
    const st = regState(x);
    if (st in stats) stats[st] += 1;
    if (status && st !== status) continue;
    const u = regUser(x);
    items.push({
      id: x.id, name: x.name, phone: x.phone, course_id: x.course_id, course_title: x.course_title, created_at: x.created_at,
      kind: x.kind, gift_from: x.gift_from, status: st, status_label: REG_LABEL[st], reject_reason: x.reject_reason,
      has_receipt: !!x.receipt_name, receipt_mime: x.receipt_mime, has_account: !!u, access: u ? !!u.tracking_access : null,
    });
  }
  const courses = db.prepare("SELECT id, title FROM courses WHERE id IN (SELECT course_id FROM course_registrations UNION SELECT course_id FROM gifts) ORDER BY id DESC").all();
  res.json({ stats, items: items.slice(0, 300), courses });
});

// ---------------------------------------------------------------- إعداد عرض المكتملة
r.put('/courses-settings', (req, res) => {
  const b = req.body || {};
  if (b.hide_full_courses !== undefined) setSite({ hide_full_courses: !!b.hide_full_courses });
  if (b.payment_phone !== undefined || b.payment_holder !== undefined) {
    const cur = getSite().payment;
    setSite({ payment: {
      phone: b.payment_phone === undefined ? cur.phone : cleanTitle(b.payment_phone, 30),
      holder: b.payment_holder === undefined ? cur.holder : cleanTitle(b.payment_holder, 80),
    } });
  }
  if (b.thanks_text !== undefined) setSite({ thanks_text: cleanBody(b.thanks_text, 500) });
  if (b.whatsapp_link !== undefined) setSite({ whatsapp_link: cleanWhatsappLink(b.whatsapp_link) });
  if (b.receipt_retention_days !== undefined) {
    const d = Number(b.receipt_retention_days);
    if (!Number.isInteger(d) || d < 0 || d > 3650) throw bad('عدد أيام الحذف غير صالح');
    setSite({ receipt_retention_days: d });
  }
  audit(req.user.id, 'course.settings', 'settings', null, {});
  res.json({ ok: true, settings: { hide_full_courses: !!getSite().hide_full_courses, payment: getSite().payment, thanks_text: getSite().thanks_text, whatsapp_link: getSite().whatsapp_link, receipt_retention_days: getSite().receipt_retention_days } });
});

export default r;
