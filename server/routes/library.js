import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { db, now, tx } from '../db.js';
import { config } from '../config.js';
import { cleanBody, cleanTitle, likeEscape } from '../util/sanitize.js';
import { bad, forbidden, HttpError, notFound, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { getStore, isPaid, money, orderOut, productOut, fileOut } from '../services/store.js';
import adminRoutes from './library-admin.js';

const r = Router();
r.use(requireAuth);

const orderLimit = rateLimit({
  windowMs: 3_600_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `o${req.user?.id}`, validate: false, message: { error: 'طلبات كثيرة خلال وقت قصير، حاول لاحقاً' },
});

const storeOn = (req) => getStore().enabled || req.user.role === 'admin';

/** يرسل ملفاً من مجلد الرفع باسمه الأصلي */
function sendStored(res, storedName, originalName, mime, { inline = false } = {}) {
  const abs = path.join(config.uploadDir, path.basename(storedName));
  if (!fs.existsSync(abs)) throw notFound('الملف غير متوفر حالياً');
  const ascii = String(originalName).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(originalName)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(abs, { dotfiles: 'allow' });
}

// ================================================================ التنزيلات المجانية
r.get('/files', (req, res) => {
  const a = [];
  let where = 'f.active = 1';
  if (Number(req.query.category)) { where += ' AND f.category_id = ?'; a.push(Number(req.query.category)); }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) { where += " AND (f.title LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\')"; a.push(`%${likeEscape(q)}%`, `%${likeEscape(q)}%`); }
  const rows = db.prepare(
    `SELECT f.*, c.name AS category_name FROM library_files f LEFT JOIN library_categories c ON c.id = f.category_id
     WHERE ${where} ORDER BY c.sort, f.title`,
  ).all(...a);
  const files = rows.map((f) => fileOut(f));
  const top = db.prepare(
    `SELECT f.*, c.name AS category_name FROM library_files f LEFT JOIN library_categories c ON c.id = f.category_id
     WHERE f.active = 1 AND (f.downloads > 0 OR f.featured = 1) ORDER BY f.featured DESC, f.downloads DESC LIMIT 6`,
  ).all().map((f) => fileOut(f));
  res.json({
    files, top,
    total_downloads: db.prepare('SELECT COALESCE(SUM(downloads),0) s FROM library_files WHERE active=1').get().s,
    categories: db.prepare('SELECT id, name FROM library_categories WHERE active=1 ORDER BY sort, id').all(),
  });
});

r.get('/files/:id/download', (req, res) => {
  const f = db.prepare('SELECT * FROM library_files WHERE id=? AND active=1').get(Number(req.params.id));
  if (!f) throw notFound('الملف غير موجود');
  // المعاينة لا تُحتسب تنزيلاً
  const inline = req.query.inline === '1';
  if (!inline) db.prepare('UPDATE library_files SET downloads = downloads + 1 WHERE id=?').run(f.id);
  sendStored(res, f.stored_name, f.file_name, f.mime, { inline });
});

r.get('/files/:id/cover', (req, res) => {
  const f = db.prepare('SELECT * FROM library_files WHERE id=? AND active=1').get(Number(req.params.id));
  if (!f || !f.cover_name) throw notFound();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  sendStored(res, f.cover_name, 'cover', f.cover_mime, { inline: true });
});

// ================================================================ المتجر
r.get('/store', (req, res) => {
  const st = getStore();
  if (!storeOn(req)) return res.json({ enabled: false, products: [] });
  const kind = ['digital', 'physical'].includes(req.query.kind) ? req.query.kind : null;
  const rows = db.prepare(`SELECT * FROM products WHERE active=1${kind ? ' AND kind=?' : ''} ORDER BY sort, id`).all(...(kind ? [kind] : []));
  res.json({
    enabled: true, products: rows.map((p) => productOut(p)),
    shipping: money(st.shipping_minor, st), shipping_minor: st.shipping_minor,
    free_shipping_over_minor: st.free_shipping_over_minor, free_shipping_over: st.free_shipping_over_minor ? money(st.free_shipping_over_minor, st) : null,
    methods: { cod: !!st.cod_enabled, bank_transfer: !!st.bank_transfer_enabled },
    bank_details: st.bank_transfer_enabled ? st.bank_details : '',
    contact_note: st.contact_note,
    me: { name: req.user.name, phone: req.user.phone },
  });
});

r.get('/products/:id/image', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
  if (!p || !p.image_name) throw notFound();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  sendStored(res, p.image_name, 'image', p.image_mime, { inline: true });
});

// ---------------------------------------------------------------- إنشاء الطلب
function priceOrder(items, method) {
  const st = getStore();
  if (!items.length) throw bad('السلة فارغة');
  if (items.length > 20) throw bad('عدد المنتجات في الطلب أكبر من المسموح');
  const lines = [];
  let subtotal = 0;
  let hasPhysical = false;
  for (const raw of items) {
    const id = Number(raw.product_id);
    const qty = Number(raw.qty || 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw bad('الكمية يجب أن تكون بين 1 و50');
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
    if (!p) throw bad('أحد المنتجات لم يعد متاحاً');
    if (lines.some((l) => l.product_id === id)) throw bad('المنتج مكرر في الطلب');
    const q = p.kind === 'digital' ? 1 : qty; // الرقمي نسخة واحدة تكفي
    if (p.kind === 'physical') {
      hasPhysical = true;
      if (p.stock != null && p.stock < q) throw bad(`الكمية المتوفرة من «${p.title}» هي ${p.stock}`);
    }
    subtotal += p.price_minor * q;
    lines.push({ product_id: p.id, title: p.title, kind: p.kind, unit_price_minor: p.price_minor, qty: q, stock: p.stock });
  }
  let shipping = 0;
  if (hasPhysical) {
    shipping = st.shipping_minor || 0;
    if (st.free_shipping_over_minor && subtotal >= st.free_shipping_over_minor) shipping = 0;
  }
  const total = subtotal + shipping;
  // طريقة الدفع
  let pay = method;
  if (total === 0) pay = 'free';
  else {
    if (!['cod', 'bank_transfer'].includes(pay)) throw bad('اختر طريقة الدفع');
    if (pay === 'cod' && (!st.cod_enabled || !hasPhysical)) throw bad('الدفع عند الاستلام متاح للمنتجات المادية فقط');
    if (pay === 'bank_transfer' && !st.bank_transfer_enabled) throw bad('التحويل البنكي غير متاح حالياً');
  }
  return { lines, subtotal, shipping, total, pay, hasPhysical };
}

r.post('/orders', orderLimit, (req, res) => {
  if (!getStore().enabled) throw forbidden('المتجر غير متاح حالياً');
  const b = req.body || {};
  const { lines, subtotal, shipping, total, pay, hasPhysical } = priceOrder(Array.isArray(b.items) ? b.items : [], b.payment_method);

  let ship = null;
  if (hasPhysical) {
    ship = {
      name: cleanTitle(b.ship?.name || req.user.name, 80),
      phone: cleanTitle(b.ship?.phone || req.user.phone, 25),
      city: cleanTitle(b.ship?.city || '', 60),
      address: cleanBody(b.ship?.address || '', 300),
    };
    if (!ship.name || !ship.phone) throw bad('اكتب اسم المستلم ورقم هاتفه');
    if (!ship.city || ship.address.length < 5) throw bad('اكتب المدينة والعنوان بالتفصيل');
  }
  const note = cleanBody(b.note || '', 500);
  const payment_ref = pay === 'bank_transfer' ? cleanTitle(b.payment_ref || '', 60) : '';
  const t = now();

  const id = tx(() => {
    const oid = db.prepare(
      `INSERT INTO orders(user_id,status,payment_method,subtotal_minor,shipping_minor,total_minor,
        ship_name,ship_phone,ship_city,ship_address,note,payment_ref,created_at,updated_at,paid_at,delivered_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(req.user.id, total === 0 ? 'paid' : 'new', pay, subtotal, shipping, total,
      ship?.name ?? null, ship?.phone ?? null, ship?.city ?? null, ship?.address ?? null, note, payment_ref, t, t,
      total === 0 ? t : null, total === 0 && !hasPhysical ? t : null).lastInsertRowid;
    if (total === 0 && !hasPhysical) db.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(oid);
    for (const l of lines) {
      db.prepare('INSERT INTO order_items(order_id,product_id,title,kind,unit_price_minor,qty) VALUES(?,?,?,?,?,?)')
        .run(oid, l.product_id, l.title, l.kind, l.unit_price_minor, l.qty);
      if (l.kind === 'physical' && l.stock != null) db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?').run(l.qty, l.product_id);
    }
    return oid;
  });

  audit(req.user.id, 'store.order_create', 'order', Number(id), { total_minor: total, items: lines.length });
  const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
  if (total > 0) {
    notify(admins, { type: 'order_new', title: 'طلب جديد في المتجر', body: `${req.user.name} — ${money(total)}`, link: '#/store-admin?tab=orders' });
  }
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  res.status(201).json({ order: orderOut(o) });
});

// ---------------------------------------------------------------- طلباتي
r.get('/orders', (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json({ orders: rows.map((o) => orderOut(o)) });
});

const myOrder = (req) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o || o.user_id !== req.user.id) throw notFound('الطلب غير موجود');
  return o;
};

r.post('/orders/:id/payment-ref', (req, res) => {
  const o = myOrder(req);
  if (o.payment_method !== 'bank_transfer' || o.status !== 'new') throw new HttpError(409, 'لا يمكن تعديل بيانات الدفع لهذا الطلب');
  const ref = cleanTitle(req.body?.payment_ref || '', 60);
  if (!ref) throw bad('اكتب رقم الحوالة أو مرجع التحويل');
  db.prepare('UPDATE orders SET payment_ref=?, updated_at=? WHERE id=?').run(ref, now(), o.id);
  const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
  notify(admins, { type: 'order_payment', title: 'إشعار تحويل لطلب', body: `طلب رقم ${o.id} — ${req.user.name}`, link: '#/store-admin?tab=orders' });
  res.json({ order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)) });
});

r.post('/orders/:id/cancel', (req, res) => {
  const o = myOrder(req);
  if (o.status !== 'new') throw new HttpError(409, 'لا يمكن إلغاء الطلب بعد تأكيده؛ تواصل مع الإدارة');
  const t = now();
  tx(() => {
    db.prepare("UPDATE orders SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=?").run(t, t, o.id);
    for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)) {
      if (it.kind === 'physical' && it.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id=? AND stock IS NOT NULL').run(it.qty, it.product_id);
    }
  });
  audit(req.user.id, 'store.order_cancel_by_user', 'order', o.id, {});
  res.json({ order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)) });
});

/** تنزيل المنتج الرقمي بعد الدفع */
r.get('/orders/:id/items/:itemId/download', (req, res) => {
  const o = myOrder(req);
  if (!isPaid(o)) throw forbidden('يتاح التنزيل بعد تأكيد الدفع');
  const it = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(Number(req.params.itemId), o.id);
  if (!it || it.kind !== 'digital') throw notFound();
  const p = it.product_id ? db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id) : null;
  if (!p || !p.stored_name) throw notFound('الملف غير متوفر، تواصل مع الإدارة');
  sendStored(res, p.stored_name, p.file_name, p.file_mime);
});

r.use('/admin', adminRoutes);
export default r;
