import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { bad, forbidden, HttpError, notFound } from '../middleware/auth.js';
import { cleanBody } from '../util/sanitize.js';
import { audit } from '../services/audit.js';
import { getSite, setSite } from '../services/site.js';
import {
  approveGift, approveTransfer, baseUrlOf, GIFT_LABEL, deliverGift, giftLink, reassignGift, rejectGift, rejectTransfer,
} from '../services/gifts.js';

/** إدارة الهدايا (للمدير): المراجعة والإرسال والتحويل والإعدادات */
const r = Router();
r.use((req, _res, next) => (req.user?.role === 'admin' ? next() : next(forbidden('إدارة الهدايا للمدير فقط'))));

const getGift = (id) => db.prepare('SELECT * FROM gifts WHERE id=?').get(Number(id)) || (() => { throw notFound('الهدية غير موجودة'); })();
const THEMES = ['green', 'peach', 'sand'];

const adminView = (g) => ({
  id: g.id, type: 'gift', course_id: g.course_id, course_title: g.course_title, created_at: g.created_at,
  giver_name: g.giver_name, giver_phone: g.giver_phone,
  recipient_name: g.recipient_name, recipient_contact: g.recipient_contact, recipient_channel: g.recipient_channel,
  message: g.message, anonymous: !!g.anonymous, status: g.status, status_label: GIFT_LABEL[g.status], reject_reason: g.reject_reason,
  has_receipt: !!g.receipt_name, receipt_mime: g.receipt_mime, delivery: g.delivery,
  link: g.token && ['sent', 'transfer_requested'].includes(g.status) ? giftLink(g) : null,
  transfer_name: g.transfer_name, transfer_contact: g.transfer_contact,
});

r.get('/gifts-board', (req, res) => {
  const courseId = Number(req.query.course_id) || null;
  const status = Object.keys(GIFT_LABEL).includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT g.*, c.title AS course_title, u.name AS giver_name, u.phone AS giver_phone FROM gifts g
    JOIN courses c ON c.id = g.course_id JOIN users u ON u.id = g.giver_id ${courseId ? 'WHERE g.course_id = ?' : ''} ORDER BY g.id DESC LIMIT 1000`).all(...(courseId ? [courseId] : []));
  const stats = { total: rows.length, ...Object.fromEntries(Object.keys(GIFT_LABEL).map((k) => [k, 0])) };
  for (const g of rows) stats[g.status] += 1;
  const items = rows.filter((g) => !status || g.status === status).slice(0, 300).map(adminView);
  res.json({ stats, items, settings: getSite().gift_settings });
});

r.get('/gifts/:id/receipt', (req, res) => {
  const g = getGift(req.params.id);
  if (!g.receipt_name) throw notFound('لا إيصال لهذه الهدية');
  const abs = path.join(config.uploadDir, path.basename(g.receipt_name));
  if (!fs.existsSync(abs)) throw notFound('ملف الإيصال غير موجود');
  res.setHeader('Content-Type', g.receipt_mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(abs, { dotfiles: 'allow' });
});

/** قبول وإرسال الهدية، أو رفضها بسبب */
r.patch('/gifts/:id', async (req, res) => {
  const g = getGift(req.params.id);
  const { action, reason } = req.body || {};
  if (action === 'approve') await approveGift(g, { baseUrl: baseUrlOf(req) });
  else if (action === 'reject') rejectGift(g, reason);
  else throw bad('إجراء غير صالح');
  audit(req.user.id, `gift.${action}`, 'gift', g.id, { course_id: g.course_id });
  res.json({ ok: true, status: getGift(g.id).status });
});

r.post('/gifts/:id/resend', async (req, res) => {
  const g = getGift(req.params.id);
  if (g.status !== 'sent') throw bad('تُعاد البطاقة للهدايا المرسلة فقط');
  const delivery = await deliverGift(g);
  audit(req.user.id, 'gift.resend', 'gift', g.id, {});
  res.json({ ok: true, delivery });
});

/** تحويل الهدية لشخص آخر (بعد اعتذار أو بطلب المُهدى إليه) */
r.post('/gifts/:id/reassign', async (req, res) => {
  const g = getGift(req.params.id);
  await reassignGift(g, { ...(req.body || {}), baseUrl: baseUrlOf(req) });
  audit(req.user.id, 'gift.reassign', 'gift', g.id, {});
  res.json({ ok: true });
});

r.patch('/gifts/:id/transfer', async (req, res) => {
  const g = getGift(req.params.id);
  if (req.body?.approve) await approveTransfer(g, { baseUrl: baseUrlOf(req) });
  else rejectTransfer(g);
  audit(req.user.id, req.body?.approve ? 'gift.transfer_approve' : 'gift.transfer_reject', 'gift', g.id, {});
  res.json({ ok: true });
});

r.put('/gift-settings', (req, res) => {
  const b = req.body || {};
  const cur = getSite().gift_settings;
  const theme = b.theme === undefined ? cur.theme : b.theme;
  if (!THEMES.includes(theme)) throw bad('شكل البطاقة غير صالح');
  const message = b.message === undefined ? cur.message : cleanBody(b.message, 400);
  const dua = b.dua === undefined ? cur.dua : cleanBody(b.dua, 400);
  if (!message) throw bad('اكتب نص الرسالة الافتراضية');
  setSite({ gift_settings: { message, theme, dua } });
  audit(req.user.id, 'gift.settings', 'settings', null, {});
  res.json({ ok: true, settings: getSite().gift_settings });
});

export default r;
