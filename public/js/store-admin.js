import {
  h, mount, icon, get, post, put, patch, del, api, qs, toast, fail, busy, modal, confirmDialog, emptyState, fmtDateTime, fmtNum,
} from './core.js';

const TABS = [['files', 'ملفات التنزيل'], ['products', 'المنتجات'], ['orders', 'الطلبات'], ['settings', 'إعدادات المتجر'], ['stats', 'إحصاءات']];
const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
const ORDER_CLASS = { new: 's-open', paid: 's-on_time', processing: 's-open', shipped: 's-open', delivered: 's-on_time', cancelled: 's-missed' };
const STATUS_LABEL = { new: 'جديد', paid: 'مدفوع', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', cancelled: 'ملغى' };
const ACTION_LABEL = { paid: 'تأكيد الدفع', processing: 'بدء التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', cancelled: 'إلغاء' };
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(b / 1024))} ك.ب`);

/** تحويل الأرقام العربية/الفارسية إلى لاتينية وتنظيف الفواصل */
const normalizeDigits = (v) => String(v ?? '')
  .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[,٬\s]/g, '').replace(/[٫،]/g, '.').trim();

/** حقل مبلغ: يعرض بالريال ويرسل بالبيسة. نصّي ليقبل الأرقام العربية ويسهل تعديله. */
function moneyInput(minor = 0, currency = 'ر.ع') {
  const el = h('input', { class: 'input', type: 'text', inputmode: 'decimal', dir: 'ltr', value: (minor / 1000).toFixed(3), style: 'max-width:160px;text-align:center', onfocus: (e) => e.target.select() });
  el.dataset.currency = currency;
  return el;
}
/** يرجع المبلغ بالبيسة، أو null إن كان المدخل غير صالح */
function readMoney(el) {
  const v = normalizeDigits(el.value);
  if (!/^\d+(\.\d{1,3})?$/.test(v)) return null;
  return Math.round(Number(v) * 1000);
}
function numberInput(value, placeholder = '') {
  return h('input', { class: 'input', type: 'text', inputmode: 'numeric', dir: 'ltr', value: value ?? '', placeholder, style: 'max-width:120px;text-align:center', onfocus: (e) => e.target.select() });
}
/** عدد صحيح أو null للفارغ، و undefined إن كان غير صالح */
function readCount(el) {
  const v = normalizeDigits(el.value);
  if (v === '') return null;
  if (!/^\d+$/.test(v)) return undefined;
  return Number(v);
}

export async function renderStoreAdmin(root, query, onChange) {
  let tab = TABS.some(([k]) => k === query?.get('tab')) ? query.get('tab') : 'files';
  let counts = {};
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const out = h('div');
  const paintTabs = () => mount(tabs, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; paintTabs(); load(); } },
    l, k === 'orders' && counts.new ? h('span', { class: 'count-pill' }, fmtNum(counts.new)) : null)));

  async function load() {
    mount(out, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
    try {
      if (tab === 'files') await showFiles();
      else if (tab === 'products') await showProducts();
      else if (tab === 'orders') await showOrders();
      else if (tab === 'settings') await showSettings();
      else await showStats();
    } catch (e) { fail(e); mount(out, ''); }
    onChange?.();
  }

  // ---------------------------------------------------------------- ملفات التنزيل
  async function showFiles() {
    const d = await get('/api/library/admin/files');
    const cats = d.categories;
    mount(out,
      h('div', { class: 'row', style: 'margin-bottom:1rem' }, h('button', { class: 'btn primary', onclick: () => fileDialog(null, cats) }, icon('plus'), 'إضافة ملف')),
      d.files.length ? h('div', { class: 'stack' }, d.files.map((f) => h('div', { class: 'card adminrow' },
        f.has_cover ? h('img', { class: 'rowthumb', src: `/api/library/files/${f.id}/cover`, alt: '', loading: 'lazy' }) : h('div', { class: 'rowthumb placeholder' }, icon('file')),
        h('div', { class: 'grow' }, h('strong', {}, f.title),
          f.featured ? h('span', { class: 'badge', style: 'background:var(--accent-soft);color:var(--accent);margin-inline-start:.4rem' }, '★ مميّز') : null,
          h('div', { class: 'row muted small', style: 'gap:.6rem;margin-top:.2rem' },
            f.category ? h('span', { class: 'kind' }, f.category.name) : null,
            h('span', {}, f.file_name), h('span', {}, fmtSize(f.size)), f.meta_label ? h('span', {}, f.meta_label) : null, h('span', {}, `${fmtNum(f.downloads)} تنزيل`))),
        h('label', { class: 'check', title: 'إظهاره للأعضاء' }, h('input', { type: 'checkbox', checked: f.active, onchange: async (e) => {
          try { await patch(`/api/library/admin/files/${f.id}`, { active: e.target.checked }); toast(e.target.checked ? 'ظهر للأعضاء' : 'أُخفي', 'ok'); }
          catch (x) { e.target.checked = !e.target.checked; fail(x); }
        } }), 'ظاهر'),
        h('div', { class: 'row', style: 'gap:.35rem' },
          h('a', { class: 'btn sm', href: `/api/library/files/${f.id}/download`, title: 'تنزيل' }, icon('download')),
          h('button', { class: 'btn sm', onclick: () => fileDialog(f, cats) }, icon('edit'), 'تعديل'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!(await confirmDialog(`حذف «${f.title}» نهائياً؟ سيختفي من المكتبة.`, { danger: true, okText: 'حذف' }))) return;
            try { await del(`/api/library/admin/files/${f.id}`); toast('تم الحذف', 'ok'); load(); } catch (e) { fail(e); }
          } }, 'حذف')))) ) : emptyState('لا ملفات بعد — أضف أول ملف أذكار أو دعاء', 'book'),
      h('section', { class: 'card stack', style: 'margin-top:1.25rem' }, h('h3', {}, 'تصنيفات المكتبة'), catEditor(cats)));
  }

  function catEditor(cats) {
    const nw = h('input', { class: 'input', placeholder: 'اسم تصنيف جديد', maxlength: 40 });
    return h('div', { class: 'stack' },
      ...cats.map((c) => {
        const name = h('input', { class: 'input', value: c.name, maxlength: 40 });
        return h('div', { class: 'row' }, name,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.active, onchange: async (e) => { try { await patch(`/api/library/admin/categories/${c.id}`, { active: e.target.checked }); toast('تم', 'ok'); } catch (x) { e.target.checked = !e.target.checked; fail(x); } } }), 'ظاهر'),
          h('button', { class: 'btn sm', onclick: async () => { try { await patch(`/api/library/admin/categories/${c.id}`, { name: name.value }); toast('تم الحفظ', 'ok'); } catch (x) { fail(x); } } }, 'حفظ'),
          h('span', { class: 'muted small' }, `${fmtNum(c.files)} ملف`),
          h('button', { class: 'btn sm danger', onclick: async () => { try { await del(`/api/library/admin/categories/${c.id}`); load(); } catch (x) { fail(x); } } }, 'حذف'));
      }),
      h('div', { class: 'row' }, nw, h('button', { class: 'btn primary', onclick: async () => { try { await post('/api/library/admin/categories', { name: nw.value }); load(); } catch (x) { fail(x); } } }, icon('plus'), 'إضافة')));
  }

  function fileDialog(f, cats) {
    const title = h('input', { class: 'input', value: f?.title || '', maxlength: 120 });
    const desc = h('textarea', { class: 'input', rows: 2, maxlength: 1000 }, f?.description || '');
    const cat = h('select', { class: 'input' }, h('option', { value: '' }, 'بدون تصنيف'), cats.map((c) => h('option', { value: c.id, selected: f?.category?.id === c.id }, c.name)));
    const file = h('input', { class: 'input', type: 'file', accept: '.pdf,.mp3,.m4a,.wav,.zip,.docx,.txt,.jpg,.jpeg,.png,.webp' });
    const cover = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const meta = h('input', { class: 'input', value: f?.meta_label || '', maxlength: 40, placeholder: 'مثال: 32 صفحة أو 14 دقيقة' });
    const featured = h('input', { type: 'checkbox', checked: !!f?.featured });
    const active = h('input', { type: 'checkbox', checked: f ? f.active : true });
    const rmCover = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'err', hidden: true });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      const fd = new FormData();
      fd.append('title', title.value); fd.append('description', desc.value); fd.append('category_id', cat.value);
      fd.append('active', active.checked ? '1' : '0'); fd.append('featured', featured.checked ? '1' : '0'); fd.append('meta_label', meta.value);
      if (file.files[0]) fd.append('file', file.files[0]);
      if (cover.files[0]) fd.append('cover', cover.files[0]);
      if (rmCover.checked) fd.append('remove_cover', '1');
      if (!f && !file.files[0]) { err.textContent = 'أرفق الملف'; err.hidden = false; return; }
      try { await api(f ? 'PUT' : 'POST', f ? `/api/library/admin/files/${f.id}` : '/api/library/admin/files', fd); m.close(); toast('تم الحفظ', 'ok'); load(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const m = modal(f ? 'تعديل ملف' : 'إضافة ملف للتنزيل المجاني', h('div', {},
      field('العنوان', title), field('الوصف المختصر', desc, 'سطران يظهران في البطاقة.'), field('التصنيف', cat),
      field(f ? 'استبدال الملف (اختياري)' : 'الملف', file, 'المسموح: PDF، صوت (mp3/m4a/wav)، صور، docx، txt، zip — حتى 50 ميغابايت.'),
      field(f?.has_cover ? 'استبدال صورة الغلاف' : 'صورة الغلاف (اختيارية)', cover, 'تظهر في أعلى البطاقة؛ وبدونها تظهر أيقونة حسب نوع الملف.'),
      f?.has_cover ? h('label', { class: 'check' }, rmCover, 'إزالة الغلاف الحالي') : null,
      field('معلومة إضافية', meta, 'مثل عدد الصفحات أو مدة التسجيل.'),
      h('label', { class: 'check' }, featured, '★ تمييزه ضمن «الأكثر تحميلاً»'),
      h('label', { class: 'check' }, active, 'ظاهر للأعضاء'), err, h('div', { class: 'mf' }, save)), { wide: true });
  }

  // ---------------------------------------------------------------- المنتجات
  async function showProducts() {
    const [{ products }, { settings }] = await Promise.all([get('/api/library/admin/products'), get('/api/library/admin/settings')]);
    const digital = products.filter((p) => p.kind === 'digital');
    const physical = products.filter((p) => p.kind === 'physical');
    const section = (title, rows, kind) => h('section', { class: 'stack', style: 'margin-bottom:1.5rem' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, title),
        h('button', { class: 'btn sm primary', onclick: () => productDialog(null, kind, settings) }, icon('plus'), 'إضافة')),
      rows.length ? rows.map((p) => productRow(p, settings)) : h('p', { class: 'muted' }, 'لا منتجات في هذا القسم بعد'));
    mount(out,
      h('p', { class: 'muted small' }, 'عدّل السعر أو الكمية هنا مباشرة ثم اضغط «حفظ»، أو افتح «تعديل» لتغيير الاسم والوصف والصورة والملف.'),
      section('منتجات رقمية', digital, 'digital'), section('منتجات مادية', physical, 'physical'));
  }

  /** صف منتج فيه تحرير سريع للسعر والمخزون والإظهار */
  function productRow(p, settings) {
    const price = moneyInput(p.price_minor, settings.currency);
    const stock = numberInput(p.stock ?? '', 'غير محدودة');
    const save = h('button', { class: 'btn sm primary', hidden: true }, 'حفظ');
    const dirty = () => { save.hidden = readMoney(price) === p.price_minor && normalizeDigits(stock.value) === String(p.stock ?? ''); };
    price.addEventListener('input', dirty); stock.addEventListener('input', dirty);
    save.addEventListener('click', () => busy(save, async () => {
      const minor = readMoney(price);
      if (minor === null) { toast('اكتب السعر بالأرقام، مثل 2.500', 'err'); price.focus(); return; }
      const body = { price_minor: minor };
      if (p.kind === 'physical') {
        const st = readCount(stock);
        if (st === undefined) { toast('اكتب الكمية بالأرقام أو اتركها فارغة', 'err'); stock.focus(); return; }
        body.stock = st;
      }
      try { const r = await patch(`/api/library/admin/products/${p.id}`, body); Object.assign(p, r.product); toast('تم حفظ التغييرات', 'ok'); load(); }
      catch (e) { fail(e); }
    }));
    const toggle = h('input', { type: 'checkbox', checked: p.active, onchange: async (e) => {
      try { await patch(`/api/library/admin/products/${p.id}`, { active: e.target.checked }); toast(e.target.checked ? 'ظهر في المتجر' : 'أُخفي من المتجر', 'ok'); }
      catch (x) { e.target.checked = !e.target.checked; fail(x); }
    } });
    return h('div', { class: 'card adminrow' },
      p.has_image ? h('img', { class: 'rowthumb', src: `/api/library/products/${p.id}/image`, alt: '', loading: 'lazy' }) : h('div', { class: 'rowthumb placeholder' }, icon(p.kind === 'digital' ? 'file' : 'tag')),
      h('div', { class: 'grow' },
        h('strong', {}, p.title),
        !p.in_stock ? h('span', { class: 'badge s-missed', style: 'margin-inline-start:.4rem' }, 'نفدت') : null,
        p.kind === 'digital' && !p.has_file ? h('span', { class: 'badge s-missed', style: 'margin-inline-start:.4rem' }, '⚠ بلا ملف') : null,
        h('div', { class: 'muted small' }, p.kind === 'digital' ? (p.has_file ? `الملف: ${p.file_name}` : 'لم يُرفع ملف التسليم بعد') : 'منتج مادي يُشحن للعضو')),
      h('div', { class: 'rowfields' },
        h('label', { class: 'minifield' }, h('span', {}, `السعر (${settings.currency})`), price),
        p.kind === 'physical' ? h('label', { class: 'minifield' }, h('span', {}, 'الكمية'), stock) : null,
        h('label', { class: 'check', title: 'إظهاره في المكتبة' }, toggle, 'ظاهر')),
      h('div', { class: 'row', style: 'gap:.35rem' }, save,
        h('button', { class: 'btn sm', onclick: () => productDialog(p, p.kind, settings) }, icon('edit'), 'تعديل'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`حذف «${p.title}» نهائياً؟`, { danger: true, okText: 'حذف' }))) return;
          try { await del(`/api/library/admin/products/${p.id}`); toast('تم الحذف', 'ok'); load(); } catch (e) { fail(e); }
        } }, 'حذف')));
  }

  function productDialog(p, kind, settings) {
    const title = h('input', { class: 'input', value: p?.title || '', maxlength: 120 });
    const desc = h('textarea', { class: 'input', rows: 3, maxlength: 2000 }, p?.description || '');
    const price = moneyInput(p?.price_minor || 0, settings.currency);
    const stock = numberInput(p?.stock ?? '', 'اتركه فارغاً لكمية غير محدودة');
    const image = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp' });
    const file = h('input', { class: 'input', type: 'file', accept: '.pdf,.mp3,.m4a,.wav,.zip,.docx,.txt' });
    const sort = numberInput(p?.sort ?? 0);
    const active = h('input', { type: 'checkbox', checked: p ? p.active : true });
    const err = h('div', { class: 'err', hidden: true });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      const fd = new FormData();
      fd.append('kind', kind); fd.append('title', title.value); fd.append('description', desc.value);
      const minor = readMoney(price);
      if (minor === null) { err.textContent = 'اكتب السعر بالأرقام، مثل 2.500'; err.hidden = false; return; }
      fd.append('price_minor', String(minor)); fd.append('sort', String(readCount(sort) ?? 0)); fd.append('active', active.checked ? '1' : '0');
      if (kind === 'physical') {
        const st = readCount(stock);
        if (st === undefined) { err.textContent = 'اكتب الكمية بالأرقام أو اتركها فارغة'; err.hidden = false; return; }
        fd.append('stock', st === null ? '' : String(st));
      }
      if (image.files[0]) fd.append('image', image.files[0]);
      if (file.files[0]) fd.append('file', file.files[0]);
      try { await api(p ? 'PUT' : 'POST', p ? `/api/library/admin/products/${p.id}` : '/api/library/admin/products', fd); m.close(); toast('تم الحفظ', 'ok'); load(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const m = modal(p ? `تعديل ${p.title}` : (kind === 'digital' ? 'منتج رقمي جديد' : 'منتج مادي جديد'), h('div', {},
      field('اسم المنتج', title), field('الوصف', desc),
      h('div', { class: 'grid g2' }, field(`السعر (${settings.currency})`, price, '0 = مجاني'), kind === 'physical' ? field('الكمية المتوفرة', stock) : field('الترتيب', sort)),
      kind === 'physical' ? field('الترتيب', sort) : null,
      field('صورة المنتج (اختيارية)', image),
      kind === 'digital' ? field(p?.has_file ? `استبدال الملف (الحالي: ${p.file_name})` : 'ملف المنتج الرقمي', file, 'يُسلَّم للمشتري بعد تأكيد الدفع.') : null,
      h('label', { class: 'check' }, active, 'معروض في المتجر'), err, h('div', { class: 'mf' }, save)), { wide: true });
  }

  // ---------------------------------------------------------------- الطلبات
  async function showOrders() {
    let status = ''; let page = 1;
    const filter = h('div', { class: 'chips', style: 'margin-bottom:1rem' });
    const list = h('div', { class: 'stack' });
    async function draw() {
      const d = await get('/api/library/admin/orders' + qs({ status, page }));
      counts = d.counts; paintTabs();
      mount(filter, [['', 'الكل'], ...Object.entries(STATUS_LABEL)].map(([v, l]) =>
        h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(status === v), onclick: () => { status = v; page = 1; draw(); } },
          l, v && d.counts[v] ? ` (${fmtNum(d.counts[v])})` : '')));
      mount(list, d.orders.length ? d.orders.map(orderCard) : emptyState('لا طلبات', 'inbox'),
        d.pages > 1 ? h('div', { class: 'row between' },
          h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => { page--; draw(); } }, 'السابق'),
          h('span', { class: 'muted' }, `${fmtNum(page)} من ${fmtNum(d.pages)}`),
          h('button', { class: 'btn sm', disabled: page >= d.pages, onclick: () => { page++; draw(); } }, 'التالي')) : null);
    }
    function orderCard(o) {
      const act = (to) => async () => {
        let note = '';
        if (to === 'cancelled') {
          note = await askNote('سبب الإلغاء (يظهر للعضو)');
          if (note === null) return;
        } else if (!(await confirmDialog(`${ACTION_LABEL[to]} للطلب رقم ${o.id}؟`, { okText: ACTION_LABEL[to] }))) return;
        try { await post(`/api/library/admin/orders/${o.id}/status`, { status: to, admin_note: note }); toast('تم', 'ok'); draw(); } catch (e) { fail(e); }
      };
      return h('article', { class: 'card stack' },
        h('div', { class: 'row between' },
          h('div', {}, h('strong', {}, `طلب ${o.id}`), ' — ', o.user.name, ' ', h('span', { class: 'muted small ltr' }, o.user.phone),
            h('div', { class: 'muted small' }, `${fmtDateTime(o.created_at)} · ${o.payment_label}`)),
          h('span', { class: `badge ${ORDER_CLASS[o.status]}` }, o.status_label)),
        h('div', { class: 'stack', style: 'gap:.2rem' }, o.items.map((it) => h('div', { class: 'row between small' },
          h('span', {}, `${it.title}${it.qty > 1 ? ` × ${fmtNum(it.qty)}` : ''} `, h('span', { class: 'kind' }, it.kind === 'digital' ? 'رقمي' : 'مادي')), h('span', { class: 'num' }, it.line)))),
        h('div', { class: 'row between' }, h('span', { class: 'muted small' }, o.shipping_minor ? `الشحن ${o.shipping}` : 'بلا شحن'), h('strong', { class: 'price' }, o.total)),
        o.ship ? h('div', { class: 'muted small' }, `التوصيل: ${o.ship.name} · ${o.ship.phone} · ${o.ship.city} — ${o.ship.address}`) : null,
        o.payment_ref ? h('div', { class: 'muted small' }, `مرجع التحويل: ${o.payment_ref}`) : null,
        o.note ? h('div', { class: 'muted small' }, `ملاحظة العضو: ${o.note}`) : null,
        o.admin_note ? h('div', { class: 'decision late' }, h('strong', {}, 'ملاحظتك: '), o.admin_note) : null,
        o.next_states.length ? h('div', { class: 'row' }, o.next_states.map((s) => h('button', { class: 'btn sm ' + (s === 'cancelled' ? 'danger' : s === 'paid' ? 'primary' : ''), onclick: act(s) }, ACTION_LABEL[s]))) : null);
    }
    mount(out, filter, list);
    await draw();
  }

  function askNote(label) {
    return new Promise((resolve) => {
      let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const t = h('textarea', { class: 'input', rows: 2, maxlength: 300 });
      const ok = h('button', { class: 'btn danger', onclick: () => { finish(t.value.trim()); m.close(); } }, 'تأكيد');
      const m = modal(label, h('div', {}, field(label, t), h('div', { class: 'mf' }, ok)), { onClose: () => finish(null) });
    });
  }

  // ---------------------------------------------------------------- الإعدادات
  async function showSettings() {
    const { settings: s } = await get('/api/library/admin/settings');
    const enabled = h('input', { type: 'checkbox', checked: s.enabled });
    const currency = h('input', { class: 'input', value: s.currency, maxlength: 10, style: 'max-width:120px' });
    const shipping = moneyInput(s.shipping_minor, s.currency);
    const freeOver = moneyInput(s.free_shipping_over_minor, s.currency);
    const cod = h('input', { type: 'checkbox', checked: s.cod_enabled });
    const bank = h('input', { type: 'checkbox', checked: s.bank_transfer_enabled });
    const bankDetails = h('textarea', { class: 'input', rows: 5, maxlength: 1000 }, s.bank_details);
    const contact = h('textarea', { class: 'input', rows: 2, maxlength: 300 }, s.contact_note);
    const err = h('div', { class: 'err', hidden: true });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      try {
        const ship = readMoney(shipping); const over = readMoney(freeOver);
        if (ship === null || over === null) { err.textContent = 'اكتب المبالغ بالأرقام، مثل 1.000'; err.hidden = false; return; }
        await put('/api/library/admin/settings', {
          enabled: enabled.checked, currency: currency.value, shipping_minor: ship, free_shipping_over_minor: over,
          cod_enabled: cod.checked, bank_transfer_enabled: bank.checked, bank_details: bankDetails.value, contact_note: contact.value,
        });
        err.hidden = true; toast('تم حفظ الإعدادات', 'ok');
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ الإعدادات');
    mount(out,
      h('section', { class: 'card stack' }, h('h3', {}, 'عام'),
        h('label', { class: 'check' }, enabled, 'تشغيل المتجر (التنزيلات المجانية تبقى متاحة دائماً)'),
        h('div', { class: 'grid g3' }, field('رمز العملة', currency), field('أجرة الشحن', shipping, 'للطلبات المادية'), field('شحن مجاني ابتداءً من', freeOver, '0 = معطّل'))),
      h('section', { class: 'card stack' }, h('h3', {}, 'طرق الدفع'),
        h('p', { class: 'muted small' }, 'الدفع يدوي: يؤكده فريق المؤسسة بعد استلام المبلغ. لا تُحفظ بيانات بطاقات في المنصة.'),
        h('label', { class: 'check' }, cod, 'الدفع عند الاستلام (للمنتجات المادية)'),
        h('label', { class: 'check' }, bank, 'التحويل البنكي'),
        field('بيانات الحساب البنكي (تظهر للعضو عند الطلب)', bankDetails),
        field('ملاحظة التواصل', contact)),
      err, h('div', {}, save));
  }

  // ---------------------------------------------------------------- إحصاءات
  async function showStats() {
    const s = await get('/api/library/admin/stats');
    const kpi = (v, l, c = '') => h('div', { class: `card kpi ${c}` }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
    mount(out,
      h('div', { class: 'grid g4' }, kpi(s.revenue, 'إجمالي المبيعات المؤكدة', 'ok'), kpi(fmtNum(s.orders_new), 'طلبات جديدة', 'open'),
        kpi(fmtNum(s.orders_total), 'كل الطلبات'), kpi(fmtNum(s.downloads), 'مرات التنزيل')),
      h('div', { class: 'grid g2', style: 'margin-top:1rem' },
        h('div', { class: 'card' }, h('h3', {}, 'الأكثر تنزيلاً'), s.top_files.length ? h('ol', { style: 'padding-inline-start:1.2rem;margin:0' }, s.top_files.map((f) => h('li', {}, f.title, h('b', { class: 'num', style: 'margin-inline-start:.4rem' }, fmtNum(f.downloads))))) : h('p', { class: 'muted' }, 'لا تنزيلات بعد')),
        h('div', { class: 'card' }, h('h3', {}, 'الأكثر مبيعاً'), s.top_products.length ? h('ol', { style: 'padding-inline-start:1.2rem;margin:0' }, s.top_products.map((p) => h('li', {}, p.title, h('b', { class: 'num', style: 'margin-inline-start:.4rem' }, fmtNum(p.qty))))) : h('p', { class: 'muted' }, 'لا مبيعات بعد'))));
  }

  paintTabs();
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'المكتبة والمتجر'), h('div', { class: 'muted' }, 'ملفات التنزيل المجاني ومنتجات المؤسسة وطلبات الأعضاء'))), tabs, out);
  await load();
}
