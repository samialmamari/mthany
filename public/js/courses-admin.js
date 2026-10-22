import {
  h, mount, icon, get, post, put, patch, del, api, qs, toast, fail, busy, modal, confirmDialog, emptyState, fmtDateTime, fmtNum,
} from './core.js';

/** إدارة دورات الموقع العام: إضافة وتعديل ونسخ وأرشفة، والمسجّلون */
const KINDS = [['remote', 'دورات عن بُعد'], ['year_month', 'خطة العام'], ['membership', 'العضوية'], ['retreat', 'الخلوات']];
const STATUS_CLASS = { draft: 's-upcoming', open: 's-on_time', closed: 's-late', archived: 's-exempt' };
const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
const fmtDay = (d) => (d ? new Intl.DateTimeFormat('ar-OM-u-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${d}T00:00:00Z`)) : '—');
const digits = (v) => String(v ?? '').replace(/[٠-٩]/g, (x) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(x))).replace(/[,\s]/g, '');
const money = (minor) => `${fmtNum(Math.floor(minor / 1000))}.${String(minor % 1000).padStart(3, '0')}`;
const readMoney = (el) => { const v = digits(el.value); return /^\d+(\.\d{1,3})?$/.test(v) ? Math.round(Number(v) * 1000) : null; };

/** محرّر قائمة نصية: إضافة وحذف وترتيب يدوي */
function listEditor(items, placeholder) {
  const box = h('div', { class: 'stack', style: 'gap:.4rem' });
  const rows = [...(items || [])];
  function paint() {
    mount(box, ...rows.map((v, i) => {
      const inp = h('input', { class: 'input', value: v, maxlength: 160, placeholder });
      inp.addEventListener('input', () => { rows[i] = inp.value; });
      return h('div', { class: 'row', style: 'gap:.35rem' }, inp,
        h('button', { class: 'btn sm', type: 'button', title: 'لأعلى', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; paint(); } }, '↑'),
        h('button', { class: 'btn sm danger', type: 'button', title: 'حذف', onclick: () => { rows.splice(i, 1); paint(); } }, '×'));
    }), h('button', { class: 'btn sm', type: 'button', onclick: () => { rows.push(''); paint(); } }, icon('plus'), 'إضافة سطر'));
  }
  paint();
  return { el: box, value: () => rows.map((x) => x.trim()).filter(Boolean) };
}

function faqEditor(items) {
  const box = h('div', { class: 'stack', style: 'gap:.5rem' });
  const rows = [...(items || [])];
  function paint() {
    mount(box, ...rows.map((v, i) => {
      const q = h('input', { class: 'input', value: v.q || '', maxlength: 160, placeholder: 'السؤال' });
      const a = h('textarea', { class: 'input', rows: 2, maxlength: 600, placeholder: 'الجواب' }, v.a || '');
      q.addEventListener('input', () => { rows[i].q = q.value; });
      a.addEventListener('input', () => { rows[i].a = a.value; });
      return h('div', { class: 'card', style: 'padding:.6rem' }, q, h('div', { style: 'margin-top:.4rem' }, a),
        h('button', { class: 'btn sm danger', type: 'button', style: 'margin-top:.4rem', onclick: () => { rows.splice(i, 1); paint(); } }, 'حذف السؤال'));
    }), h('button', { class: 'btn sm', type: 'button', onclick: () => { rows.push({ q: '', a: '' }); paint(); } }, icon('plus'), 'إضافة سؤال'));
  }
  paint();
  return { el: box, value: () => rows.map((x) => ({ q: (x.q || '').trim(), a: (x.a || '').trim() })).filter((x) => x.q && x.a) };
}

/** محرّر الجدول: لكل محطة موعدها وعنوانها */
function scheduleEditor(items) {
  const box = h('div', { class: 'stack', style: 'gap:.4rem' });
  const rows = [...(items || [])];
  function paint() {
    mount(box, ...rows.map((v, i) => {
      const when = h('input', { class: 'input', value: v.when || '', maxlength: 80, placeholder: 'الموعد — مثل: الأربعاء ١٤ أكتوبر' });
      const what = h('input', { class: 'input', value: v.what || '', maxlength: 200, placeholder: 'عنوان المحطة' });
      when.addEventListener('input', () => { rows[i].when = when.value; });
      what.addEventListener('input', () => { rows[i].what = what.value; });
      return h('div', { class: 'row', style: 'gap:.35rem;align-items:flex-start' },
        h('div', { class: 'grow grid g2' }, when, what),
        h('button', { class: 'btn sm', type: 'button', title: 'لأعلى', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; paint(); } }, '↑'),
        h('button', { class: 'btn sm danger', type: 'button', title: 'حذف', onclick: () => { rows.splice(i, 1); paint(); } }, '×'));
    }), h('button', { class: 'btn sm', type: 'button', onclick: () => { rows.push({ when: '', what: '' }); paint(); } }, icon('plus'), 'إضافة محطة'));
  }
  paint();
  return { el: box, value: () => rows.map((x) => ({ when: (x.when || '').trim(), what: (x.what || '').trim() })).filter((x) => x.when || x.what) };
}

export async function renderCoursesAdmin(root, query) {
  let kind = KINDS.some(([k]) => k === query?.get('kind')) ? query.get('kind') : 'remote';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const out = h('div', { class: 'stack' });
  const paintTabs = () => mount(tabs, KINDS.map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(kind === k), onclick: () => { kind = k; paintTabs(); load(); } }, l)));

  async function load() {
    mount(out, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
    if (kind === 'year_month') return loadYear();
    try {
      const d = await get('/api/admin/courses' + qs({ kind }));
      const hide = h('input', { type: 'checkbox', checked: d.settings.hide_full_courses, onchange: async (e) => {
        try { await put('/api/admin/courses-settings', { hide_full_courses: e.target.checked }); toast('تم الحفظ', 'ok'); }
        catch (x) { e.target.checked = !e.target.checked; fail(x); }
      } });
      const payPhone = h('input', { class: 'input ltr', dir: 'ltr', maxlength: 30, value: d.settings.payment?.phone || '', placeholder: 'رقم الهاتف المستلم للتحويل' });
      const payHolder = h('input', { class: 'input', maxlength: 80, value: d.settings.payment?.holder || '', placeholder: 'اسم صاحب الرقم (اختياري)' });
      const waAll = h('input', { class: 'input', type: 'url', dir: 'ltr', maxlength: 300, value: d.settings.whatsapp_link || '', placeholder: 'https://chat.whatsapp.com/…' });
      const thanksAll = h('textarea', { class: 'input', rows: 3, maxlength: 500 }, d.settings.thanks_text || '');
      const retention = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', style: 'max-width:120px;text-align:center', value: d.settings.receipt_retention_days ?? 0 });
      const savePay = async () => {
        try {
          await put('/api/admin/courses-settings', { payment_phone: payPhone.value, payment_holder: payHolder.value, thanks_text: thanksAll.value, whatsapp_link: waAll.value, receipt_retention_days: Number(retention.value) || 0 });
          toast('تم حفظ الإعدادات', 'ok');
        } catch (x) { fail(x); }
      };
      mount(out,
        h('div', { class: 'card', style: 'margin-bottom:1rem' },
          h('h3', {}, 'إعدادات التسجيل والدفع (عامة)'),
          h('p', { class: 'muted small' }, 'تظهر للمشترك عند التسجيل في دورة مدفوعة، ثم يرفع إيصال التحويل. لكل دورة رقمها ونص شكرها الخاصان من نموذج الدورة.'),
          h('div', { class: 'row' }, payPhone, payHolder),
          field('رابط مجتمع واتساب العام', waAll, 'يظهر للمشترك بعد تسجيله إن لم يكن للدورة رابط خاص بها.'),
          field('نص الشكر والدعاء الافتراضي', thanksAll),
          field('حذف صور الإيصالات تلقائياً بعد (أيام) من التفعيل', retention, '0 = لا تُحذف.'),
          h('div', {}, h('button', { class: 'btn primary', onclick: savePay }, 'حفظ'))),
        h('div', { class: 'row between', style: 'margin-bottom:.8rem' },
          h('button', { class: 'btn primary', onclick: () => form(null) }, icon('plus'), 'دورة جديدة'),
          h('label', { class: 'check' }, hide, 'إخفاء الدورات المكتملة من الموقع (وإلا تظهر باهتة)')),
        d.courses.length ? d.courses.map((c) => card(c, d.statuses)) : emptyState('لا دورات في هذا القسم بعد', 'calendar'));
    } catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------- جدول خطة العام
  async function loadYear() {
    try {
      const d = await get('/api/admin/year-plan');
      const rows = d.courses.map((c) => yearRow(c, d.statuses));
      mount(out,
        h('div', { class: 'row', style: 'margin-bottom:.8rem' },
          h('button', { class: 'btn primary', onclick: () => form(null) }, icon('plus'), 'إضافة دورة'),
          h('button', { class: 'btn', onclick: extend }, icon('calendar'), 'تمديد الخطة'),
          h('span', { class: 'muted small', style: 'align-self:center' }, `${fmtNum(d.courses.length)} دورة · «القادمة» تتحدد تلقائياً بحسب التاريخ`)),
        d.courses.length ? h('div', { class: 'stack' }, rows) : emptyState('لا دورات في الخطة بعد', 'calendar'));
    } catch (e) { fail(e); }
  }

  /** صف قابل للتحرير مباشرة مع زر حفظ خاص به */
  function yearRow(c, statuses) {
    const no = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', value: c.course_no ?? '', style: 'max-width:70px;text-align:center', onfocus: (e) => e.target.select() });
    const title = h('input', { class: 'input', value: c.title, maxlength: 140 });
    const start = h('input', { class: 'input', type: 'date', value: c.start_date || '' });
    const end = h('input', { class: 'input', type: 'date', value: c.end_date || '' });
    const time = h('input', { class: 'input', value: c.time_label, maxlength: 80 });
    const price = h('input', { class: 'input', dir: 'ltr', inputmode: 'decimal', value: money(c.price_minor), style: 'max-width:110px;text-align:center', onfocus: (e) => e.target.select() });
    const seats = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', value: c.seats ?? '', placeholder: 'غير محدودة', style: 'max-width:100px;text-align:center', onfocus: (e) => e.target.select() });
    const status = h('select', { class: 'input', style: 'max-width:130px' }, Object.entries(statuses).map(([v, l]) => h('option', { value: v, selected: c.status === v }, l)));
    const msg = h('span', { class: 'muted small' });
    const save = h('button', { class: 'btn sm primary', onclick: () => busy(save, async () => {
      const minor = readMoney(price);
      if (minor === null) return toast('اكتب السعر بالأرقام، مثل 5.000', 'err');
      const st = digits(seats.value);
      if (st !== '' && !/^\d+$/.test(st)) return toast('اكتب المقاعد بالأرقام أو اتركها فارغة', 'err');
      try {
        const r = await patch(`/api/admin/year-plan/${c.id}`, {
          course_no: digits(no.value) || null, title: title.value, start_date: start.value || null, end_date: end.value || null,
          time_label: time.value, price_minor: minor, seats: st === '' ? null : Number(st), status: status.value,
        });
        toast(r.message, r.warn ? 'err' : 'ok');
        // عند تغيير موعد دورة لها مسجّلون نُبقي التنبيه ظاهراً بدل إعادة بناء الجدول
        if (r.warn) mount(msg, h('strong', { style: 'color:var(--accent)' }, `تنبيه: ${fmtNum(r.registrations)} مسجَّلاً في هذه الدورة — أبلغهم بالموعد الجديد`));
        else loadYear();
      } catch (e) { fail(e); }
    }) }, 'حفظ');

    return h('article', { class: 'card stack yearrow' },
      h('div', { class: 'row between' },
        h('div', {}, h('strong', {}, `الدورة ${c.ordinal || c.course_no || '—'}`),
          c.is_next ? h('span', { class: 'badge', style: 'background:var(--accent-soft);color:var(--accent);margin-inline-start:.4rem' }, '★ القادمة') : null,
          c.is_past ? h('span', { class: 'badge s-exempt', style: 'margin-inline-start:.4rem' }, 'انتهت') : null,
          h('div', { class: 'muted small' }, `${fmtNum(c.registrations)} مسجَّلاً · ${c.seats == null ? 'مقاعد غير محدودة' : `${fmtNum(c.seats_taken)} من ${fmtNum(c.seats)}`} · آخر تحديث ${fmtDateTime(c.updated_at)}`)),
        h('div', { class: 'row', style: 'gap:.3rem' },
          h('button', { class: 'btn sm', onclick: () => registrations(c) }, icon('users'), 'المسجّلون'),
          h('button', { class: 'btn sm', onclick: () => form(c) }, icon('edit'), 'تفاصيل'),
          h('button', { class: 'btn sm', onclick: async () => { try { const r = await post(`/api/admin/courses/${c.id}/duplicate`); toast(r.message, 'ok'); loadYear(); } catch (e) { fail(e); } } }, 'نسخ'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!(await confirmDialog(`حذف «${c.title}»؟`, { danger: true, okText: 'حذف' }))) return;
            try { const r = await del(`/api/admin/courses/${c.id}`); toast(r.message, 'ok'); loadYear(); } catch (e) { fail(e); }
          } }, 'حذف'))),
      h('div', { class: 'yeargrid' },
        h('label', { class: 'minifield' }, h('span', {}, 'الرقم'), no),
        h('label', { class: 'minifield grow' }, h('span', {}, 'الاسم'), title),
        h('label', { class: 'minifield' }, h('span', {}, 'البداية'), start),
        h('label', { class: 'minifield' }, h('span', {}, 'النهاية'), end),
        h('label', { class: 'minifield' }, h('span', {}, 'الوقت'), time),
        h('label', { class: 'minifield' }, h('span', {}, 'السعر'), price),
        h('label', { class: 'minifield' }, h('span', {}, 'المقاعد'), seats),
        h('label', { class: 'minifield' }, h('span', {}, 'الحالة'), status),
        h('div', { class: 'minifield' }, h('span', {}, ' '), save)),
      msg);
  }

  async function extend() {
    const count = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', value: '12', style: 'max-width:100px;text-align:center', onfocus: (e) => e.target.select() });
    const ok = h('button', { class: 'btn primary', onclick: () => busy(ok, async () => {
      try { const r = await post('/api/admin/year-plan/extend', { count: Number(digits(count.value)) || 12 }); m.close(); toast(r.message, 'ok'); loadYear(); }
      catch (e) { fail(e); }
    }) }, 'تمديد');
    const m = modal('تمديد الخطة', h('div', {},
      h('p', { class: 'muted' }, 'تُضاف الأشهر التالية تلقائياً بأرقام متسلسلة، بنفس الوقت والسعر والمقاعد، وتُحفظ كمسودات لتراجعها ثم تنشرها.'),
      field('عدد الدورات', count), h('div', { class: 'mf' }, ok)));
  }

  function card(c, statuses) {
    const status = h('select', { class: 'input', style: 'max-width:150px' },
      Object.entries(statuses).map(([v, l]) => h('option', { value: v, selected: c.status === v }, l)));
    status.addEventListener('change', async () => {
      try { await patch(`/api/admin/courses/${c.id}`, { status: status.value }); toast('تم تغيير الحالة', 'ok'); load(); }
      catch (e) { status.value = c.status; fail(e); }
    });
    return h('article', { class: 'card stack' },
      h('div', { class: 'row between' },
        h('div', { class: 'grow' },
          h('strong', {}, c.title), ' ', h('span', { class: `badge ${STATUS_CLASS[c.status]}` }, c.status_label),
          h('div', { class: 'muted small' }, [c.instructor, `${fmtDay(c.start_date)} ← ${fmtDay(c.end_date)}`, c.time_label, c.duration_label].filter(Boolean).join(' · ')),
          h('div', { class: 'muted small' }, `${money(c.price_minor)} · المقاعد ${c.seats == null ? 'غير محدودة' : `${fmtNum(c.seats_taken)} من ${fmtNum(c.seats)}`} · ${fmtNum(c.registrations)} مسجَّل · آخر تحديث ${fmtDateTime(c.updated_at)}`)),
        status),
      h('div', { class: 'row', style: 'gap:.35rem' },
        h('button', { class: 'btn sm', onclick: () => form(c) }, icon('edit'), 'تعديل'),
        h('button', { class: 'btn sm', onclick: () => preview(c.id) }, icon('eye'), 'معاينة'),
        h('button', { class: 'btn sm', onclick: () => registrations(c) }, icon('users'), `المسجّلون (${fmtNum(c.registrations)})`),
        h('button', { class: 'btn sm', onclick: async () => {
          try { const r = await post(`/api/admin/courses/${c.id}/duplicate`); toast(r.message, 'ok'); load(); } catch (e) { fail(e); }
        } }, 'نسخ'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`حذف «${c.title}» نهائياً؟ الأرشفة أأمن إن كان لها مسجَّلون.`, { danger: true, okText: 'حذف' }))) return;
          try { const r = await del(`/api/admin/courses/${c.id}`); toast(r.message, 'ok'); load(); } catch (e) { fail(e); }
        } }, 'حذف')));
  }

  // ---------------------------------------------------------------- نموذج الدورة
  async function form(c) {
    const cur = c ? (await get(`/api/admin/courses/${c.id}`)).course : null;
    const v = (k, dflt = '') => (cur ? cur[k] ?? dflt : dflt);
    const title = h('input', { class: 'input', value: v('title'), maxlength: 140 });
    const instructor = h('input', { class: 'input', value: v('instructor'), maxlength: 80, placeholder: 'اسم المحاضر' });
    const summary = h('textarea', { class: 'input', rows: 2, maxlength: 300 }, v('summary'));
    const description = h('textarea', { class: 'input', rows: 5, maxlength: 4000 }, v('description'));
    const goals = listEditor(v('goals', []), 'هدف');
    const topics = listEditor(v('topics', []), 'محور');
    const faq = faqEditor(v('faq', []));
    const schedule = scheduleEditor(v('schedule', []));
    const start = h('input', { class: 'input', type: 'date', value: v('start_date') || '' });
    const end = h('input', { class: 'input', type: 'date', value: v('end_date') || '' });
    const time = h('input', { class: 'input', value: v('time_label'), maxlength: 80, placeholder: 'كل ثلاثاء، 8:00 مساءً' });
    const duration = h('input', { class: 'input', value: v('duration_label'), maxlength: 80, placeholder: '٦ لقاءات · ساعة لكل لقاء' });
    const place = h('input', { class: 'input', value: v('place'), maxlength: 120, placeholder: 'للخلوات الحضورية' });
    const price = h('input', { class: 'input', dir: 'ltr', inputmode: 'decimal', value: money(v('price_minor', 0)), style: 'max-width:160px;text-align:center', onfocus: (e) => e.target.select() });
    const seats = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', value: cur?.seats ?? '', placeholder: 'غير محدودة', style: 'max-width:140px;text-align:center', onfocus: (e) => e.target.select() });
    const month = h('select', { class: 'input' }, ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
      .map((m, i) => h('option', { value: i + 1, selected: Number(v('month', 0)) === i + 1 }, m)));
    const attend = h('input', { class: 'input', type: 'url', dir: 'ltr', value: v('attend_link'), maxlength: 500, placeholder: 'https://meet.google.com/…' });
    const attendNote = h('textarea', { class: 'input', rows: 2, maxlength: 500 }, v('attend_note'));
    const status = h('select', { class: 'input' }, [['draft', 'مسودة'], ['open', 'منشورة'], ['closed', 'مكتملة'], ['archived', 'مؤرشفة']]
      .map(([k, l]) => h('option', { value: k, selected: (cur?.status || 'draft') === k }, l)));
    const sort = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', value: v('sort', 0), style: 'max-width:120px;text-align:center', onfocus: (e) => e.target.select() });
    const image = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const payPhone = h('input', { class: 'input ltr', dir: 'ltr', value: v('pay_phone'), maxlength: 30, placeholder: 'اتركه فارغاً لاستخدام الرقم العام' });
    const waLink = h('input', { class: 'input', type: 'url', dir: 'ltr', value: v('whatsapp_link'), maxlength: 300, placeholder: 'https://chat.whatsapp.com/…' });
    const thanks = h('textarea', { class: 'input', rows: 3, maxlength: 500, placeholder: 'اتركه فارغاً لاستخدام النص العام' }, v('thanks_text'));
    const err = h('div', { class: 'err', hidden: true });

    const body = () => {
      const minor = readMoney(price);
      if (minor === null) throw new Error('اكتب السعر بالأرقام، مثل 15.000');
      const s = digits(seats.value);
      if (s !== '' && !/^\d+$/.test(s)) throw new Error('اكتب عدد المقاعد بالأرقام أو اتركه فارغاً');
      const fd = new FormData();
      const vals = {
        kind, title: title.value, instructor: instructor.value, summary: summary.value, description: description.value,
        start_date: start.value, end_date: end.value, time_label: time.value, duration_label: duration.value, place: place.value,
        price_minor: minor, seats: s, status: status.value, sort: digits(sort.value) || '0',
        attend_link: attend.value, attend_note: attendNote.value, pay_phone: payPhone.value, whatsapp_link: waLink.value, thanks_text: thanks.value, month: kind === 'year_month' ? month.value : '',
        goals: JSON.stringify(goals.value()), topics: JSON.stringify(topics.value()), faq: JSON.stringify(faq.value()), schedule: JSON.stringify(schedule.value()),
      };
      for (const [k, val] of Object.entries(vals)) fd.append(k, String(val));
      if (image.files[0]) fd.append('image', image.files[0]);
      return fd;
    };
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      err.hidden = true;
      try {
        const r = await api(cur ? 'PUT' : 'POST', cur ? `/api/admin/courses/${cur.id}` : '/api/admin/courses', body());
        m.close(); toast(r.message || 'تم الحفظ', 'ok'); load();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const prev = h('button', { class: 'btn', onclick: () => previewData({
      title: title.value, summary: summary.value, description: description.value, instructor: instructor.value,
      goals: goals.value(), topics: topics.value(), faq: faq.value(), schedule: schedule.value(), time_label: time.value, duration_label: duration.value,
      start_date: start.value, end_date: end.value, price_minor: readMoney(price) ?? 0, seats: digits(seats.value), attend_note: attendNote.value,
    }) }, icon('eye'), 'معاينة');

    const m = modal(cur ? `تعديل: ${cur.title}` : 'دورة جديدة', h('div', { class: 'stack' },
      h('section', { class: 'card stack' }, h('h3', {}, 'الأساسيات'),
        field('عنوان الدورة', title), field('المحاضر', instructor),
        field('الوصف المختصر', summary, 'سطران يظهران في البطاقة.'),
        field('الوصف الكامل', description)),
      h('section', { class: 'card stack' }, h('h3', {}, 'الموعد والمقاعد'),
        kind === 'year_month' ? field('شهر المحطة', month) : null,
        h('div', { class: 'grid g2' }, field('تاريخ البداية', start), field('تاريخ النهاية', end)),
        h('div', { class: 'grid g2' }, field('الوقت', time), field('المدة', duration)),
        kind === 'retreat' ? field('المكان', place) : null,
        h('div', { class: 'grid g3' }, field('السعر (ر.ع)', price, '0 = مجانية'), field('عدد المقاعد', seats, 'فارغ = غير محدودة'), field('الترتيب', sort))),
      h('section', { class: 'card stack' }, h('h3', {}, 'الأهداف'), goals.el),
      h('section', { class: 'card stack' }, h('h3', {}, 'المحاور'), topics.el),
      h('section', { class: 'card stack' }, h('h3', {}, 'الجدول والمحطات'), schedule.el),
      h('section', { class: 'card stack' }, h('h3', {}, 'الأسئلة الشائعة'), faq.el),
      h('section', { class: 'card stack' }, h('h3', {}, 'التسجيل والدفع'),
        field('رقم التحويل لهذه الدورة', payPhone, 'يظهر للمشترك مع زر النسخ.'),
        field('رابط مجتمع واتساب للدورة', waLink, 'يظهر للمشترك بعد تسجيله فقط، ولا يظهر للزائر.'),
        field('نص الشكر والدعاء', thanks, 'يظهر في صفحة الشكر بعد التسجيل.')),
      h('section', { class: 'card stack' }, h('h3', {}, 'الحضور والنشر'),
        field('رابط الحضور', attend, 'لا يظهر للزائر، ويُستخدم لاحقاً في إرساله للمسجّلين.'),
        field('طريقة الحضور (تظهر للزائر)', attendNote),
        field('صورة الدورة', image),
        field('الحالة', status, 'المسودة لا تظهر في الموقع.')),
      err, h('div', { class: 'mf' }, save, prev)), { wide: true });
  }

  // ---------------------------------------------------------------- المعاينة
  async function preview(id) {
    try { previewData((await get(`/api/admin/courses/${id}`)).course); } catch (e) { fail(e); }
  }
  function previewData(c) {
    const facts = [
      c.instructor && ['المحاضر', c.instructor],
      c.start_date && ['التاريخ', `${fmtDay(c.start_date)} ← ${fmtDay(c.end_date)}`],
      c.time_label && ['الوقت', c.time_label],
      c.duration_label && ['المدة', c.duration_label],
      ['السعر', c.price_minor ? `${money(c.price_minor)} ر.ع` : 'مجاناً'],
      ['المقاعد', c.seats === '' || c.seats == null ? 'غير محدودة' : fmtNum(c.seats)],
    ].filter(Boolean);
    modal('معاينة كما يراها الزائر', h('div', { class: 'preview-box' },
      h('h2', { style: 'margin-top:0' }, c.title || '(بلا عنوان)'),
      c.summary ? h('p', { class: 'muted' }, c.summary) : null,
      h('div', { class: 'stack', style: 'gap:.3rem;margin-bottom:1rem' }, facts.map(([k, v2]) => h('div', { class: 'row between small' }, h('span', { class: 'muted' }, k), h('strong', {}, v2)))),
      c.description ? h('div', {}, h('h3', {}, 'عن الدورة'), h('p', { style: 'white-space:pre-wrap' }, c.description)) : null,
      c.goals?.length ? h('div', {}, h('h3', {}, 'الأهداف'), h('ul', {}, c.goals.map((g) => h('li', {}, g)))) : null,
      c.topics?.length ? h('div', {}, h('h3', {}, 'المحاور'), h('ol', {}, c.topics.map((t) => h('li', {}, t)))) : null,
      c.schedule?.length ? h('div', {}, h('h3', {}, 'الجدول والمحطات'), h('ul', {}, c.schedule.map((x) => h('li', {}, h('strong', {}, x.when), x.when && x.what ? ' — ' : '', x.what)))) : null,
      c.attend_note ? h('div', {}, h('h3', {}, 'طريقة الحضور'), h('p', {}, c.attend_note)) : null,
      c.faq?.length ? h('div', {}, h('h3', {}, 'الأسئلة الشائعة'), c.faq.map((f) => h('details', { class: 'small' }, h('summary', {}, f.q), h('p', { class: 'muted' }, f.a)))) : null), { wide: true });
  }

  // ---------------------------------------------------------------- المسجّلون
  async function registrations(c) {
    let d;
    try { d = await get(`/api/admin/courses/${c.id}/registrations`); } catch (e) { fail(e); return; }
    const box = h('div');
    const paint = (rows) => mount(box, rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't stackable' },
      h('thead', {}, h('tr', {}, ['الاسم', 'الهاتف', 'النوع', 'الحالة', 'التاريخ', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((x) => h('tr', {},
        h('td', { 'data-l': 'الاسم' }, x.name, x.gift_from ? h('div', { class: 'muted small' }, `إهداء من: ${x.gift_from}`) : null),
        h('td', { 'data-l': 'الهاتف', class: 'ltr' }, x.phone),
        h('td', { 'data-l': 'النوع' }, x.kind_label, x.has_receipt ? h('div', {}, h('a', { class: 'small', href: `/api/admin/registrations/${x.id}/receipt`, target: '_blank', rel: 'noopener' }, 'عرض الإيصال')) : null),
        h('td', {}, h('span', { class: `badge ${x.status === 'confirmed' ? 's-on_time' : x.status === 'cancelled' ? 's-missed' : 's-open'}` }, x.status_label)),
        h('td', { 'data-l': 'التاريخ', class: 'nowrap small' }, fmtDateTime(x.created_at)),
        h('td', {}, h('div', { class: 'row', style: 'gap:.3rem' },
          x.status !== 'confirmed' ? h('button', { class: 'btn sm primary', onclick: () => setStatus(x, 'confirmed') }, 'تأكيد') : null,
          x.status !== 'cancelled' ? h('button', { class: 'btn sm danger', onclick: () => setStatus(x, 'cancelled') }, 'إلغاء') : null)))))))
      : emptyState('لا مسجّلين بعد', 'users'));
    async function setStatus(x, to) {
      try {
        await patch(`/api/admin/registrations/${x.id}`, { status: to });
        toast(to === 'confirmed' ? 'تم تأكيد التسجيل' : 'أُلغي التسجيل وأُعيد المقعد', 'ok');
        const fresh = await get(`/api/admin/courses/${c.id}/registrations`);
        paint(fresh.registrations); load();
      } catch (e) { fail(e); }
    }
    paint(d.registrations);
    modal(`المسجّلون — ${c.title}`, h('div', { class: 'stack' },
      h('div', { class: 'row between' },
        h('span', { class: 'muted small' }, `${fmtNum(d.registrations.length)} تسجيل · المقاعد ${d.course.seats == null ? 'غير محدودة' : `${fmtNum(d.course.seats_taken)} من ${fmtNum(d.course.seats)}`}`),
        h('a', { class: 'btn sm', href: `/api/admin/courses/${c.id}/registrations.csv` }, icon('download'), 'تصدير CSV')),
      box), { wide: true });
  }

  paintTabs();
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'الدورات'),
    h('div', { class: 'muted' }, 'كل ما يظهر في الموقع العام يُدار من هنا — والتعديل يظهر مباشرة للزائر'))), tabs, out);
  await load();
}
