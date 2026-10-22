import {
  h, mount, icon, get, post, put, patch, del, toast, fail, busy, modal, confirmDialog, emptyState, fmtDateTime, fmtNum, qs,
} from './core.js';
import { giftCard } from './gift.js';

/** قسم «المسجلون الجدد»: طلبات التسجيل وطلبات الإهداء (موسومة بعلامة «إهداء») في جدول واحد (للمدير) */
const REG_CLASS = { pending: 's-open', confirmed: 's-on_time', rejected: 's-missed', cancelled: 's-missed' };
const GIFT_CLASS = { pending: 's-open', sent: 's-on_time', received: 's-on_time', rejected: 's-missed', declined: 's-missed', transfer_requested: 's-open' };
const STATUS_FILTERS = [
  ['', 'كل الحالات'], ['pending', 'بانتظار المراجعة'], ['confirmed', 'تم التفعيل (تسجيل)'], ['sent', 'تم الإرسال (هدية)'],
  ['received', 'تم الاستلام (هدية)'], ['rejected', 'مرفوض'], ['declined', 'اعتذار (هدية)'], ['transfer_requested', 'طلب تحويل (هدية)'],
];
const REG_ONLY = ['confirmed']; const GIFT_ONLY = ['sent', 'received', 'declined', 'transfer_requested'];
const TYPES = [['', 'الكل'], ['reg', 'التسجيلات'], ['gift', 'الهدايا']];

export async function renderRegistrationsAdmin(root, query, refreshSummary) {
  const f = { course_id: '', status: query?.get('status') || 'pending', type: query?.get('type') || '' };
  const selected = new Set();
  const out = h('div', { class: 'stack' });
  const statsBox = h('div', { class: 'row', style: 'gap:.6rem;flex-wrap:wrap' });
  const courseSel = h('select', { class: 'input', 'aria-label': 'الدورة', onchange: (e) => { f.course_id = e.target.value; load(); } }, h('option', { value: '' }, 'كل الدورات'));
  const typeSel = h('select', { class: 'input', 'aria-label': 'النوع', onchange: (e) => { f.type = e.target.value; load(); } }, TYPES.map(([v, l]) => h('option', { value: v, selected: f.type === v }, l)));
  const statusSel = h('select', { class: 'input', 'aria-label': 'الحالة', onchange: (e) => { f.status = e.target.value; load(); } },
    STATUS_FILTERS.map(([v, l]) => h('option', { value: v, selected: f.status === v }, l)));
  const bulk = h('button', { class: 'btn primary', hidden: true, onclick: () => bulkConfirm() }, icon('check'), 'قبول المحدَّد');
  const settingsBox = h('details', { class: 'card' });
  let courseListFilled = false;
  const refresh = () => { load(); refreshSummary?.(); };

  // ---------------------------------------------------------------- مساعدات
  const ask = (title, label, placeholder, okText = 'تأكيد', danger = false) => new Promise((resolve) => {
    const box = h('textarea', { class: 'input', rows: 3, maxlength: 300, placeholder });
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(title, h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), box),
      h('div', { class: 'mf' }, h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { fin(box.value); m.close(); } }, okText), h('button', { class: 'btn', onclick: () => { fin(null); m.close(); } }, 'إلغاء'))), { onClose: () => fin(null) });
  });
  const receiptView = (title, url, mime, sub) => modal(title, h('div', { class: 'stack', style: 'align-items:center' },
    mime === 'application/pdf' ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, icon('file'), 'فتح ملف PDF')
      : h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: 'صورة الإيصال', style: 'max-width:100%;max-height:70vh;border-radius:12px;border:1px solid var(--line)' })),
    h('div', { class: 'muted small' }, sub)), { wide: true });
  const act = async (fn, okMsg) => { try { await fn(); toast(okMsg, 'ok'); selected.clear(); refresh(); } catch (e) { fail(e); } };

  // ---------------------------------------------------------------- تسجيلات الدورات
  async function review(x, to) {
    let reason = '';
    if (to === 'rejected') { reason = await ask(`رفض طلب ${x.name}`, 'سبب الرفض (يصل إلى المشترك)', 'مثل: الإيصال غير واضح، أو المبلغ ناقص', 'رفض', true); if (reason === null) return; }
    act(() => patch(`/api/admin/registrations/${x.id}`, { status: to, reason }), to === 'confirmed' ? 'قُبل الطلب وفُتحت المنصة للمشترك' : 'رُفض الطلب وأُرسل السبب للمشترك');
  }
  async function bulkConfirm() {
    if (!selected.size || !(await confirmDialog(`قبول ${fmtNum(selected.size)} طلب وفتح المنصة لأصحابها؟`, { okText: 'قبول' }))) return;
    act(() => post('/api/admin/registrations/bulk-confirm', { ids: [...selected] }), 'تم القبول');
  }
  async function removeReg(x) {
    const ok = await confirmDialog(
      `حذف «${x.name}» من المسجلين في «${x.course_title}» نهائياً؟ يُحذف الطلب وإيصاله ويعود المقعد إن كان محجوزاً، ويستطيع التسجيل من جديد. `
      + `لا يُحذف حسابه ولا يتغير وصوله إلى لوحة المتابعة${x.kind === 'gift' ? '، علماً أن هذا التسجيل ناتج عن هدية' : ''}.`,
      { okText: 'حذف', danger: true });
    if (ok) act(() => del(`/api/admin/registrations/${x.id}`), 'حُذف الاسم من المسجلين');
  }
  const toggleAccess = (x) => act(() => patch(`/api/admin/registrations/${x.id}/access`, { open: !x.access }), x.access ? 'قُفل وصوله إلى لوحة المتابعة' : 'فُتح وصوله إلى لوحة المتابعة');

  // ---------------------------------------------------------------- الهدايا
  async function giftReview(x, action) {
    let reason = '';
    if (action === 'reject') { reason = await ask('رفض الهدية', 'سبب الرفض (يصل إلى المُهدي بلطف)', 'مثل: الإيصال غير واضح، أو المبلغ ناقص', 'رفض', true); if (reason === null) return; }
    act(() => patch(`/api/admin/gifts/${x.id}`, { action, reason }), action === 'approve' ? 'قُبلت الهدية وأُرسلت البطاقة' : 'رُفضت الهدية وأُبلغ المُهدي');
  }
  function reassign(x) {
    const name = h('input', { class: 'input', maxlength: 80, value: x.transfer_name || '', placeholder: 'اسم المُهدى إليه الجديد' });
    const contact = h('input', { class: 'input ltr', dir: 'ltr', value: x.transfer_contact || '', placeholder: 'رقم واتساب (مع رمز الدولة إن لم يكن عُمانياً) أو بريد' });
    const m = modal('تحويل الهدية لشخص آخر', h('div', { class: 'stack' },
      h('p', { class: 'muted small', style: 'margin:0' }, 'يُنشأ رابط جديد، ويتوقف الرابط القديم.'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'الاسم'), name), h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'واتساب أو بريد'), contact),
      h('div', { class: 'mf' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await post(`/api/admin/gifts/${x.id}/reassign`, { name: name.value, contact: contact.value }); m.close(); toast('حُوّلت الهدية وأُرسلت البطاقة', 'ok'); refresh(); } catch (e) { fail(e); }
      } }, 'تحويل'), h('button', { class: 'btn', onclick: () => m.close() }, 'إلغاء'))));
  }
  function giftDetails(x) {
    const dl = (k, v) => h('div', { class: 'row between small' }, h('span', { class: 'muted' }, k), h('strong', {}, v || '—'));
    modal('تفاصيل الهدية', h('div', { class: 'stack' },
      dl('الدورة', x.course_title), dl('المُهدي', `${x.giver_name} — ${x.giver_phone}`), dl('المُهدى إليه', `${x.recipient_name} — ${x.recipient_contact}`),
      dl('الاسم على البطاقة', x.anonymous ? 'من محب' : x.giver_name), dl('الحالة', x.status_label),
      x.delivery ? dl('الإرسال', { whatsapp_sent: 'أُرسلت عبر واتساب', whatsapp_failed: 'تعذّر إرسال واتساب (انسخ الرابط وأرسله)', manual: 'يُشارَك الرابط يدوياً' }[x.delivery]) : null,
      h('div', {}, h('div', { class: 'muted small' }, 'رسالة المُهدي'), h('p', { style: 'white-space:pre-wrap;margin:.2rem 0' }, x.message)),
      x.link ? h('div', { class: 'row', style: 'gap:.4rem;flex-wrap:wrap' }, h('input', { class: 'input ltr', dir: 'ltr', readonly: true, value: x.link, onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(x.link); toast('نُسخ الرابط', 'ok'); } catch { /* */ } } }, 'نسخ')) : null), { wide: true });
  }
  async function giftAction(x, fn, msg) { act(fn, msg); }

  // ---------------------------------------------------------------- الجدول
  const stat = (label, n, cls = '') => h('div', { class: `card ${cls}`, style: 'flex:1 1 130px;text-align:center;padding:.7rem' }, h('div', { style: 'font-size:1.6rem;font-weight:700' }, fmtNum(n)), h('div', { class: 'muted small' }, label));
  const contactLink = (v, channel) => (channel === 'email' ? h('a', { href: `mailto:${v}` }, v) : h('a', { href: `https://wa.me/${String(v).replace(/\D/g, '')}`, target: '_blank', rel: 'noopener noreferrer' }, v));

  function regRow(x) {
    return h('tr', {},
      h('td', {}, x.status === 'pending' ? h('input', { type: 'checkbox', checked: selected.has(x.id), 'aria-label': `تحديد ${x.name}`, onchange: (e) => { e.target.checked ? selected.add(x.id) : selected.delete(x.id); bulk.hidden = !selected.size; } }) : null),
      h('td', { 'data-l': 'الاسم' }, x.name, x.kind === 'gift' ? h('div', { class: 'muted small' }, 'إهداء' + (x.gift_from ? ` من ${x.gift_from}` : '')) : null),
      h('td', { 'data-l': 'واتساب', class: 'ltr' }, contactLink(x.phone, 'whatsapp')),
      h('td', { 'data-l': 'الدورة' }, x.course_title),
      h('td', { 'data-l': 'التاريخ', class: 'nowrap small' }, fmtDateTime(x.created_at)),
      h('td', {}, h('span', { class: `badge ${REG_CLASS[x.status]}` }, x.status_label), x.reject_reason ? h('div', { class: 'muted small' }, x.reject_reason) : null,
        x.has_account ? h('div', { class: 'muted small' }, x.access ? 'المنصة مفتوحة' : 'المنصة مقفلة') : null),
      h('td', { 'data-l': 'الإيصال' }, x.has_receipt ? h('button', { class: 'btn sm', onclick: () => receiptView(`إيصال — ${x.name}`, `/api/admin/registrations/${x.id}/receipt`, x.receipt_mime, `${x.course_title} · ${fmtDateTime(x.created_at)}`) }, icon('eye'), 'عرض') : h('span', { class: 'muted small' }, '—')),
      h('td', {}, h('div', { class: 'row', style: 'gap:.3rem;flex-wrap:wrap' },
        x.status !== 'confirmed' ? h('button', { class: 'btn sm primary', onclick: () => review(x, 'confirmed') }, 'قبول وفتح المنصة') : null,
        x.status === 'pending' ? h('button', { class: 'btn sm danger', onclick: () => review(x, 'rejected') }, 'رفض') : null,
        x.has_account ? h('button', { class: 'btn sm', onclick: () => toggleAccess(x) }, x.access ? 'قفل الوصول' : 'فتح الوصول') : null,
        h('button', { class: 'btn sm danger', onclick: () => removeReg(x), 'aria-label': `حذف ${x.name} من المسجلين` }, icon('x'), 'حذف'))));
  }

  function giftRow(x) {
    return h('tr', {},
      h('td', {}),
      h('td', { 'data-l': 'الاسم' }, h('span', { class: 'badge s-on_time', style: 'margin-inline-end:.4rem' }, '🎁 إهداء'),
        h('div', { class: 'small' }, `من: ${x.giver_name}`), h('div', { class: 'small' }, `إلى: ${x.recipient_name}`)),
      h('td', { 'data-l': 'واتساب', class: 'ltr' }, contactLink(x.recipient_contact, x.recipient_channel)),
      h('td', { 'data-l': 'الدورة' }, x.course_title),
      h('td', { 'data-l': 'التاريخ', class: 'nowrap small' }, fmtDateTime(x.created_at)),
      h('td', {}, h('span', { class: `badge ${GIFT_CLASS[x.status]}` }, x.status_label), x.reject_reason ? h('div', { class: 'muted small' }, x.reject_reason) : null,
        x.status === 'transfer_requested' ? h('div', { class: 'muted small' }, `إلى: ${x.transfer_name}`) : null,
        x.delivery === 'whatsapp_failed' ? h('div', { class: 'err small' }, 'تعذّر إرسال واتساب') : null),
      h('td', { 'data-l': 'الإيصال' }, x.has_receipt ? h('button', { class: 'btn sm', onclick: () => receiptView(`إيصال هدية — ${x.giver_name}`, `/api/admin/gifts/${x.id}/receipt`, x.receipt_mime, `${x.course_title} · ${fmtDateTime(x.created_at)}`) }, icon('eye'), 'عرض') : h('span', { class: 'muted small' }, '—')),
      h('td', {}, h('div', { class: 'row', style: 'gap:.3rem;flex-wrap:wrap' },
        x.status === 'pending' ? [h('button', { class: 'btn sm primary', onclick: () => giftReview(x, 'approve') }, 'قبول وإرسال الهدية'), h('button', { class: 'btn sm danger', onclick: () => giftReview(x, 'reject') }, 'رفض')] : null,
        x.status === 'sent' ? [h('button', { class: 'btn sm', onclick: () => giftAction(x, () => post(`/api/admin/gifts/${x.id}/resend`), 'أُعيد إرسال البطاقة') }, 'إعادة الإرسال'), h('button', { class: 'btn sm', onclick: () => reassign(x) }, 'تحويل لشخص آخر')] : null,
        x.status === 'declined' ? h('button', { class: 'btn sm primary', onclick: () => reassign(x) }, 'تحويل لشخص آخر') : null,
        x.status === 'transfer_requested' ? [h('button', { class: 'btn sm primary', onclick: () => giftAction(x, () => patch(`/api/admin/gifts/${x.id}/transfer`, { approve: true }), 'حُوّلت الهدية') }, 'قبول التحويل'), h('button', { class: 'btn sm danger', onclick: () => giftAction(x, () => patch(`/api/admin/gifts/${x.id}/transfer`, { approve: false }), 'رُفض طلب التحويل') }, 'رفض التحويل')] : null,
        h('button', { class: 'btn sm', onclick: () => giftDetails(x) }, 'تفاصيل'))));
  }

  function paintSettings(s) {
    const msg = h('textarea', { class: 'input', rows: 3, maxlength: 400 }, s.message);
    const dua = h('textarea', { class: 'input', rows: 3, maxlength: 400 }, s.dua);
    const theme = h('select', { class: 'input', style: 'max-width:200px' }, [['green', 'أخضر هادئ'], ['peach', 'خوخي'], ['sand', 'رملي']].map(([v, l]) => h('option', { value: v, selected: s.theme === v }, l)));
    const prev = h('div', { style: 'max-width:380px' });
    const paintPrev = () => mount(prev, giftCard({ from: 'محب', to: 'اسم المُهدى إليه', message: msg.value, theme: theme.value, course: { title: 'اسم الدورة', start_date: '2027-01-10', end_date: '2027-01-20', time_label: 'كل ثلاثاء 8 مساءً', remote: true } }));
    msg.addEventListener('input', paintPrev); theme.addEventListener('change', paintPrev); paintPrev();
    mount(settingsBox, h('summary', { style: 'cursor:pointer;font-weight:700' }, 'إعدادات الإهداء'),
      h('div', { class: 'stack', style: 'margin-top:.8rem' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'نص الرسالة الافتراضية'), msg),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'نص الدعاء (صفحة الشكر وبطاقة الاستلام)'), dua),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'شكل بطاقة الإهداء'), theme), prev,
        h('div', {}, h('button', { class: 'btn primary', onclick: () => act(() => put('/api/admin/gift-settings', { message: msg.value, dua: dua.value, theme: theme.value }), 'تم حفظ إعدادات الإهداء') }, 'حفظ'))));
  }

  function paint(regs, gifts) {
    const rs = regs?.stats || { total: 0, pending: 0, confirmed: 0, rejected: 0 };
    const gs = gifts?.stats || { total: 0, pending: 0, sent: 0, received: 0, rejected: 0, declined: 0, transfer_requested: 0 };
    mount(statsBox, stat('الطلبات', rs.total + gs.total), stat('بانتظار المراجعة', rs.pending + gs.pending + gs.transfer_requested, 'attn'),
      stat('تم التفعيل / الإرسال', rs.confirmed + gs.sent + gs.received), stat('مرفوضة', rs.rejected + gs.rejected), stat('هدايا', gs.total));
    bulk.hidden = !selected.size;
    const rows = [
      ...(regs?.items || []).map((x) => ({ t: x.created_at, node: regRow(x), pending: x.status === 'pending', id: x.id })),
      ...(gifts?.items || []).map((x) => ({ t: x.created_at, node: giftRow(x) })),
    ].sort((a, b) => b.t - a.t);
    const all = h('input', { type: 'checkbox', 'aria-label': 'تحديد كل الطلبات المنتظرة', onchange: (e) => {
      (regs?.items || []).filter((x) => x.status === 'pending').forEach((x) => (e.target.checked ? selected.add(x.id) : selected.delete(x.id)));
      refresh_();
    } });
    const refresh_ = () => paint(regs, gifts);
    mount(out, rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't stackable' },
      h('thead', {}, h('tr', {}, h('th', {}, all), ['الاسم', 'واتساب / تواصل', 'الدورة', 'تاريخ الطلب', 'الحالة', 'الإيصال', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => r.node)))) : emptyState('لا طلبات بهذه المواصفات', 'inbox'));
  }

  async function load() {
    try {
      const wantRegs = f.type !== 'gift' && !GIFT_ONLY.includes(f.status);
      const wantGifts = f.type !== 'reg' && !REG_ONLY.includes(f.status);
      const regStatus = ['pending', 'confirmed', 'rejected'].includes(f.status) ? f.status : '';
      const giftStatus = ['pending', 'sent', 'received', 'rejected', 'declined', 'transfer_requested'].includes(f.status) ? f.status : '';
      const [regs, gifts, allRegs] = await Promise.all([
        wantRegs ? get('/api/admin/registrations-board' + qs({ course_id: f.course_id, status: regStatus })) : null,
        wantGifts ? get('/api/admin/gifts-board' + qs({ course_id: f.course_id, status: giftStatus })) : null,
        courseListFilled ? null : get('/api/admin/registrations-board'),
      ]);
      if (allRegs && !courseListFilled) { (allRegs.courses || []).forEach((c) => courseSel.append(h('option', { value: c.id }, c.title))); courseListFilled = true; }
      if (!settingsBox.firstChild) paintSettings((gifts || (await get('/api/admin/gifts-board'))).settings);
      paint(regs, gifts);
    } catch (e) { fail(e); }
  }

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'المسجلون الجدد'), h('p', { class: 'muted' }, 'راجع إيصالات التحويل لطلبات التسجيل والهدايا، واقبل الطلب ليُفتح للمشترك أو تُرسل البطاقة.'))),
    statsBox,
    h('div', { class: 'row', style: 'gap:.6rem;flex-wrap:wrap;margin:.8rem 0' }, typeSel, courseSel, statusSel, bulk),
    out, h('div', { style: 'margin-top:1rem' }, settingsBox));
  await load();
}
