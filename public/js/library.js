import {
  h, mount, icon, get, post, api, qs, toast, fail, busy, modal, confirmDialog, state, emptyState, fmtDateTime, fmtNum,
} from './core.js';

const CART_KEY = 'mathani_cart';
const go = (hash) => { location.hash = hash; };
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(b / 1024))} ك.ب`);

// ---------------------------------------------------------------- السلة (في المتصفح فقط)
function readCart() {
  try { const v = JSON.parse(localStorage.getItem(CART_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function writeCart(c) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* وضع التصفح الخاص */ }
  paintCartBadge();
}
export function cartCount() { return Object.values(readCart()).reduce((a, b) => a + b, 0); }
export function paintCartBadge() {
  const n = cartCount();
  document.querySelectorAll('.js-cart').forEach((el) => { el.hidden = !n; el.textContent = n > 99 ? '99+' : String(n); });
}

// ---------------------------------------------------------------- المكتبة (التنزيلات + المتجر)
export async function renderLibrary(root, query) {
  let tab = query?.get('tab') === 'store' ? 'store' : 'files';
  const ordersBadge = h('span', { class: 'count-pill', hidden: true });
  get('/api/library/orders').then(({ orders }) => {
    const open = orders.filter((o) => !['delivered', 'cancelled'].includes(o.status)).length;
    ordersBadge.hidden = !open;
    ordersBadge.textContent = String(open);
  }).catch(() => {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const out = h('div');
  const paintTabs = () => mount(tabs, [['files', 'تنزيلات مجانية'], ['store', 'المتجر']].map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; paintTabs(); load(); } }, l)));

  async function load() {
    mount(out, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
    try { await (tab === 'files' ? showFiles(out, query) : showStore(out)); } catch (e) { fail(e); mount(out, ''); }
  }
  paintTabs();
  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'المكتبة'), h('div', { class: 'muted' }, 'ملفات الأذكار والأدعية مجاناً، ومنتجات المؤسسة')),
      h('div', { class: 'actions' },
        state.user?.role === 'admin' ? h('a', { class: 'btn', href: '#/store-admin' }, icon('settings'), 'إدارة المكتبة') : null,
        h('a', { class: 'btn', href: '#/library/orders' }, icon('inbox'), 'طلباتي', ordersBadge))),
    tabs, out);
  await load();
  paintCartBadge();
}

// ---------------------------------------------------------------- التنزيلات المجانية
const KIND_BADGE = { pdf: ['📄', 'PDF'], audio: ['🎧', 'صوتي'], image: ['🖼️', 'صورة'], other: ['📁', 'ملف'] };

/** معاينة الملف داخل الصفحة قبل تنزيله */
function previewFile(f) {
  const src = `/api/library/files/${f.id}/download?inline=1`;
  const body = f.kind === 'audio'
    ? h('div', { class: 'preview-audio' }, h('div', { class: 'big-ic' }, '🎧'), h('audio', { controls: true, src, style: 'width:100%' }))
    : f.kind === 'image'
      ? h('img', { class: 'preview-img', src, alt: f.title })
      : h('iframe', { class: 'preview-frame', src, title: `معاينة ${f.title}`, loading: 'lazy' });
  modal(f.title, h('div', { class: 'stack' },
    f.description ? h('p', { class: 'muted small' }, f.description) : null,
    body,
    h('div', { class: 'row' },
      h('a', { class: 'btn primary', href: `/api/library/files/${f.id}/download` }, icon('download'), 'تحميل مجاني'),
      h('span', { class: 'muted small' }, `${f.type_label} · ${fmtSize(f.size)}`))), { wide: true });
}

/** مشاركة الملف: مشاركة النظام إن توفّرت، وإلا واتساب أو نسخ الرابط */
function shareFile(f) {
  const url = `${location.origin}/#/library?file=${f.id}`;
  const text = `${f.title} — من مكتبة مثاني الرقمية`;
  const fallback = () => {
    const wa = h('a', { class: 'btn primary', href: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`, target: '_blank', rel: 'noopener' }, '💬 مشاركة عبر واتساب');
    const copy = h('button', { class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(url); toast('نُسخ الرابط', 'ok'); }
      catch { toast('تعذّر النسخ تلقائياً، انسخ الرابط من الأعلى', 'err'); }
    } }, 'نسخ الرابط');
    modal('مشاركة الملف', h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'شارك الملف مع من ينتفع به — الأجر يجري لك.'),
      h('div', { class: 'bank', style: 'direction:ltr;text-align:left' }, url),
      h('div', { class: 'row' }, wa, copy)));
  };
  // إن ألغى المستخدم المشاركة فلا نزعجه بنافذة، وإن تعذّرت نعرض البديل
  if (navigator.share) {
    navigator.share({ title: f.title, text, url }).catch((e) => { if (e?.name !== 'AbortError') fallback(); });
    return;
  }
  fallback();
}

function fileCard(f, onDownload, { compact = false } = {}) {
  const [emoji, label] = KIND_BADGE[f.kind] || KIND_BADGE.other;
  const cover = f.has_cover
    ? h('img', { class: 'cover-img', src: `/api/library/files/${f.id}/cover`, alt: '', loading: 'lazy' })
    : h('div', { class: `cover-fallback k-${f.kind}` }, h('span', { class: 'big-ic' }, emoji));
  return h('article', { class: 'rescard' + (compact ? ' compact' : '') },
    h('div', { class: 'cover' }, cover,
      h('span', { class: 'ftype' }, emoji, ' ', label),
      f.featured ? h('span', { class: 'fbadge' }, '★ الأكثر تحميلاً') : null),
    h('div', { class: 'body' },
      f.category ? h('span', { class: 'kind' }, f.category.name) : null,
      h('h3', { class: 'rtitle' }, f.title),
      f.description ? h('p', { class: 'rdesc' }, f.description) : null,
      h('div', { class: 'rmeta' },
        h('span', {}, fmtSize(f.size)),
        f.meta_label ? h('span', {}, f.meta_label) : null,
        h('span', { class: 'dl' }, '⬇️ ', `${fmtNum(f.downloads)} تحميل`)),
      h('div', { class: 'ractions' },
        h('a', { class: 'btn primary grow', href: `/api/library/files/${f.id}/download`, onclick: () => onDownload(f) }, icon('download'), 'تحميل مجاني'),
        f.previewable ? h('button', { class: 'btn iconbtn', type: 'button', title: 'معاينة', 'aria-label': `معاينة ${f.title}`, onclick: () => previewFile(f) }, '👁️') : null,
        h('button', { class: 'btn iconbtn', type: 'button', title: 'مشاركة', 'aria-label': `مشاركة ${f.title}`, onclick: () => shareFile(f) }, icon('link')))));
}

async function showFiles(out, query) {
  const d = await get('/api/library/files');
  let category = ''; let term = '';
  const q = h('input', { class: 'input searchbox', type: 'search', placeholder: 'ابحث عن كتيب أو ملف…', 'aria-label': 'بحث في المكتبة' });
  const chips = h('div', { class: 'chips' });
  const list = h('div', { class: 'resgrid' });
  const count = h('div', { class: 'muted small' });
  const onDownload = (f) => { f.downloads++; setTimeout(paint, 900); };

  const paintChips = () => mount(chips, [['', 'الكل'], ...d.categories.map((c) => [String(c.id), c.name])].map(([v, l]) =>
    h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(category === v), onclick: () => { category = v; paintChips(); paint(); } }, l)));

  function paint() {
    term = q.value.trim();
    const rows = d.files.filter((f) => (!category || String(f.category?.id) === category)
      && (!term || f.title.includes(term) || f.description.includes(term) || (f.category?.name || '').includes(term)));
    count.textContent = rows.length ? `${fmtNum(rows.length)} ملف` : '';
    mount(list, rows.length ? rows.map((f) => fileCard(f, onDownload))
      : emptyState(term || category ? 'لا نتائج مطابقة — جرّب كلمة أخرى' : 'لا توجد ملفات بعد. ستضيفها الإدارة قريباً بإذن الله.', 'book'));
  }
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(paint, 200); });
  paintChips(); paint();

  mount(out,
    h('section', { class: 'libhero' },
      h('h2', {}, 'مكتبة مثاني الرقمية 📚'),
      h('p', {}, 'ملفات مجانية وموارد إيمانية تعينك في رحلة تدبّرك وإنجازك اليومي'),
      h('div', { class: 'searchwrap' }, q),
      d.total_downloads ? h('div', { class: 'hero-stat' }, '⬇️ ', `${fmtNum(d.total_downloads)} تحميل حتى الآن`) : null),
    d.top.length ? h('section', { class: 'topstrip' },
      h('div', { class: 'row between' }, h('h3', {}, '✨ الأكثر تحميلاً'), null),
      h('div', { class: 'striprow' }, d.top.map((f) => fileCard(f, onDownload, { compact: true })))) : null,
    h('div', { class: 'row between', style: 'margin:.3rem 0 .6rem' }, chips, count),
    list);

  // فتح معاينة ملف مُشارَك عبر الرابط
  const want = Number(query?.get('file'));
  if (want) {
    const f = d.files.find((x) => x.id === want);
    if (f) previewFile(f); else toast('الملف غير متاح', 'err');
  }
}

// ---------------------------------------------------------------- المتجر
async function showStore(out) {
  const d = await get('/api/library/store');
  if (!d.enabled) { mount(out, emptyState('المتجر غير متاح حالياً', 'cart')); return; }
  const cart = readCart();
  const byId = new Map(d.products.map((p) => [String(p.id), p]));
  for (const k of Object.keys(cart)) if (!byId.has(k)) delete cart[k];
  writeCart(cart);

  let kind = '';
  const chips = h('div', { class: 'chips' });
  const list = h('div', { class: 'grid g2' });
  const bar = h('div', { class: 'cartbar', hidden: true });

  const paintChips = () => mount(chips, [['', 'الكل'], ['digital', 'منتجات رقمية'], ['physical', 'منتجات مادية']].map(([v, l]) =>
    h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(kind === v), onclick: () => { kind = v; paintChips(); paint(); } }, l)));

  function totals() {
    let subtotal = 0; let hasPhysical = false; let count = 0;
    for (const [id, qty] of Object.entries(cart)) {
      const p = byId.get(id); if (!p) continue;
      subtotal += p.price_minor * qty; count += qty;
      if (p.kind === 'physical') hasPhysical = true;
    }
    let shipping = hasPhysical ? d.shipping_minor : 0;
    if (hasPhysical && d.free_shipping_over_minor && subtotal >= d.free_shipping_over_minor) shipping = 0;
    return { subtotal, shipping, total: subtotal + shipping, hasPhysical, count };
  }
  const fmt = (minor) => {
    const per = 1000; const whole = Math.floor(minor / per); const frac = String(minor % per).padStart(3, '0');
    return `${fmtNum(whole)}.${frac} ${d.shipping.split(' ').pop()}`;
  };

  function paintBar() {
    const t = totals();
    bar.hidden = !t.count;
    mount(bar,
      h('div', { class: 'grow' }, h('strong', {}, `${fmtNum(t.count)} منتج`), h('div', { class: 'muted small' }, `الإجمالي ${fmt(t.total)}${t.hasPhysical && t.shipping ? ` (شامل الشحن ${fmt(t.shipping)})` : ''}`)),
      h('button', { class: 'btn', onclick: () => { for (const k of Object.keys(cart)) delete cart[k]; writeCart(cart); paint(); } }, 'إفراغ'),
      h('button', { class: 'btn primary', onclick: () => checkout(d, cart, byId, totals()) }, icon('cart'), 'إتمام الطلب'));
    paintCartBadge();
  }

  function paint() {
    const rows = d.products.filter((p) => !kind || p.kind === kind);
    mount(list, rows.length ? rows.map((p) => {
      const qty = cart[p.id] || 0;
      const add = () => { cart[p.id] = p.kind === 'digital' ? 1 : (cart[p.id] || 0) + 1; writeCart(cart); paint(); };
      const less = () => { cart[p.id] = (cart[p.id] || 0) - 1; if (cart[p.id] < 1) delete cart[p.id]; writeCart(cart); paint(); };
      return h('article', { class: 'card product' },
        p.has_image ? h('img', { class: 'product-img', src: `/api/library/products/${p.id}/image`, alt: '', loading: 'lazy' }) : h('div', { class: 'product-img placeholder' }, icon(p.kind === 'digital' ? 'file' : 'tag')),
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: 'gap:.4rem' }, h('span', { class: 'kind' }, p.kind === 'digital' ? 'رقمي' : 'مادي'), !p.in_stock ? h('span', { class: 'badge s-missed' }, 'نفدت الكمية') : null),
          h('h3', { style: 'margin:.3rem 0 .2rem' }, p.title),
          p.description ? h('p', { class: 'muted small', style: 'white-space:pre-wrap;margin:0 0 .4rem' }, p.description) : null,
          h('div', { class: 'row between' },
            h('strong', { class: 'price' }, p.price),
            !p.in_stock ? null : !qty ? h('button', { class: 'btn primary sm', onclick: add }, icon('cart'), 'أضف للسلة')
              : p.kind === 'digital' ? h('div', { class: 'row', style: 'gap:.5rem' }, h('span', { class: 'badge s-on_time' }, '✓ في السلة'), h('button', { class: 'btn sm', onclick: less }, 'إزالة'))
                : h('div', { class: 'qty' },
                  h('button', { class: 'btn sm', onclick: less, 'aria-label': qty > 1 ? 'إنقاص' : 'إزالة' }, qty > 1 ? '−' : '×'),
                  h('span', { class: 'num' }, fmtNum(qty)),
                  h('button', { class: 'btn sm', onclick: add, 'aria-label': 'زيادة' }, '+')))));
    }) : emptyState('لا منتجات في هذا القسم بعد', 'cart'));
    paintBar();
  }
  paintChips(); paint();
  mount(out, h('div', { class: 'card', style: 'margin-bottom:1rem' }, chips,
    d.free_shipping_over ? h('p', { class: 'muted small', style: 'margin:.6rem 0 0' }, `الشحن مجاني للطلبات من ${d.free_shipping_over} فأكثر.`) : null),
  list, bar);
}

// ---------------------------------------------------------------- إتمام الطلب
function checkout(d, cart, byId, t) {
  const digitalOnly = !t.hasPhysical;
  const methods = [];
  if (t.total === 0) methods.push(['free', 'مجاني']);
  else {
    if (d.methods.cod && t.hasPhysical) methods.push(['cod', 'الدفع عند الاستلام']);
    if (d.methods.bank_transfer) methods.push(['bank_transfer', 'تحويل بنكي']);
  }
  if (!methods.length) { toast('لا توجد طريقة دفع متاحة حالياً، تواصل مع الإدارة', 'err'); return; }
  let method = methods[0][0];

  const name = h('input', { class: 'input', value: d.me.name, maxlength: 80 });
  const phone = h('input', { class: 'input', dir: 'ltr', value: d.me.phone, maxlength: 25 });
  const city = h('input', { class: 'input', maxlength: 60, placeholder: 'مثال: مسقط' });
  const address = h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'الولاية، الحي، وأي وصف يسهّل الوصول' });
  const note = h('textarea', { class: 'input', rows: 2, maxlength: 500, placeholder: 'ملاحظة للإدارة (اختياري)' });
  const payRef = h('input', { class: 'input', maxlength: 60, placeholder: 'رقم الحوالة (يمكن إضافته لاحقاً)' });
  const bankBox = h('div', { class: 'bankbox', hidden: true }, h('div', { class: 'muted small' }, 'حوّل المبلغ إلى:'), h('pre', { class: 'bank' }, d.bank_details || ''), h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'مرجع التحويل'), payRef));
  const shipBox = h('div', { hidden: digitalOnly }, h('div', { class: 'grid g2' },
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'اسم المستلم'), name),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'رقم الهاتف'), phone),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'المدينة'), city)),
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'العنوان'), address));

  const methodBox = h('div', { class: 'seg' });
  const paintMethods = () => { mount(methodBox, methods.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(method === v), onclick: () => { method = v; paintMethods(); } }, l))); bankBox.hidden = method !== 'bank_transfer'; };
  paintMethods();

  const lines = Object.entries(cart).map(([id, qty]) => { const p = byId.get(id); return h('div', { class: 'row between small' }, h('span', {}, `${p.title}${qty > 1 ? ` × ${fmtNum(qty)}` : ''}`), h('span', { class: 'num' }, p.price)); });
  const err = h('div', { class: 'err', hidden: true });
  const send = h('button', { class: 'btn primary', onclick: () => busy(send, async () => {
    err.hidden = true;
    const body = {
      items: Object.entries(cart).map(([id, qty]) => ({ product_id: Number(id), qty })),
      payment_method: method, note: note.value, payment_ref: method === 'bank_transfer' ? payRef.value : '',
      ship: digitalOnly ? null : { name: name.value, phone: phone.value, city: city.value, address: address.value },
    };
    try {
      const r = await post('/api/library/orders', body);
      for (const k of Object.keys(cart)) delete cart[k];
      writeCart(cart);
      m.close();
      toast(`تم إرسال طلبك رقم ${r.order.id}`, 'ok');
      go('#/library/orders');
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }) }, 'تأكيد الطلب');

  const m = modal('إتمام الطلب', h('div', { class: 'stack' },
    h('div', { class: 'card', style: 'background:var(--surface-2)' }, lines,
      h('hr', { class: 'hr', style: 'margin:.5rem 0' }),
      h('div', { class: 'row between' }, h('span', {}, 'الشحن'), h('span', {}, t.shipping ? d.shipping : (t.hasPhysical ? 'مجاني' : '—'))),
      h('div', { class: 'row between' }, h('strong', {}, 'الإجمالي'), h('strong', { class: 'price' }, `${fmtNum(Math.floor(t.total / 1000))}.${String(t.total % 1000).padStart(3, '0')} ${d.shipping.split(' ').pop()}`))),
    digitalOnly ? h('p', { class: 'muted small' }, 'منتجات رقمية: ستتمكن من تنزيلها من «طلباتي» بعد تأكيد الدفع.') : null,
    shipBox,
    t.total > 0 ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'طريقة الدفع'), methodBox) : null,
    bankBox,
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'ملاحظة'), note),
    d.contact_note ? h('p', { class: 'muted small' }, d.contact_note) : null,
    err, h('div', { class: 'mf' }, send)), { wide: true });
}

// ---------------------------------------------------------------- طلباتي
const ORDER_CLASS = { new: 's-open', paid: 's-on_time', processing: 's-open', shipped: 's-open', delivered: 's-on_time', cancelled: 's-missed' };

export async function renderMyOrders(root) {
  const out = h('div', { class: 'stack' });
  async function load() {
    mount(out, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
    try {
      const { orders } = await get('/api/library/orders');
      mount(out, orders.length ? orders.map((o) => h('article', { class: 'card stack' },
        h('div', { class: 'row between' },
          h('div', {}, h('strong', {}, `طلب رقم ${o.id}`), h('div', { class: 'muted small' }, fmtDateTime(o.created_at))),
          h('span', { class: `badge ${ORDER_CLASS[o.status]}` }, o.status_label)),
        h('div', { class: 'stack', style: 'gap:.3rem' }, o.items.map((it) => h('div', { class: 'row between small' },
          h('span', {}, `${it.title}${it.qty > 1 ? ` × ${fmtNum(it.qty)}` : ''} `, h('span', { class: 'kind' }, it.kind === 'digital' ? 'رقمي' : 'مادي')),
          h('span', { class: 'row', style: 'gap:.5rem' }, h('span', { class: 'num' }, it.line),
            it.downloadable ? h('a', { class: 'btn sm primary', href: `/api/library/orders/${o.id}/items/${it.id}/download` }, icon('download'), 'تنزيل') : null)))),
        h('div', { class: 'row between' }, h('span', { class: 'muted small' }, `${o.payment_label}${o.shipping_minor ? ` · الشحن ${o.shipping}` : ''}`), h('strong', { class: 'price' }, o.total)),
        o.ship ? h('div', { class: 'muted small' }, `التوصيل: ${o.ship.name} · ${o.ship.phone} · ${o.ship.city} — ${o.ship.address}`) : null,
        o.admin_note ? h('div', { class: 'decision late' }, h('strong', {}, 'من الإدارة: '), o.admin_note) : null,
        o.status === 'new' && o.payment_method === 'bank_transfer' && !o.payment_ref ? h('div', { class: 'dev-banner' }, 'بانتظار تحويل المبلغ. أضف رقم الحوالة ليتمكن الفريق من تأكيد طلبك.') : null,
        h('div', { class: 'row' },
          o.status === 'new' && o.payment_method === 'bank_transfer' ? h('button', { class: 'btn sm', onclick: () => refDialog(o, load) }, o.payment_ref ? 'تعديل رقم الحوالة' : 'إضافة رقم الحوالة') : null,
          o.status === 'new' ? h('button', { class: 'btn sm danger', onclick: async () => {
            if (!(await confirmDialog(`إلغاء الطلب رقم ${o.id}؟`, { danger: true, okText: 'إلغاء الطلب' }))) return;
            try { await post(`/api/library/orders/${o.id}/cancel`); toast('تم إلغاء الطلب', 'ok'); load(); } catch (e) { fail(e); }
          } }, 'إلغاء') : null))) : emptyState('لا توجد طلبات بعد', 'inbox'));
    } catch (e) { fail(e); mount(out, ''); }
  }
  function refDialog(o, done) {
    const ref = h('input', { class: 'input', value: o.payment_ref || '', maxlength: 60, placeholder: 'رقم الحوالة أو مرجع التحويل' });
    const err = h('div', { class: 'err', hidden: true });
    const ok = h('button', { class: 'btn primary', onclick: () => busy(ok, async () => {
      try { await post(`/api/library/orders/${o.id}/payment-ref`, { payment_ref: ref.value }); toast('تم إرسال بيانات التحويل للإدارة', 'ok'); m.close(); done(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'إرسال');
    const m = modal(`بيانات تحويل الطلب ${o.id}`, h('div', {}, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'مرجع التحويل'), ref), err, h('div', { class: 'mf' }, ok)));
  }
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'طلباتي'), h('div', { class: 'muted' }, 'طلبات المتجر وحالتها')),
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/library' }, icon('chevR'), 'المكتبة'), h('a', { class: 'btn', href: '#/library?tab=store' }, icon('cart'), 'المتجر'))), out);
  await load();
}
