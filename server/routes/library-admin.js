import { Router } from 'express';
import multer from 'multer';
import { db, now, tx } from '../db.js';
import { config } from '../config.js';
import { randomToken } from '../util/crypto.js';
import { cleanBody, cleanTitle } from '../util/sanitize.js';
import { extOf, FILE_TYPES, IMAGE_TYPES, validSignature } from '../util/files.js';
import { bad, forbidden, HttpError, notFound } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { removeStoredFile } from '../services/submissions.js';
import { fileOut, getStore, money, ORDER_FLOW, ORDER_STATUS, orderOut, productOut, setStore, STORE_DEFAULTS } from '../services/store.js';

const r = Router();
r.use((req, _res, next) => (req.user.role === 'admin' ? next() : next(forbidden('إدارة المكتبة والمتجر للمدير فقط'))));

const upload = multer({
  storage: multer.diskStorage({ destination: config.uploadDir, filename: (_q, f, cb) => cb(null, `lib-${randomToken(18)}.${extOf(f.originalname)}`) }),
  limits: { fileSize: 50 * 1024 * 1024, files: 2 },
  fileFilter: (_q, f, cb) => (FILE_TYPES[extOf(f.originalname)] ? cb(null, true) : cb(new HttpError(400, `نوع الملف غير مسموح (.${extOf(f.originalname) || '؟'})`))),
});
const fields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

/** يتحقق من توقيع كل ملف مرفوع، ويحذفها جميعاً عند أي خطأ */
function withFiles(req, fn) {
  const all = Object.values(req.files || {}).flat();
  try {
    for (const f of all) if (!validSignature(f)) throw bad(`الملف «${f.originalname}» تالف أو لا يطابق امتداده`);
    return fn(req.files?.file?.[0] || null, req.files?.image?.[0] || null, req.files?.cover?.[0] || null);
  } catch (e) { all.forEach((f) => removeStoredFile(f.filename)); throw e; }
}
const isTrue = (v) => v === '1' || v === 'true' || v === true;

// ================================================================ ملفات التنزيل المجاني
r.get('/files', (_req, res) => {
  const rows = db.prepare('SELECT f.*, c.name AS category_name FROM library_files f LEFT JOIN library_categories c ON c.id=f.category_id ORDER BY f.id DESC').all();
  res.json({
    files: rows.map((f) => fileOut(f, { admin: true })),
    categories: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM library_files f WHERE f.category_id=c.id) AS files FROM library_categories c ORDER BY sort, id').all(),
  });
});

function fileFields(req) {
  const title = cleanTitle(req.body.title, 120);
  if (title.length < 2) throw bad('اسم الملف مطلوب');
  const category_id = Number(req.body.category_id) || null;
  if (category_id && !db.prepare('SELECT 1 FROM library_categories WHERE id=?').get(category_id)) throw bad('تصنيف غير صالح');
  const cover = req.files?.cover?.[0];
  if (cover && !IMAGE_TYPES[extOf(cover.originalname)]) throw bad('الغلاف يجب أن يكون صورة jpg أو png أو webp');
  return {
    title, description: cleanBody(req.body.description || '', 1000), category_id,
    meta_label: cleanTitle(req.body.meta_label || '', 40), featured: isTrue(req.body.featured) ? 1 : 0,
  };
}

r.post('/files', fields, (req, res) => {
  withFiles(req, (file, _image, cover) => {
    if (!file) throw bad('أرفق الملف');
    const f = fileFields(req);
    const t = now();
    const id = db.prepare(
      `INSERT INTO library_files(title,description,category_id,file_name,stored_name,mime,size,meta_label,featured,cover_name,cover_mime,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(f.title, f.description, f.category_id, file.originalname.slice(0, 200), file.filename, FILE_TYPES[extOf(file.originalname)], file.size,
      f.meta_label, f.featured, cover?.filename ?? null, cover ? IMAGE_TYPES[extOf(cover.originalname)] : null, req.user.id, t, t).lastInsertRowid;
    audit(req.user.id, 'library.file_add', 'library_file', Number(id), { title: f.title });
    res.status(201).json({ id });
  });
});

r.put('/files/:id', fields, (req, res) => {
  withFiles(req, (file, _image, cover) => {
    const ex = db.prepare('SELECT * FROM library_files WHERE id=?').get(Number(req.params.id));
    if (!ex) throw notFound();
    const f = fileFields(req);
    const active = req.body.active === undefined ? ex.active : (isTrue(req.body.active) ? 1 : 0);
    db.prepare('UPDATE library_files SET title=?,description=?,category_id=?,active=?,meta_label=?,featured=?,updated_at=? WHERE id=?')
      .run(f.title, f.description, f.category_id, active, f.meta_label, f.featured, now(), ex.id);
    if (cover) {
      db.prepare('UPDATE library_files SET cover_name=?, cover_mime=? WHERE id=?').run(cover.filename, IMAGE_TYPES[extOf(cover.originalname)], ex.id);
      if (ex.cover_name) removeStoredFile(ex.cover_name);
    } else if (isTrue(req.body.remove_cover) && ex.cover_name) {
      db.prepare('UPDATE library_files SET cover_name=NULL, cover_mime=NULL WHERE id=?').run(ex.id);
      removeStoredFile(ex.cover_name);
    }
    if (file) {
      db.prepare('UPDATE library_files SET file_name=?,stored_name=?,mime=?,size=? WHERE id=?')
        .run(file.originalname.slice(0, 200), file.filename, FILE_TYPES[extOf(file.originalname)], file.size, ex.id);
      removeStoredFile(ex.stored_name);
    }
    audit(req.user.id, 'library.file_edit', 'library_file', ex.id, { title: f.title, replaced: !!file });
    res.json({ ok: true });
  });
});

/** تعديل سريع للملف: الإظهار أو العنوان أو التصنيف، دون إعادة رفعه */
r.patch('/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM library_files WHERE id=?').get(Number(req.params.id));
  if (!f) throw notFound();
  const b = req.body || {};
  const title = b.title !== undefined ? cleanTitle(b.title, 120) : f.title;
  if (title.length < 2) throw bad('اسم الملف مطلوب');
  let category_id = f.category_id;
  if (b.category_id !== undefined) {
    category_id = Number(b.category_id) || null;
    if (category_id && !db.prepare('SELECT 1 FROM library_categories WHERE id=?').get(category_id)) throw bad('تصنيف غير صالح');
  }
  const active = b.active === undefined ? f.active : (b.active ? 1 : 0);
  const featured = b.featured === undefined ? f.featured : (b.featured ? 1 : 0);
  db.prepare('UPDATE library_files SET title=?, category_id=?, active=?, featured=?, updated_at=? WHERE id=?').run(title, category_id, active, featured, now(), f.id);
  audit(req.user.id, 'library.file_patch', 'library_file', f.id, { title, active: !!active });
  res.json({ file: fileOut(db.prepare('SELECT f.*, c.name AS category_name FROM library_files f LEFT JOIN library_categories c ON c.id=f.category_id WHERE f.id=?').get(f.id), { admin: true }) });
});

r.delete('/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM library_files WHERE id=?').get(Number(req.params.id));
  if (!f) throw notFound();
  db.prepare('DELETE FROM library_files WHERE id=?').run(f.id);
  removeStoredFile(f.stored_name);
  if (f.cover_name) removeStoredFile(f.cover_name);
  audit(req.user.id, 'library.file_delete', 'library_file', f.id, { title: f.title });
  res.json({ ok: true });
});

// ---------------- تصنيفات المكتبة ----------------
r.post('/categories', (req, res) => {
  const name = cleanTitle(req.body?.name, 40);
  if (name.length < 2) throw bad('اسم التصنيف قصير');
  if (db.prepare('SELECT 1 FROM library_categories WHERE name=?').get(name)) throw bad('التصنيف موجود');
  const sort = (db.prepare('SELECT MAX(sort) m FROM library_categories').get().m ?? -1) + 1;
  const id = db.prepare('INSERT INTO library_categories(name,sort) VALUES(?,?)').run(name, sort).lastInsertRowid;
  res.status(201).json({ id });
});

r.patch('/categories/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM library_categories WHERE id=?').get(Number(req.params.id));
  if (!c) throw notFound();
  const name = req.body?.name !== undefined ? cleanTitle(req.body.name, 40) : c.name;
  if (name.length < 2) throw bad('اسم التصنيف قصير');
  if (db.prepare('SELECT 1 FROM library_categories WHERE name=? AND id<>?').get(name, c.id)) throw bad('التصنيف موجود');
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : c.active;
  db.prepare('UPDATE library_categories SET name=?, active=? WHERE id=?').run(name, active, c.id);
  res.json({ ok: true });
});

r.delete('/categories/:id', (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM library_files WHERE category_id=?').get(id)) throw new HttpError(409, 'التصنيف مستخدم في ملفات؛ عطّله بدلاً من حذفه');
  db.prepare('DELETE FROM library_categories WHERE id=?').run(id);
  res.json({ ok: true });
});

// ================================================================ المنتجات
r.get('/products', (_req, res) => {
  res.json({ products: db.prepare('SELECT * FROM products ORDER BY sort, id').all().map((p) => productOut(p, { admin: true })) });
});

function productFields(req) {
  const kind = req.body.kind === 'physical' ? 'physical' : 'digital';
  const title = cleanTitle(req.body.title, 120);
  if (title.length < 2) throw bad('اسم المنتج مطلوب');
  const price_minor = Number(req.body.price_minor);
  if (!Number.isInteger(price_minor) || price_minor < 0 || price_minor > 100_000_000) throw bad('السعر غير صالح');
  let stock = null;
  if (kind === 'physical' && req.body.stock !== '' && req.body.stock != null) {
    stock = Number(req.body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) throw bad('الكمية غير صالحة');
  }
  const sort = Number(req.body.sort || 0);
  return { kind, title, description: cleanBody(req.body.description || '', 2000), price_minor, stock, sort: Number.isInteger(sort) ? sort : 0 };
}

r.post('/products', fields, (req, res) => {
  withFiles(req, (file, image) => {
    const p = productFields(req);
    if (image && !IMAGE_TYPES[extOf(image.originalname)]) throw bad('صورة المنتج يجب أن تكون jpg أو png أو gif أو webp');
    if (p.kind === 'digital' && !file) throw bad('أرفق ملف المنتج الرقمي الذي يُسلَّم للمشتري');
    const t = now();
    const id = db.prepare(
      `INSERT INTO products(kind,title,description,price_minor,stock,image_name,image_mime,file_name,stored_name,file_mime,file_size,sort,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(p.kind, p.title, p.description, p.price_minor, p.stock, image?.filename ?? null, image ? IMAGE_TYPES[extOf(image.originalname)] : null,
      file?.originalname.slice(0, 200) ?? null, file?.filename ?? null, file ? FILE_TYPES[extOf(file.originalname)] : null, file?.size ?? null, p.sort, t, t).lastInsertRowid;
    audit(req.user.id, 'store.product_add', 'product', Number(id), { title: p.title, kind: p.kind, price_minor: p.price_minor });
    res.status(201).json({ id });
  });
});

r.put('/products/:id', fields, (req, res) => {
  withFiles(req, (file, image) => {
    const ex = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
    if (!ex) throw notFound();
    const p = productFields(req);
    if (p.kind !== ex.kind) throw bad('لا يمكن تغيير نوع المنتج بعد إنشائه');
    if (image && !IMAGE_TYPES[extOf(image.originalname)]) throw bad('صورة المنتج يجب أن تكون jpg أو png أو gif أو webp');
    const active = req.body.active === undefined ? ex.active : (isTrue(req.body.active) ? 1 : 0);
    db.prepare('UPDATE products SET title=?,description=?,price_minor=?,stock=?,active=?,sort=?,updated_at=? WHERE id=?')
      .run(p.title, p.description, p.price_minor, p.stock, active, p.sort, now(), ex.id);
    if (image) { db.prepare('UPDATE products SET image_name=?,image_mime=? WHERE id=?').run(image.filename, IMAGE_TYPES[extOf(image.originalname)], ex.id); if (ex.image_name) removeStoredFile(ex.image_name); }
    else if (isTrue(req.body.remove_image) && ex.image_name) { db.prepare('UPDATE products SET image_name=NULL,image_mime=NULL WHERE id=?').run(ex.id); removeStoredFile(ex.image_name); }
    if (file) {
      db.prepare('UPDATE products SET file_name=?,stored_name=?,file_mime=?,file_size=? WHERE id=?')
        .run(file.originalname.slice(0, 200), file.filename, FILE_TYPES[extOf(file.originalname)], file.size, ex.id);
      if (ex.stored_name) removeStoredFile(ex.stored_name);
    }
    audit(req.user.id, 'store.product_edit', 'product', ex.id, { title: p.title });
    res.json({ ok: true });
  });
});

/** تعديل سريع للمنتج: السعر والمخزون والإظهار والترتيب */
r.patch('/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
  if (!p) throw notFound();
  const b = req.body || {};
  const sets = {};
  if (b.price_minor !== undefined) {
    const n = Number(b.price_minor);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw bad('السعر غير صالح');
    sets.price_minor = n;
  }
  if (b.stock !== undefined) {
    if (p.kind !== 'physical') throw bad('المخزون للمنتجات المادية فقط');
    if (b.stock === null || b.stock === '') sets.stock = null;
    else {
      const n = Number(b.stock);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw bad('الكمية غير صالحة');
      sets.stock = n;
    }
  }
  if (b.active !== undefined) sets.active = b.active ? 1 : 0;
  if (b.sort !== undefined) {
    const n = Number(b.sort);
    if (!Number.isInteger(n)) throw bad('الترتيب غير صالح');
    sets.sort = n;
  }
  if (!Object.keys(sets).length) throw bad('لا تغييرات');
  const cols = Object.keys(sets);
  db.prepare(`UPDATE products SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => sets[c]), now(), p.id);
  audit(req.user.id, 'store.product_patch', 'product', p.id, { title: p.title, ...sets });
  res.json({ product: productOut(db.prepare('SELECT * FROM products WHERE id=?').get(p.id), { admin: true }) });
});

r.delete('/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
  if (!p) throw notFound();
  if (db.prepare('SELECT 1 FROM order_items WHERE product_id=?').get(p.id)) throw new HttpError(409, 'المنتج مرتبط بطلبات سابقة؛ عطّله بدلاً من حذفه');
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  if (p.image_name) removeStoredFile(p.image_name);
  if (p.stored_name) removeStoredFile(p.stored_name);
  audit(req.user.id, 'store.product_delete', 'product', p.id, { title: p.title });
  res.json({ ok: true });
});

// ================================================================ الطلبات
r.get('/orders', (req, res) => {
  const status = Object.keys(ORDER_STATUS).includes(req.query.status) ? req.query.status : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 20;
  const where = status ? 'WHERE o.status = ?' : '';
  const a = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM orders o ${where}`).get(...a).c;
  const rows = db.prepare(`SELECT o.* FROM orders o ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
  const counts = Object.fromEntries(Object.keys(ORDER_STATUS).map((s) => [s, 0]));
  for (const x of db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status').all()) counts[x.status] = x.c;
  res.json({ orders: rows.map((o) => orderOut(o, { admin: true })), total, page, pages: Math.max(1, Math.ceil(total / limit)), counts });
});

r.post('/orders/:id/status', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) throw notFound();
  const to = req.body?.status;
  if (!ORDER_FLOW[o.status]?.includes(to)) throw new HttpError(409, 'لا يمكن نقل الطلب إلى هذه الحالة');
  const t = now();
  const stamp = { paid: 'paid_at', shipped: 'shipped_at', delivered: 'delivered_at', cancelled: 'cancelled_at' }[to];
  tx(() => {
    db.prepare(`UPDATE orders SET status=?, updated_at=?${stamp ? `, ${stamp}=?` : ''} WHERE id=?`).run(...(stamp ? [to, t, t, o.id] : [to, t, o.id]));
    if (to === 'cancelled') {
      for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)) {
        if (it.kind === 'physical' && it.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id=? AND stock IS NOT NULL').run(it.qty, it.product_id);
      }
    }
  });
  if (req.body?.admin_note !== undefined) db.prepare('UPDATE orders SET admin_note=? WHERE id=?').run(cleanBody(req.body.admin_note, 500), o.id);
  audit(req.user.id, `store.order_${to}`, 'order', o.id, { user_id: o.user_id, total_minor: o.total_minor });

  const msg = {
    paid: ['تم تأكيد دفع طلبك', 'يمكنك تنزيل المنتجات الرقمية الآن من «طلباتي».'],
    processing: ['طلبك قيد التجهيز', ''],
    shipped: ['تم شحن طلبك', ''],
    delivered: ['تم تسليم طلبك', 'نسأل الله أن ينفعك به.'],
    cancelled: ['تم إلغاء طلبك', cleanBody(req.body?.admin_note || '', 200)],
  }[to];
  notify([o.user_id], { type: `order_${to}`, title: `${msg[0]} (طلب رقم ${o.id})`, body: msg[1], link: '#/library/orders' });
  res.json({ order: orderOut(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id), { admin: true }) });
});

// ================================================================ إعدادات المتجر
r.get('/settings', (_req, res) => {
  const st = getStore();
  res.json({ settings: st, preview: { shipping: money(st.shipping_minor, st), sample: money(12_500, st) } });
});

r.put('/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.cod_enabled !== undefined) patch.cod_enabled = !!b.cod_enabled;
  if (b.bank_transfer_enabled !== undefined) patch.bank_transfer_enabled = !!b.bank_transfer_enabled;
  for (const k of ['shipping_minor', 'free_shipping_over_minor']) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw bad('قيمة غير صالحة في إعدادات المبالغ');
    patch[k] = n;
  }
  if (b.currency !== undefined) {
    const c = cleanTitle(b.currency, 10);
    if (!c) throw bad('رمز العملة مطلوب');
    patch.currency = c;
  }
  if (b.bank_details !== undefined) patch.bank_details = cleanBody(b.bank_details, 1000);
  if (b.contact_note !== undefined) patch.contact_note = cleanBody(b.contact_note, 300);
  setStore(patch);
  audit(req.user.id, 'store.settings', 'settings', null, { keys: Object.keys(patch) });
  res.json({ ok: true, settings: getStore() });
});

// ================================================================ إحصاءات
r.get('/stats', (_req, res) => {
  const st = getStore();
  const paid = "status IN ('paid','processing','shipped','delivered')";
  const revenue = db.prepare(`SELECT COALESCE(SUM(total_minor),0) s FROM orders WHERE ${paid}`).get().s;
  res.json({
    orders_total: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
    orders_new: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='new'").get().c,
    revenue_minor: revenue, revenue: money(revenue, st),
    downloads: db.prepare('SELECT COALESCE(SUM(downloads),0) s FROM library_files').get().s,
    files: db.prepare('SELECT COUNT(*) c FROM library_files WHERE active=1').get().c,
    products: db.prepare('SELECT COUNT(*) c FROM products WHERE active=1').get().c,
    top_files: db.prepare('SELECT title, downloads FROM library_files ORDER BY downloads DESC LIMIT 5').all(),
    top_products: db.prepare(
      `SELECT i.title, SUM(i.qty) qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.${paid} GROUP BY i.title ORDER BY qty DESC LIMIT 5`,
    ).all(),
  });
});

export { STORE_DEFAULTS };
export default r;
