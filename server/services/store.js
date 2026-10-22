/**
 * المكتبة والمتجر: الإعدادات، وتنسيق المبالغ، وتجهيز الطلبات للعرض.
 * المبالغ تُخزَّن بأصغر وحدة (بيسة: 1 ريال عُماني = 1000) لتفادي أخطاء الكسور العشرية.
 */
import { db, getSetting, setSetting } from '../db.js';

export const STORE_DEFAULTS = {
  enabled: true,
  currency: 'ر.ع',
  minor_per_unit: 1000,            // بيسة لكل ريال
  shipping_minor: 1000,            // أجرة الشحن للطلبات المادية
  free_shipping_over_minor: 0,     // 0 = معطّل
  cod_enabled: true,               // الدفع عند الاستلام
  bank_transfer_enabled: true,
  bank_details: 'اسم المستفيد: مؤسسة مثاني\nالبنك: —\nرقم الحساب: —\nالآيبان: —',
  contact_note: 'للاستفسار عن الطلبات تواصل مع الإدارة.',
};

export function getStore() {
  return { ...STORE_DEFAULTS, ...(getSetting('store', {}) || {}) };
}
export function setStore(patch) {
  setSetting('store', { ...(getSetting('store', {}) || {}), ...patch });
}

/** يحوّل المبلغ من أصغر وحدة إلى نص عربي: 1500 → "1.500 ر.ع" */
export function money(minor, st = getStore()) {
  const per = st.minor_per_unit || 1000;
  const digits = String(per).length - 1;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / per);
  const frac = String(abs % per).padStart(digits, '0');
  return `${sign}${whole.toLocaleString('ar-OM-u-nu-latn')}${digits ? `.${frac}` : ''} ${st.currency}`;
}

export const ORDER_STATUS = {
  new: 'جديد (بانتظار التأكيد)',
  paid: 'مدفوع',
  processing: 'قيد التجهيز',
  shipped: 'تم الشحن',
  delivered: 'تم التسليم',
  cancelled: 'ملغى',
};

export const PAYMENT_LABEL = { cod: 'الدفع عند الاستلام', bank_transfer: 'تحويل بنكي', free: 'مجاني' };

/** الحالات التي يُعدّ فيها الطلب مدفوعاً فيُسلَّم المنتج الرقمي */
export const PAID_STATES = ['paid', 'processing', 'shipped', 'delivered'];
export const isPaid = (o) => PAID_STATES.includes(o.status);

/** انتقالات الحالة المسموحة (تُفرض في الخادم) */
export const ORDER_FLOW = {
  new: ['paid', 'cancelled'],
  paid: ['processing', 'delivered', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function orderItems(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(orderId);
}

/** يجهّز الطلب للعرض: العناصر، والملفات الرقمية المتاحة بعد الدفع */
export function orderOut(o, { admin = false } = {}) {
  const st = getStore();
  const items = orderItems(o.id).map((it) => ({
    id: it.id, product_id: it.product_id, title: it.title, kind: it.kind, qty: it.qty,
    unit_price_minor: it.unit_price_minor, unit_price: it.unit_price_minor ? money(it.unit_price_minor, st) : 'مجاناً',
    line_minor: it.unit_price_minor * it.qty, line: it.unit_price_minor ? money(it.unit_price_minor * it.qty, st) : 'مجاناً',
    downloadable: it.kind === 'digital' && isPaid(o),
  }));
  const out = {
    id: o.id, status: o.status, status_label: ORDER_STATUS[o.status],
    payment_method: o.payment_method, payment_label: PAYMENT_LABEL[o.payment_method],
    subtotal_minor: o.subtotal_minor, shipping_minor: o.shipping_minor, total_minor: o.total_minor,
    subtotal: money(o.subtotal_minor, st), shipping: money(o.shipping_minor, st), total: money(o.total_minor, st),
    has_physical: items.some((i) => i.kind === 'physical'),
    ship: o.ship_name ? { name: o.ship_name, phone: o.ship_phone, city: o.ship_city, address: o.ship_address } : null,
    note: o.note, payment_ref: o.payment_ref, admin_note: o.admin_note,
    created_at: o.created_at, updated_at: o.updated_at, paid_at: o.paid_at, shipped_at: o.shipped_at, delivered_at: o.delivered_at,
    items,
  };
  if (admin) {
    const u = db.prepare('SELECT id, name, phone FROM users WHERE id=?').get(o.user_id);
    out.user = u ? { id: u.id, name: u.name, phone: u.phone } : { id: o.user_id, name: 'عضو محذوف', phone: '' };
    out.next_states = ORDER_FLOW[o.status];
  }
  return out;
}

export function productOut(p, { admin = false } = {}) {
  const st = getStore();
  const out = {
    id: p.id, kind: p.kind, title: p.title, description: p.description,
    price_minor: p.price_minor, price: p.price_minor ? money(p.price_minor, st) : 'مجاناً',
    free: p.price_minor === 0, stock: p.stock, in_stock: p.kind === 'digital' || p.stock == null || p.stock > 0,
    has_image: !!p.image_name, sort: p.sort,
  };
  if (admin) Object.assign(out, { active: !!p.active, has_file: !!p.stored_name, file_name: p.file_name, created_at: p.created_at });
  return out;
}

const AUDIO = ['audio/mpeg', 'audio/mp4', 'audio/wav'];
/** نوع الملف للعرض: مستند أو صوت أو صورة */
export function fileKind(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (AUDIO.includes(mime)) return 'audio';
  if (String(mime).startsWith('image/')) return 'image';
  return 'other';
}
const EXT_LABEL = { 'application/pdf': 'PDF', 'audio/mpeg': 'MP3', 'audio/mp4': 'M4A', 'audio/wav': 'WAV', 'application/zip': 'ZIP', 'text/plain': 'TXT' };

export function fileOut(f, { admin = false } = {}) {
  const kind = fileKind(f.mime);
  const out = {
    id: f.id, title: f.title, description: f.description, file_name: f.file_name, mime: f.mime, size: f.size,
    kind, type_label: EXT_LABEL[f.mime] || (f.file_name.split('.').pop() || '').toUpperCase(),
    meta_label: f.meta_label || '', featured: !!f.featured, has_cover: !!f.cover_name,
    previewable: ['pdf', 'audio', 'image'].includes(kind),
    downloads: f.downloads, category: f.category_id ? { id: f.category_id, name: f.category_name } : null,
  };
  if (admin) Object.assign(out, { active: !!f.active, created_at: f.created_at });
  return out;
}
