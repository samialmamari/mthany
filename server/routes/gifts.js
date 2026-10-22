import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { bad, HttpError, requireAuth } from '../middleware/auth.js';
import { cleanBody, cleanTitle } from '../util/sanitize.js';
import { checkReceipt, dropFile, receiptUpload } from '../util/receipts.js';
import { notify } from '../services/notify.js';
import { courseOut, getSite, paymentFor } from '../services/site.js';
import { claimGift, claimView, declineGift, GIFT_KINDS, GIFT_LABEL, giftLink, parseContact, requestTransfer } from '../services/gifts.js';

/** الإهداء للمُهدي (يتطلب حساباً) وصفحة استلام المُهدى إليه (الرابط وحده يكفي للاطلاع والاعتذار) */
const r = Router();
const limit = (max) => rateLimit({ windowMs: 3_600_000, limit: config.isTest ? 1000 : max, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كثيرة، حاول لاحقاً' } });

const giftable = (c) => c && c.status === 'open' && GIFT_KINDS.includes(c.kind);
const isTrue = (v) => v === true || v === '1' || v === 'true' || v === 1;

/** الدورات المتاحة للإهداء مع رقم التحويل لكل دورة والنصوص الافتراضية */
r.get('/options', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM courses WHERE kind IN (${GIFT_KINDS.map(() => '?').join(',')}) AND status='open' ORDER BY sort, start_date, id`).all(...GIFT_KINDS);
  const s = getSite();
  res.json({
    courses: rows.map((c) => ({ ...courseOut(c), payment: paymentFor(c.id) })).filter((c) => c.can_register),
    defaults: { message: s.gift_settings.message, dua: s.gift_settings.dua, theme: s.gift_settings.theme },
  });
});

r.post('/', requireAuth, limit(20), receiptUpload.single('receipt'), (req, res) => {
  try {
    const b = req.body || {};
    const c = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(b.course_id));
    if (!giftable(c)) throw bad('هذه الدورة غير متاحة للإهداء');
    if (c.seats != null && c.seats - c.seats_taken <= 0) throw new HttpError(409, 'اكتمل العدد في هذه الدورة');
    const name = cleanTitle(b.recipient_name, 80);
    if (name.length < 3) throw bad('اكتب اسم المُهدى إليه');
    const to = parseContact(b.recipient_contact, b.country);
    if (to.value === req.user.phone) throw bad('هذا رقمك أنت؛ سجّل في الدورة مباشرة من صفحتها');
    const message = cleanBody(b.message || '', 400) || getSite().gift_settings.message;
    const receipt = checkReceipt(req.file, c.price_minor > 0);
    const id = db.prepare(`INSERT INTO gifts(giver_id,course_id,recipient_name,recipient_contact,recipient_channel,message,anonymous,receipt_name,receipt_mime,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, c.id, name, to.value, to.channel, message, isTrue(b.anonymous) ? 1 : 0, receipt?.name ?? null, receipt?.mime ?? null, now()).lastInsertRowid;
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
    notify(admins, { type: 'gift_request', title: 'طلب إهداء جديد', body: `${req.user.name} يُهدي «${c.title}» إلى ${name}`, link: '#/admin/registrations' });
    res.status(201).json({ id: Number(id), course: { id: c.id, title: c.title }, dua: getSite().gift_settings.dua });
  } catch (e) { dropFile(req.file); throw e; }
});

const mineView = (g) => {
  const c = db.prepare('SELECT title, start_date, end_date FROM courses WHERE id=?').get(g.course_id);
  return {
    id: g.id, course_id: g.course_id, course_title: c.title, start_date: c.start_date, end_date: c.end_date,
    recipient_name: g.recipient_name, recipient_channel: g.recipient_channel, message: g.message, anonymous: !!g.anonymous,
    status: g.status, status_label: GIFT_LABEL[g.status], reject_reason: g.reject_reason, created_at: g.created_at, sent_at: g.sent_at, claimed_at: g.claimed_at,
    // الرابط للمشاركة اليدوية (مثل البريد) ما دامت الهدية قيد الاستلام
    link: g.status === 'sent' || g.status === 'transfer_requested' ? giftLink(g) : null,
    needs_receipt: db.prepare('SELECT price_minor FROM courses WHERE id=?').get(g.course_id).price_minor > 0,
  };
};

r.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM gifts WHERE giver_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json({ gifts: rows.map(mineView), dua: getSite().gift_settings.dua });
});

/** بعد الرفض: المُهدي يرفع إيصالاً جديداً فتعود الهدية للمراجعة */
r.post('/:id/resubmit', requireAuth, limit(20), receiptUpload.single('receipt'), (req, res) => {
  try {
    const g = db.prepare('SELECT * FROM gifts WHERE id=? AND giver_id=?').get(Number(req.params.id), req.user.id);
    if (!g) throw new HttpError(404, 'الهدية غير موجودة');
    if (g.status !== 'rejected') throw bad('لا حاجة لإيصال جديد لهذه الهدية');
    const c = db.prepare('SELECT price_minor FROM courses WHERE id=?').get(g.course_id);
    const receipt = checkReceipt(req.file, c.price_minor > 0);
    db.prepare("UPDATE gifts SET status='pending', reject_reason='', receipt_name=COALESCE(?, receipt_name), receipt_mime=COALESCE(?, receipt_mime), created_at=? WHERE id=?")
      .run(receipt?.name ?? null, receipt?.mime ?? null, now(), g.id);
    if (receipt && g.receipt_name) fs.rmSync(path.join(config.uploadDir, path.basename(g.receipt_name)), { force: true });
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
    notify(admins, { type: 'gift_request', title: 'إيصال جديد لهدية', body: `${req.user.name} رفع إيصالاً جديداً لهديته إلى ${g.recipient_name}`, link: '#/admin/registrations' });
    res.json({ ok: true });
  } catch (e) { dropFile(req.file); throw e; }
});

// ---------------------------------------------------------------- جهة المُهدى إليه (الرمز في الرابط)
const byToken = (token) => db.prepare('SELECT * FROM gifts WHERE token=?').get(String(token || '')) || (() => { throw new HttpError(404, 'رابط الهدية غير صحيح'); })();

r.get('/claim/:token', limit(120), (req, res) => {
  const v = claimView(req.params.token);
  if (!v) throw new HttpError(404, 'رابط الهدية غير صحيح');
  res.json(v);
});

r.post('/claim/:token/claim', requireAuth, limit(40), (req, res) => {
  const out = claimGift(byToken(req.params.token), req.user);
  res.json({ ok: true, ...out });
});

r.post('/claim/:token/decline', limit(40), (req, res) => {
  declineGift(byToken(req.params.token));
  res.json({ ok: true });
});

r.post('/claim/:token/transfer', limit(40), (req, res) => {
  requestTransfer(byToken(req.params.token), req.body || {});
  res.json({ ok: true });
});

export default r;
