import {
  h, mount, icon, get, post, put, patch, del, toast, fail, busy, modal, confirmDialog, qs, state, api,
  fmtNum, fmtDayShort, todayStr, emptyState, WEEKDAYS, ROLE_LABEL,
} from './core.js';

const go = (hash) => { location.hash = hash; };
const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
const to12 = (t) => { const [hh, mm] = t.split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'ص' : 'م'}`; };

export function scheduleLabel(t) {
  const days = t.days_of_week ? t.days_of_week.map((d) => WEEKDAYS[d]).join('، ') : 'كل يوم';
  const whole = t.start_time === '00:00' && t.deadline_time === '23:59';
  return `${days}${whole ? '' : ` · من ${to12(t.start_time)} حتى ${to12(t.deadline_time)}`}`;
}

// ====================================================== الأذكار والأوراد
export async function renderTasks(root) {
  const isAdmin = state.user.role === 'admin';
  let status = 'all';
  const list = h('div', { class: 'stack' });
  const statusSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'الحالة' });

  function paintSeg() {
    mount(statusSeg, [['all', 'النشطة والموقوفة'], ['active', 'نشطة'], ['paused', 'موقوفة'], ['archived', 'المؤرشفة']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(status === v), onclick: () => { status = v; paintSeg(); load(); } }, l)));
  }
  async function act(t, action, msg) {
    if (msg && !(await confirmDialog(msg, { danger: action === 'archive' }))) return;
    try { await post(`/api/admin/tasks/${t.id}/${action}`); toast('تم', 'ok'); load(); } catch (e) { fail(e); }
  }
  async function load() {
    try {
      const { tasks } = await get('/api/admin/tasks' + qs({ status }));
      mount(list, tasks.length ? tasks.map((t) => h('article', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', { class: 'grow' }, h('strong', {}, t.title),
            t.status !== 'active' ? h('span', { class: 'badge s-upcoming', style: 'margin-inline-start:.4rem' }, t.status === 'paused' ? 'موقوف' : 'مؤرشف') : null,
            h('div', { class: 'muted small' }, t.target_count === 1 ? 'بزر إتمام ✓' : t.target_count ? `الهدف اليومي: ${fmtNum(t.target_count)} ${t.count_unit}` : `يُسجَّل بعدد ${t.count_unit}`, ' · ', scheduleLabel(t)),
            h('div', { class: 'muted small' }, 'المسند إلى: ', t.assign_label || '—'), t.description ? h('div', { class: 'muted small' }, t.description) : null),
          isAdmin ? h('div', { class: 'row', style: 'gap:.35rem' },
            h('a', { class: 'btn sm', href: `#/tasks/${t.id}` }, icon('edit'), 'تعديل'),
            t.status === 'active' ? h('button', { class: 'btn sm', onclick: () => act(t, 'pause', 'إيقاف الورد مؤقتاً؟ لن تُحتسب الأيام التي تمر أثناء الإيقاف.') }, 'إيقاف') : null,
            t.status === 'paused' ? h('button', { class: 'btn sm', onclick: () => act(t, 'resume') }, 'استئناف') : null,
            t.status === 'archived' ? h('button', { class: 'btn sm', onclick: () => act(t, 'unarchive') }, 'استعادة') : null,
            t.status !== 'archived' ? h('button', { class: 'btn sm danger', onclick: () => act(t, 'archive', 'أرشفة الورد؟ تبقى تسجيلاته في التقارير ولا يظهر للأعضاء بعد اليوم.') }, 'أرشفة') : null) : null))) : emptyState('لا توجد أوراد', 'tasks'));
    } catch (e) { fail(e); }
  }
  paintSeg();
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'الأذكار والأوراد'), h('div', { class: 'muted' }, 'ما يُسجّله الأعضاء يومياً بعدد، ولكل ورد هدف اختياري')),
    isAdmin ? h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/tasks/new' }, icon('plus'), 'ورد جديد')) : null),
  h('div', { class: 'row', style: 'margin-bottom:1rem' }, statusSeg), list);
  await load();
}

// ====================================================== نموذج الورد
export async function renderTaskForm(root, id) {
  const [{ users }, { groups }] = await Promise.all([get('/api/admin/users?active=1'), get('/api/admin/groups')]);
  let t = { title: '', description: '', count_unit: 'مرة', target_count: null, days_of_week: null, start_time: '00:00', deadline_time: '23:59', grace_minutes: 0, start_date: todayStr(), end_date: null, remind_before_min: null, assign: { all: true, group_ids: [], user_ids: [] } };
  if (id) t = { ...t, ...(await get(`/api/admin/tasks/${id}`)).task };
  const editing = !!id;

  const title = h('input', { class: 'input', value: t.title, maxlength: 120, placeholder: 'مثال: الاستغفار' });
  const desc = h('textarea', { class: 'input', rows: 2, placeholder: 'وصف أو فضل مختصر (اختياري)' }, t.description);
  const unit = h('input', { class: 'input', value: t.count_unit || 'مرة', maxlength: 20, list: 'unitlist' });
  const units = h('datalist', { id: 'unitlist' }, ['مرة', 'صفحة', 'دقيقة', 'جزء', 'آية', 'ركعة'].map((u) => h('option', { value: u })));
  const target = h('input', { class: 'input', type: 'number', min: 1, value: t.target_count ?? '', placeholder: 'اختياري' });
  const dow = new Set(t.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]);
  const days = h('div', { class: 'chips' }, WEEKDAYS.map((n, i) => h('label', { class: 'chip-check' }, h('input', { type: 'checkbox', checked: dow.has(i), onchange: (e) => { e.target.checked ? dow.add(i) : dow.delete(i); } }), h('span', {}, n))));
  const start = h('input', { class: 'input', type: 'time', value: t.start_time });
  const dead = h('input', { class: 'input', type: 'time', value: t.deadline_time });
  const grace = h('input', { class: 'input', type: 'number', min: 0, max: 1440, value: t.grace_minutes });
  const startDate = h('input', { class: 'input', type: 'date', value: t.start_date });
  const endDate = h('input', { class: 'input', type: 'date', value: t.end_date || '' });
  const order = h('input', { class: 'input', type: 'text', inputmode: 'numeric', dir: 'ltr', value: t.sort ?? 0, style: 'max-width:120px;text-align:center' });
  const link = h('input', { class: 'input', type: 'url', dir: 'ltr', value: t.link_url || '', placeholder: 'https://…', maxlength: 500 });
  const readText = h('textarea', { class: 'input', rows: 6, maxlength: 20000, placeholder: 'مثل برنامج الرقية الشرعية أو نص الذكر…' }, t.read_text || '');
  const remind = h('select', { class: 'input' }, [['', 'بدون'], [60, 'قبل نهاية الوقت بساعة'], [120, 'قبل نهاية الوقت بساعتين'], [180, 'قبل نهاية الوقت بـ 3 ساعات']].map(([v, l]) => h('option', { value: v, selected: String(t.remind_before_min || '') === String(v) }, l)));

  // الإسناد
  const asg = { all: !!t.assign.all, groups: new Set(t.assign.group_ids), users: new Set(t.assign.user_ids) };
  const asgBox = h('div');
  const uSearch = h('input', { class: 'input', type: 'search', placeholder: 'بحث عن عضو…' });
  const uList = h('div', { class: 'picker' });
  function paintUsers() {
    const q = uSearch.value.trim();
    mount(uList, users.filter((u) => !q || u.name.includes(q) || u.phone.includes(q)).map((u) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: asg.users.has(u.id), onchange: (e) => { e.target.checked ? asg.users.add(u.id) : asg.users.delete(u.id); } }), u.name, h('span', { class: 'muted small ltr' }, u.phone))));
  }
  uSearch.addEventListener('input', paintUsers);
  function paintAsg() {
    mount(asgBox, h('div', { class: 'seg', style: 'margin-bottom:.8rem' },
      h('button', { type: 'button', 'aria-pressed': String(asg.all), onclick: () => { asg.all = true; paintAsg(); } }, 'جميع الأعضاء'),
      h('button', { type: 'button', 'aria-pressed': String(!asg.all), onclick: () => { asg.all = false; paintAsg(); } }, 'حلقات / أعضاء محددون')),
    asg.all ? h('p', { class: 'muted small' }, 'يُسند الورد لكل الأعضاء الفعّالين، ويشمل من ينضم لاحقاً.') : h('div', { class: 'stack' },
      groups.length ? h('div', {}, h('div', { style: 'font-weight:500;margin-bottom:.3rem' }, 'الحلقات'), h('div', { class: 'chips' }, groups.map((g) => h('label', { class: 'chip-check' },
        h('input', { type: 'checkbox', checked: asg.groups.has(g.id), onchange: (e) => { e.target.checked ? asg.groups.add(g.id) : asg.groups.delete(g.id); } }), h('span', {}, `${g.name} (${fmtNum(g.members)})`))))) : null,
      h('div', {}, h('div', { style: 'font-weight:500;margin-bottom:.3rem' }, 'أعضاء'), uSearch, h('div', { style: 'margin-top:.4rem' }, uList))));
    if (!asg.all) paintUsers();
  }
  paintAsg();

  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'حفظ التعديلات' : 'إضافة الورد');
  const form = h('form', {
    novalidate: true,
    onsubmit: (e) => {
      e.preventDefault(); err.hidden = true;
      const body = {
        title: title.value, description: desc.value, count_unit: unit.value, target_count: target.value ? Number(target.value) : null,
        days_of_week: dow.size === 7 ? null : [...dow], start_time: start.value, deadline_time: dead.value, grace_minutes: Number(grace.value || 0),
        start_date: startDate.value, end_date: endDate.value || null, remind_before_min: remind.value ? Number(remind.value) : null, link_url: link.value.trim(), read_text: readText.value, sort: Number(String(order.value).replace(/[٠-٩]/g, (x) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(x))).replace(/[^\d-]/g, '')) || 0,
        assign: { all: asg.all, group_ids: asg.all ? [] : [...asg.groups], user_ids: asg.all ? [] : [...asg.users] },
      };
      busy(save, async () => {
        try { await (editing ? put(`/api/admin/tasks/${id}`, body) : post('/api/admin/tasks', body)); toast(editing ? 'تم حفظ التعديلات' : 'تمت إضافة الورد', 'ok'); go('#/tasks'); }
        catch (ex) { err.textContent = ex.message; err.hidden = false; err.scrollIntoView({ block: 'center' }); }
      });
    },
  },
  h('section', { class: 'card' }, h('h3', {}, 'الورد'), field('اسم الورد', title), field('الوصف', desc),
    field('نص القراءة (اختياري)', readText, 'يظهر زر «فتح للقراءة» في بطاقة الورد، ويُفتح هذا النص داخل التطبيق بتنسيق مريح للقراءة (تُحفظ الأسطر كما كتبتها).'),
    h('div', { class: 'grid g2' }, field('وحدة العدد', unit, 'مثل: مرة، صفحة، دقيقة. تظهر بجانب خانة العدد.'), field('الهدف اليومي', target, 'إن حدّدته يرى العضو تقدّمه نحوه ويظهر خط الهدف في إحصاءاته.')), units),
  h('section', { class: 'card' }, h('h3', {}, 'أيام التكرار'), days, h('div', { class: 'hint muted small', style: 'margin-top:.4rem' }, 'مثال: سورة الكهف يوم الجمعة فقط.')),
  h('section', { class: 'card' }, h('h3', {}, 'الإسناد'), asgBox),
  h('details', { class: 'card' }, h('summary', { style: 'cursor:pointer;font-weight:700' }, 'خيارات متقدمة'),
    h('div', { class: 'stack', style: 'margin-top:.8rem' },
      h('div', { class: 'grid g3' }, field('بداية الوقت', start, 'مثل أذكار الصباح: 04:00'), field('نهاية الوقت', dead, 'مثل أذكار الصباح: 12:00'), field('مهلة بعد النهاية (دقائق)', grace)),
      h('div', { class: 'grid g2' }, field('تاريخ البدء', startDate), field('تاريخ الانتهاء (اختياري)', endDate)),
      field('ترتيب الظهور', order, 'الأصغر يظهر أولاً في لوحة العضو.'),
      field('رابط خارجي (اختياري)', link, 'يظهر زر يفتح الرابط في صفحة جديدة — مثل ملف من المكتبة. إن وُجد «نص القراءة» فالنص هو الأصل ويصير الرابط زراً إضافياً.'),
      field('تذكير لطيف تلقائي عبر واتساب لمن لم يسجّل', remind))),
  err, h('div', { class: 'row' }, save, h('a', { class: 'btn', href: '#/tasks' }, 'إلغاء')));
  form.classList.add('stack');
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, editing ? 'تعديل الورد' : 'ورد جديد')),
    editing ? h('div', { class: 'dev-banner' }, 'تنبيه: تعديل الأيام أو الأوقات يسري على الأيام السابقة أيضاً. للتغيير من تاريخ معين أنشئ وردًا جديداً وأرشف القديم.') : null, form);
}

// ====================================================== الأعضاء
export async function renderUsers(root) {
  const isAdmin = state.user.role === 'admin';
  const [{ groups }, cs] = await Promise.all([get('/api/admin/groups'), get('/api/auth/countries')]);
  const q = h('input', { class: 'input', type: 'search', placeholder: 'بحث بالاسم أو الرقم…', 'aria-label': 'بحث' });
  const gSel = h('select', { class: 'input', 'aria-label': 'الحلقة' }, h('option', { value: '' }, 'كل الحلقات'), groups.map((g) => h('option', { value: g.id }, g.name)));
  const rSel = h('select', { class: 'input', 'aria-label': 'الدور' }, h('option', { value: '' }, 'كل الأدوار'), Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k }, l)));
  const list = h('div');

  /** حذف عضو نهائياً: تُعرض الأنشطة التي ستُمحى معه، ومن له سجلات مالية يُمنع حذفه */
  async function removeUser(u, afterDelete) {
    let d;
    try { d = await get(`/api/admin/users/${u.id}/deletion-impact`); } catch (e) { return fail(e); }
    if (d.blockers.length) {
      const m = modal('تعذّر حذف العضو', h('div', { class: 'stack' }, d.blockers.map((b) => h('p', { style: 'margin:0' }, b)),
        h('div', { class: 'mf' }, h('button', { class: 'btn primary', onclick: () => m.close() }, 'حسناً'))));
      return;
    }
    const i = d.impact;
    const erased = [i.submissions && `${fmtNum(i.submissions)} تسجيلاً في الأوراد`, i.personal_wirds && `${fmtNum(i.personal_wirds)} وردًا شخصياً`, i.posts && `${fmtNum(i.posts)} موضوعاً في المجتمع`].filter(Boolean);
    const text = `حذف «${u.name}» نهائياً؟ ` + (erased.length ? `سيُمحى معه: ${erased.join('، ')}، وتختفي إحصاءاته وسجلّه. ` : '')
      + (i.supervised_groups ? `وتبقى ${fmtNum(i.supervised_groups)} حلقة بلا مشرف. ` : '')
      + (i.registrations ? `وطلبات تسجيله في الدورات (${fmtNum(i.registrations)}) تبقى في «المسجلون الجدد». ` : '') + 'لا يمكن التراجع عن الحذف.';
    if (!(await confirmDialog(text, { danger: true, okText: 'حذف نهائياً' }))) return;
    try { await del(`/api/admin/users/${u.id}${d.has_history ? '?force=1' : ''}`); toast('حُذف العضو', 'ok'); afterDelete?.(); load(); } catch (e) { fail(e); }
  }

  async function load() {
    try {
      const { users } = await get('/api/admin/users' + qs({ q: q.value.trim(), group_id: gSel.value, role: rSel.value }));
      mount(list, users.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't stackable' },
        h('thead', {}, h('tr', {}, ['الاسم', 'الهاتف', 'الدور', 'الحلقات', 'الحالة', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', { 'data-l': 'الاسم' }, h('strong', {}, u.name)), h('td', { 'data-l': 'الهاتف', class: 'ltr' }, u.phone), h('td', { 'data-l': 'الدور' }, ROLE_LABEL[u.role]),
          h('td', { 'data-l': 'الحلقات' }, u.groups.map((g) => g.name).join('، ') || '—'),
          h('td', {}, h('span', { class: 'badge ' + (u.active ? 's-on_time' : 's-upcoming') }, u.active ? 'فعّال' : 'معطّل')),
          h('td', {}, isAdmin ? h('div', { class: 'row', style: 'gap:.3rem;flex-wrap:wrap' },
            h('button', { class: 'btn sm', onclick: () => userDialog(u) }, icon('edit'), 'تعديل'),
            u.id !== state.user.id ? h('button', { class: 'btn sm danger', onclick: () => removeUser(u), 'aria-label': `حذف ${u.name}` }, icon('x'), 'حذف') : null) : null)))))) : emptyState('لا نتائج', 'users'));
    } catch (e) { fail(e); }
  }

  function userDialog(u) {
    const name = h('input', { class: 'input', value: u?.name || '' });
    const phone = h('input', { class: 'input', type: 'tel', dir: 'ltr', value: u?.phone || '', placeholder: '9X XXX XXX أو +968…' });
    const role = h('select', { class: 'input' }, Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k, selected: (u?.role || 'user') === k }, l)));
    const act = u ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: u.active }), 'الحساب فعّال') : null;
    const gids = new Set(u?.groups.map((g) => g.id) || []);
    const gBox = h('div', { class: 'chips' }, groups.map((g) => h('label', { class: 'chip-check' }, h('input', { type: 'checkbox', checked: gids.has(g.id), onchange: (e) => { e.target.checked ? gids.add(g.id) : gids.delete(g.id); } }), h('span', {}, g.name))));
    const err = h('div', { class: 'err', hidden: true });
    const btn = h('button', { class: 'btn primary', onclick: () => busy(btn, async () => {
      const body = { name: name.value, phone: phone.value, role: role.value, group_ids: [...gids] };
      if (act) body.active = act.querySelector('input').checked;
      try { await (u ? patch(`/api/admin/users/${u.id}`, body) : post('/api/admin/users', body)); m.close(); toast('تم الحفظ', 'ok'); load(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const extra = u ? h('div', { class: 'row', style: 'margin-top:1rem' },
      h('button', { class: 'btn sm', onclick: async () => { await post(`/api/admin/users/${u.id}/logout-all`); toast('تم تسجيل خروجه من كل الأجهزة', 'ok'); } }, icon('logout'), 'إخراج من كل الأجهزة'),
      u.has_pin ? h('button', { class: 'btn sm', onclick: async () => { await post(`/api/admin/users/${u.id}/reset-pin`); toast('تم إلغاء الرمز السري', 'ok'); } }, 'إلغاء الرمز السري') : null,
      u.id !== state.user.id ? h('button', { class: 'btn sm danger', onclick: () => removeUser(u, () => m.close()) }, 'حذف العضو') : null) : null;
    const m = modal(u ? 'تعديل عضو' : 'إضافة عضو', h('div', {}, field('الاسم', name), field('رقم الهاتف', phone, u ? 'تغيير الرقم يُخرج العضو من كل أجهزته.' : 'الدولة الافتراضية سلطنة عُمان؛ أو اكتب الرمز الدولي مع +.'),
      field('الدور', role), groups.length ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'الحلقات'), gBox) : null, act, err, h('div', { class: 'mf' }, btn), extra));
  }

  function importDialog() {
    const file = h('input', { class: 'input', type: 'file', accept: '.xlsx' });
    const country = h('select', { class: 'input' }, cs.countries.map((c) => h('option', { value: c.code, selected: c.code === cs.default }, `${c.name} (${c.dial})`)));
    const res = h('div');
    const btn = h('button', { class: 'btn primary', onclick: () => busy(btn, async () => {
      if (!file.files[0]) return toast('اختر ملف Excel', 'err');
      const fd = new FormData(); fd.append('file', file.files[0]); fd.append('country', country.value);
      const r = await api('POST', '/api/admin/users/import', fd);
      mount(res, h('div', { class: 'dev-banner' }, `أُضيف ${r.added} · حُدّث ${r.updated}${r.errors.length ? ` · أخطاء ${r.errors.length}` : ''}`),
        r.errors.length ? h('ul', { class: 'small' }, r.errors.slice(0, 30).map((e) => h('li', {}, `الصف ${e.row}: ${e.error}`))) : null);
      load();
    }) }, icon('upload'), 'رفع واستيراد');
    modal('استيراد أعضاء من Excel', h('div', {}, h('p', { class: 'muted' }, 'الأعمدة: الاسم، الهاتف، (الدور)، (الحلقة). تُنشأ الحلقات غير الموجودة تلقائياً، ويُحدَّث من كان رقمه مسجلاً.'),
      h('a', { class: 'btn sm', href: '/api/admin/users-template.xlsx' }, icon('download'), 'تنزيل نموذج'), h('div', { style: 'margin-top:1rem' }), field('الملف', file),
      field('دولة الأرقام التي بلا رمز دولي', country), res, h('div', { class: 'mf' }, btn)));
  }
  [q, gSel, rSel].forEach((el) => el.addEventListener(el === q ? 'input' : 'change', () => { clearTimeout(load.t); load.t = setTimeout(load, 200); }));
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, isAdmin ? 'الأعضاء' : 'أعضاء حلقاتي'), isAdmin ? h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: importDialog }, icon('upload'), 'استيراد Excel'), h('button', { class: 'btn primary', onclick: () => userDialog() }, icon('plus'), 'عضو جديد')) : null),
  h('div', { class: 'row', style: 'margin-bottom:1rem' }, q, gSel, isAdmin ? rSel : null), list);
  await load();
}

// ====================================================== الحلقات
export async function renderGroups(root) {
  const isAdmin = state.user.role === 'admin';
  const list = h('div', { class: 'stack' });
  async function load() {
    const { groups } = await get('/api/admin/groups');
    mount(list, groups.length ? groups.map((g) => h('div', { class: 'card row between' },
      h('div', {}, h('strong', {}, g.name), h('div', { class: 'muted small' }, `${fmtNum(g.members)} عضو · المشرف: ${g.supervisor_name || '—'}`)),
      isAdmin ? h('div', { class: 'row', style: 'gap:.35rem' }, h('button', { class: 'btn sm', onclick: () => dialog(g) }, icon('edit'), 'تعديل'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`حذف حلقة «${g.name}»؟`, { danger: true, okText: 'حذف' }))) return;
          try { await del(`/api/admin/groups/${g.id}`); load(); } catch (e) { fail(e); }
        } }, 'حذف')) : null)) : emptyState('لا توجد حلقات بعد. الحلقة مجموعة أعضاء يتابعها مشرف ويشجّعها.', 'users'));
  }
  async function dialog(g) {
    const { users } = await get('/api/admin/users?active=1');
    const members = new Set(g ? (await get(`/api/admin/groups/${g.id}/members`)).user_ids : []);
    const name = h('input', { class: 'input', value: g?.name || '' });
    const sup = h('select', { class: 'input' }, h('option', { value: '' }, 'بدون مشرف'), users.filter((u) => u.role === 'supervisor').map((u) => h('option', { value: u.id, selected: g?.supervisor_id === u.id }, u.name)));
    const s = h('input', { class: 'input', type: 'search', placeholder: 'بحث…' });
    const box = h('div', { class: 'picker' });
    const paint = () => mount(box, users.filter((u) => !s.value || u.name.includes(s.value) || u.phone.includes(s.value)).map((u) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: members.has(u.id), onchange: (e) => { e.target.checked ? members.add(u.id) : members.delete(u.id); } }), u.name, h('span', { class: 'muted small ltr' }, u.phone))));
    s.addEventListener('input', paint); paint();
    const err = h('div', { class: 'err', hidden: true });
    const btn = h('button', { class: 'btn primary', onclick: () => busy(btn, async () => {
      const body = { name: name.value, supervisor_id: sup.value || null, user_ids: [...members] };
      try { await (g ? patch(`/api/admin/groups/${g.id}`, body) : post('/api/admin/groups', body)); m.close(); toast('تم الحفظ', 'ok'); load(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const m = modal(g ? 'تعديل حلقة' : 'حلقة جديدة', h('div', {}, field('اسم الحلقة', name), field('المشرف', sup, 'يظهر في القائمة من لديهم دور «مشرف حلقة».'), h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'الأعضاء'), s, h('div', { style: 'margin-top:.4rem' }, box)), err, h('div', { class: 'mf' }, btn)), { wide: true });
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, isAdmin ? 'الحلقات' : 'حلقاتي'), isAdmin ? h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => dialog() }, icon('plus'), 'حلقة جديدة')) : null), list);
  await load();
}

// ====================================================== رسالة اليوم
export async function renderMessages(root) {
  const isAdmin = state.user.role === 'admin';
  const out = h('div', { class: 'stack' });
  async function load() {
    try {
      const d = await get('/api/admin/messages');
      mount(out,
        h('section', { class: 'verse-card' },
          h('div', { class: 'muted small' }, 'ما يراه الأعضاء اليوم'),
          d.current ? h('div', {}, h('div', { class: 'txt' }, d.current.text), d.current.source ? h('div', { class: 'src' }, d.current.source) : null)
            : h('p', { class: 'muted' }, 'لا توجد رسالة فعّالة')),
        isAdmin ? h('div', { class: 'row', style: 'margin-bottom:.5rem' },
          h('button', { class: 'btn primary', onclick: () => dialog(null) }, icon('plus'), 'رسالة جديدة'),
          h('button', { class: 'btn', onclick: () => dialog(null, d.today) }, icon('calendar'), 'رسالة ليوم محدد')) : null,
        d.messages.length ? d.messages.map((m) => h('article', { class: 'card row between' },
          h('div', { class: 'grow' },
            h('div', { style: 'font-size:1.05rem;line-height:1.9' }, m.text),
            h('div', { class: 'row muted small', style: 'gap:.5rem;margin-top:.25rem' },
              m.source ? h('span', { class: 'kind' }, m.source) : null,
              m.show_date ? h('span', { class: 'badge ' + (m.is_today ? 's-on_time' : 's-open') }, m.is_today ? `اليوم ${fmtDayShort(m.show_date)}` : fmtDayShort(m.show_date)) : h('span', { class: 'muted small' }, 'ضمن التدوير اليومي'),
              !m.active ? h('span', { class: 'badge s-upcoming' }, 'معطّلة') : null)),
          isAdmin ? h('div', { class: 'row', style: 'gap:.35rem' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.active, onchange: async (e) => {
              try { await patch(`/api/admin/messages/${m.id}`, { active: e.target.checked }); toast('تم', 'ok'); }
              catch (x) { e.target.checked = !e.target.checked; fail(x); }
            } }), 'فعّالة'),
            h('button', { class: 'btn sm', onclick: () => dialog(m) }, icon('edit'), 'تعديل'),
            h('button', { class: 'btn sm danger', onclick: async () => {
              if (!(await confirmDialog('حذف هذه الرسالة؟', { danger: true, okText: 'حذف' }))) return;
              try { await del(`/api/admin/messages/${m.id}`); load(); } catch (x) { fail(x); }
            } }, 'حذف')) : null)) : emptyState('لا رسائل بعد', 'book'));
    } catch (e) { fail(e); }
  }
  function dialog(m, forDate) {
    const text = h('textarea', { class: 'input', rows: 4, maxlength: 600, placeholder: 'اكتب الآية أو التدبر…' }, m?.text || '');
    const source = h('input', { class: 'input', maxlength: 60, value: m?.source || '', placeholder: 'المرجع، مثل: الرعد ٢٨' });
    const date = h('input', { class: 'input', type: 'date', value: m?.show_date || forDate || '' });
    const err = h('div', { class: 'err', hidden: true });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      const body = { text: text.value, source: source.value, show_date: date.value || null };
      try { await (m ? patch(`/api/admin/messages/${m.id}`, body) : post('/api/admin/messages', body)); dlg.close(); toast('تم الحفظ', 'ok'); load(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const dlg = modal(m ? 'تعديل الرسالة' : 'رسالة جديدة', h('div', {},
      field('النص', text), field('المرجع', source),
      field('تاريخ محدد (اختياري)', date, 'اتركه فارغاً لتدخل ضمن التدوير اليومي، أو حدّد يوماً لتظهر فيه وحدها.'),
      err, h('div', { class: 'mf' }, save)));
  }
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'رسالة اليوم'),
    h('div', { class: 'muted' }, 'آية أو تدبر يظهر في لوحة العضو — رسالة اليوم المحدد أولاً، وإلا تدوير يومي بين الرسائل الفعّالة'))), out);
  await load();
}
