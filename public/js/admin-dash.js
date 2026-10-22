import {
  h, mount, icon, get, post, fail, toast, busy, modal, confirmDialog, qs,
  fmtDay, fmtDayShort, fmtDateTime, fmtNum, fmtTime, todayStr, addDaysStr, statusBadge, emptyState, stackedBar, pct, STATUS,
} from './core.js';
import { submissionView } from './user.js';

const kpi = (cls, v, l) => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
const ring = (v, label) => h('div', { class: 'row', style: 'gap:1rem' },
  h('div', { class: 'ring', style: `--p:${v ?? 0}`, role: 'img', 'aria-label': `${label}: ${pct(v)}` }, h('b', {}, v == null ? '—' : Math.round(v) + '%')),
  h('div', {}, h('div', { style: 'font-weight:700' }, label)));

async function remind(taskId, date, userIds, label) {
  const ok = await confirmDialog(`إرسال تذكير لطيف عبر واتساب ${label}؟`, { okText: 'إرسال التذكير' });
  if (!ok) return false;
  try {
    const r = await post('/api/admin/reminders', { task_id: taskId, date, user_ids: userIds });
    if (!r.sent && !r.failed && !r.skipped) toast('لا يوجد من يحتاج تذكيراً');
    else if (r.failed) toast(`أُرسل ${r.sent}، وفشل ${r.failed}${r.errors?.[0] ? ' — ' + r.errors[0] : ''}`, 'err');
    else toast(`تم إرسال ${r.sent} تذكير${r.skipped ? ` (تخطّي ${r.skipped} ذُكّروا حديثاً)` : ''}`, 'ok');
    return true;
  } catch (e) { fail(e); return false; }
}

export function showSubmission(id) {
  get(`/api/admin/submissions/${id}`).then(({ submission: s }) => {
    modal(`${s.task_title} — ${s.user_name}`, h('div', {}, h('div', { class: 'muted small', style: 'margin-bottom:.6rem' }, fmtDay(s.occ_date)), submissionView(s, s.count_unit)));
  }).catch(fail);
}

async function groupSelect(onChange, value = '') {
  let groups = [];
  try { groups = (await get('/api/admin/groups')).groups; } catch { /* */ }
  const sel = h('select', { class: 'input', 'aria-label': 'الحلقة' }, h('option', { value: '' }, 'كل الحلقات'),
    groups.map((g) => h('option', { value: g.id, selected: String(g.id) === String(value) }, g.name)));
  sel.addEventListener('change', onChange);
  return sel;
}

// ====================================================== نظرة عامة
export async function renderDashboard(root) {
  const out = h('div', { class: 'stack-lg' });
  const sel = await groupSelect(load);
  async function load() {
    try {
      const d = await get('/api/admin/dashboard' + qs({ group_id: sel.value }));
      const waiting = d.day.open + d.day.upcoming;
      mount(out,
        h('section', {}, h('div', { class: 'row between', style: 'margin-bottom:.6rem' }, h('h2', { style: 'margin:0' }, 'اليوم'), h('span', { class: 'muted' }, fmtDay(d.today))),
          h('div', { class: 'grid g3' },
            kpi('ok', fmtNum(d.day.on_time), 'تسجيلات اليوم'), kpi('open', fmtNum(waiting), 'بانتظار التسجيل'), kpi('bad', fmtNum(d.day.missed), 'لم يُسجَّل بعد انتهاء وقته'))),
        h('section', { class: 'grid g2' },
          h('div', { class: 'card' }, ring(d.day.compliance, 'مواظبة اليوم'), h('div', { class: 'muted small', style: 'margin-top:.5rem' }, 'المسجَّل في وقته ÷ المستحق (دون المتاح بعد)')),
          h('div', { class: 'card' }, ring(d.month.compliance, 'مواظبة الشهر'), h('div', { class: 'muted small', style: 'margin-top:.5rem' }, `${fmtNum(d.month.due)} ورد مستحق هذا الشهر`))),
        h('section', {}, h('div', { class: 'row between', style: 'margin-bottom:.6rem' }, h('h2', { style: 'margin:0' }, 'أوراد اليوم'),
          h('a', { class: 'btn sm', href: '#/tracking' }, 'متابعة الأعضاء')),
          d.tasks.length ? h('div', { class: 'stack' }, d.tasks.map((t) => h('div', { class: 'card' },
            h('div', { class: 'row between' },
              h('div', {}, h('strong', {}, t.title), h('div', { class: 'muted small num' }, t.count_sum ? `مجموع ما سُجّل اليوم: ${fmtNum(t.count_sum)} ${t.count_unit}` : 'لم يُسجَّل شيء بعد', t.target_count ? ` · الهدف ${fmtNum(t.target_count)}` : '')),
              (t.open + t.missed) > 0 ? h('button', { class: 'btn sm', onclick: () => remind(t.task_id, d.today, null, `لمن لم يسجّل «${t.title}»`).then(load) }, icon('bell'), 'تذكير لطيف') : null),
            h('div', { style: 'margin:.6rem 0 .3rem' }, stackedBar(t)),
            h('div', { class: 'row small muted', style: 'gap:1rem' },
              h('span', {}, `سجّلوا ${fmtNum(t.on_time)}`), h('span', {}, `بانتظار ${fmtNum(t.open + t.upcoming)}`), t.missed ? h('span', {}, `لم يسجّلوا ${fmtNum(t.missed)}`) : null,
              h('span', { style: 'margin-inline-start:auto' }, `المواظبة ${pct(t.compliance)}`))))) : emptyState('لا أوراد مجدولة اليوم', 'inbox')),
        d.laggards.length ? h('section', {}, h('h2', {}, 'أعضاء قد يحتاجون تشجيعاً هذا الشهر'), h('div', { class: 'tablewrap' }, h('table', { class: 't' },
          h('thead', {}, h('tr', {}, ['العضو', 'المستحق', 'في وقته', 'لم يُسجَّل', 'المواظبة'].map((x) => h('th', {}, x)))),
          h('tbody', {}, d.laggards.map((u) => h('tr', {}, h('td', {}, u.name), h('td', { class: 'num' }, fmtNum(u.due)), h('td', { class: 'num' }, fmtNum(u.on_time)), h('td', { class: 'num' }, fmtNum(u.missed)), h('td', { class: 'num' }, pct(u.compliance)))))))) : null);
    } catch (e) { fail(e); }
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'نظرة عامة'), h('div', { class: 'actions' }, sel)), out);
  await load();
  const t = setInterval(load, 60_000);
  return () => clearInterval(t);
}

// ====================================================== متابعة الأعضاء
export async function renderTracking(root) {
  const today = todayStr();
  const from = h('input', { class: 'input', type: 'date', value: today, 'aria-label': 'من تاريخ' });
  const to = h('input', { class: 'input', type: 'date', value: today, 'aria-label': 'إلى تاريخ' });
  const group = await groupSelect(load);
  let tasks = [];
  try { tasks = (await get('/api/admin/tasks?status=all')).tasks; } catch { /* */ }
  const task = h('select', { class: 'input', 'aria-label': 'الورد' }, h('option', { value: '' }, 'كل الأوراد'), tasks.map((t) => h('option', { value: t.id }, t.title)));
  const status = h('select', { class: 'input', 'aria-label': 'الحالة' }, h('option', { value: '' }, 'كل الحالات'), Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v[0])));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'بحث باسم العضو…', 'aria-label': 'بحث' });
  const out = h('div', { class: 'stack' });
  let data = null;

  async function load() {
    try {
      data = await get('/api/admin/tracking' + qs({ from: from.value, to: to.value, group_id: group.value, task_id: task.value, status: status.value }));
      paint();
    } catch (e) { fail(e); }
  }
  function paint() {
    if (!data) return;
    const q = search.value.trim();
    const rows = data.rows.filter((r) => !q || r.user_name.includes(q) || r.user_phone.includes(q));
    const s = data.summary;
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.task_id}|${r.date}`;
      if (!groups.has(k)) groups.set(k, { task_id: r.task_id, title: r.task_title, unit: r.count_unit, target: r.target_count, date: r.date, deadline: r.deadline_at, rows: [] });
      groups.get(k).rows.push(r);
    }
    mount(out,
      h('div', { class: 'grid g3' }, kpi('ok', fmtNum(s.on_time), 'سُجّل في وقته'), kpi('bad', fmtNum(s.missed), 'لم يُسجَّل'), kpi('open', fmtNum(s.open + s.upcoming), 'بانتظار التسجيل')),
      h('div', { class: 'muted small' }, `نسبة المواظبة ${pct(s.compliance)} · ${fmtNum(data.total)} سجل${data.total > data.rows.length ? ` (يُعرض ${fmtNum(data.rows.length)})` : ''}`),
      groups.size ? h('div', { class: 'tablewrap' }, h('table', { class: 't stackable' },
        h('thead', {}, h('tr', {}, ['العضو', 'الهاتف', 'الحالة', 'العدد', 'وقت التسجيل', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, [...groups.values()].map((g) => {
          const pend = g.rows.filter((r) => r.status === 'open' || r.status === 'missed');
          const sent = g.rows.filter((r) => r.status === 'on_time').length;
          const sum = g.rows.reduce((a, r) => a + (r.count || 0), 0);
          return [
            h('tr', { class: 'grouprow' }, h('td', { colspan: 6 }, h('div', { class: 'row between' },
              h('span', {}, g.title, h('span', { class: 'muted small' }, ` · ${fmtDayShort(g.date)} · سجّل ${fmtNum(sent)} من ${fmtNum(g.rows.length)}${sum ? ` · المجموع ${fmtNum(sum)} ${g.unit}` : ''}`)),
              pend.length ? h('button', { class: 'btn sm', onclick: () => remind(g.task_id, g.date, pend.map((r) => r.user_id), `إلى ${fmtNum(pend.length)} لم يسجّلوا`).then(load) }, icon('bell'), `تذكير لطيف (${fmtNum(pend.length)})`) : null))),
            ...g.rows.map((r) => h('tr', {},
              h('td', { 'data-l': 'العضو' }, r.user_name),
              h('td', { 'data-l': 'الهاتف', class: 'ltr muted' }, r.user_phone),
              h('td', {}, statusBadge(r.status)),
              h('td', { 'data-l': 'العدد', class: 'nowrap num' }, r.count != null ? `${fmtNum(r.count)} ${r.count_unit}${g.target && r.count >= g.target ? ' ✓' : ''}` : '—'),
              h('td', { 'data-l': 'وقت التسجيل', class: 'nowrap' }, r.submitted_at ? fmtDateTime(r.submitted_at) : '—'),
              h('td', {}, h('div', { class: 'row', style: 'gap:.35rem' },
                r.submission_id ? h('button', { class: 'btn sm', onclick: () => showSubmission(r.submission_id) }, icon('eye'), 'عرض') : null,
                r.status === 'open' || r.status === 'missed' ? h('button', { class: 'btn sm', title: 'تذكير لطيف', 'aria-label': 'تذكير لطيف', onclick: () => remind(r.task_id, r.date, [r.user_id], `إلى ${r.user_name}`).then(load) }, icon('bell')) : null)))),
          ];
        })))) : emptyState('لا نتائج مطابقة', 'list'));
  }
  for (const el of [from, to, group, task, status]) el.addEventListener('change', load);
  search.addEventListener('input', paint);
  const quick = (label, f, t) => h('button', { class: 'btn sm', type: 'button', onclick: () => { from.value = f(); to.value = t(); load(); } }, label);
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'متابعة الأعضاء'), h('div', { class: 'actions' },
    quick('اليوم', () => todayStr(), () => todayStr()), quick('أمس', () => addDaysStr(todayStr(), -1), () => addDaysStr(todayStr(), -1)),
    quick('آخر 7 أيام', () => addDaysStr(todayStr(), -6), () => todayStr()), quick('هذا الشهر', () => todayStr().slice(0, 8) + '01', () => todayStr()))),
    h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('div', { class: 'grid g3' },
      ...[['من', from], ['إلى', to], ['الحلقة', group], ['الورد', task], ['الحالة', status]].map(([l, el]) => h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, l), el)),
      h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, 'بحث'), search))),
    out);
  await load();
  const t = setInterval(load, 30_000);
  return () => clearInterval(t);
}

// ====================================================== التقارير
export async function renderReports(root) {
  const today = todayStr();
  const from = h('input', { class: 'input', type: 'date', value: addDaysStr(today, -29) });
  const to = h('input', { class: 'input', type: 'date', value: today });
  const group = await groupSelect(load);
  let tasks = [];
  try { tasks = (await get('/api/admin/tasks?status=all')).tasks; } catch { /* */ }
  const task = h('select', { class: 'input' }, h('option', { value: '' }, 'كل الأوراد'), tasks.map((t) => h('option', { value: t.id }, t.title)));
  const out = h('div', { class: 'stack-lg' });
  const params = () => ({ from: from.value, to: to.value, group_id: group.value, task_id: task.value });
  const exportLink = h('a', { class: 'btn', href: '#', download: '' }, icon('download'), 'تصدير Excel');

  const table = (rows, first, withCount = false) => h('div', { class: 'tablewrap' }, h('table', { class: 't' },
    h('thead', {}, h('tr', {}, [first, 'المستحق', 'في وقته', 'لم يُسجَّل', 'المواظبة', ...(withCount ? ['إجمالي العدد'] : []), ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', { class: 'num' }, fmtNum(r.due)), h('td', { class: 'num' }, fmtNum(r.on_time)),
      h('td', { class: 'num' }, fmtNum(r.missed)), h('td', { class: 'num' }, pct(r.compliance)),
      withCount ? h('td', { class: 'num' }, r.count_sum ? `${fmtNum(r.count_sum)} ${r.count_unit}` : '—') : null,
      h('td', { style: 'min-width:110px' }, stackedBar(r)))))));

  async function load() {
    exportLink.href = '/api/admin/reports/export' + qs(params());
    try {
      const d = await get('/api/admin/reports/summary' + qs(params()));
      const max = Math.max(1, ...d.days.map((x) => x.due + x.open + x.upcoming));
      mount(out,
        h('div', { class: 'grid g3' }, kpi('', pct(d.overall.compliance), 'نسبة المواظبة'), kpi('ok', fmtNum(d.overall.on_time), 'سُجّل في وقته'), kpi('bad', fmtNum(d.overall.missed), 'لم يُسجَّل')),
        d.days.length > 1 ? h('section', { class: 'card' }, h('h3', {}, 'المواظبة اليومية'),
          h('div', { style: 'display:flex;align-items:flex-end;gap:3px;height:120px;overflow-x:auto;padding-bottom:4px', role: 'img', 'aria-label': 'رسم المواظبة اليومية' },
            d.days.map((x) => h('div', { title: `${x.label}: في وقته ${x.on_time}، لم يُسجَّل ${x.missed}`, style: 'flex:1 0 10px;max-width:28px;display:flex;flex-direction:column-reverse;height:100%' },
              ['on_time', 'missed'].map((k) => h('div', { style: `height:${(x[k] / max) * 100}%;background:var(--c-${k === 'on_time' ? 'ok' : 'bad'})` }))))),
          h('div', { class: 'legend', style: 'margin-top:.5rem' }, h('span', {}, h('i', { style: 'background:var(--c-ok)' }), 'في وقته'), h('span', {}, h('i', { style: 'background:var(--c-bad)' }), 'لم يُسجَّل'))) : null,
        h('section', {}, h('h2', {}, 'حسب العضو'), d.users.length ? table(d.users, 'العضو') : emptyState('لا بيانات في هذه الفترة', 'chart')),
        d.tasks.length ? h('section', {}, h('h2', {}, 'حسب الورد'), table(d.tasks, 'الورد', true)) : null);
    } catch (e) { fail(e); }
  }
  for (const el of [from, to, task]) el.addEventListener('change', load);
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'التقارير'), h('div', { class: 'actions' }, exportLink)),
    h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('div', { class: 'grid g3' },
      ...[['من', from], ['إلى', to], ['الحلقة', group], ['الورد', task]].map(([l, el]) => h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, l), el)))),
    out);
  await load();
}
