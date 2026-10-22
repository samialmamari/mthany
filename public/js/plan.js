import {
  h, mount, icon, get, post, put, del, toast, busy, modal, confirmDialog, fmtNum, fmtDayShort, emptyState, WEEKDAYS,
} from './core.js';

// ---------- أوقات الورد: نوافذ جاهزة تقريبية بتوقيت المنصة (يعدّلها العضو بما يوافق مواقيت الصلاة عنده) ----------
const WINDOWS = [
  ['all', 'طوال اليوم', '00:00', '23:59'],
  ['fajr', 'بعد الفجر', '05:00', '08:00'],
  ['duha', 'الضحى', '08:00', '11:30'],
  ['dhuhr', 'بعد الظهر', '12:30', '15:00'],
  ['asr', 'بعد العصر', '15:30', '18:00'],
  ['maghrib', 'بعد المغرب', '18:00', '20:00'],
  ['isha', 'بعد العشاء', '19:30', '23:59'],
];
const UNITS = ['مرة', 'صفحة', 'دقيقة', 'ركعة', 'آية'];
const TEMPLATES = [
  { title: 'أذكار بعد العصر', kind: 'check', win: 'asr' },
  { title: 'الاستغفار', kind: 'count', target: 100, unit: 'مرة', win: 'asr' },
  { title: 'قراءة من القرآن', kind: 'count', target: 5, unit: 'صفحة', win: 'fajr' },
  { title: 'الصلاة على النبي', kind: 'count', target: 100, unit: 'مرة', win: 'maghrib' },
];

const t12 = (hhmm) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return `${fmtNum(hh % 12 || 12)}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'ص' : 'م'}`;
};
const toLatin = (s) => String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

/** وصف نافذة الوقت، أو '' إن كان الورد مفتوحاً طوال اليوم */
export function windowLabel(from, to) {
  if (from === '00:00' && to === '23:59') return '';
  const w = WINDOWS.find((x) => x[2] === from && x[3] === to);
  return w ? `${w[1]} · ${t12(from)} – ${t12(to)}` : `${t12(from)} – ${t12(to)}`;
}
const daysLabel = (d) => (!d ? 'كل الأيام' : d.length === 1 ? WEEKDAYS[d[0]] : d.map((i) => WEEKDAYS[i]).join('، '));
const goalLabel = (t) => (t.target_count === 1 ? 'إتمام مرة واحدة ✓' : t.target_count ? `الهدف ${fmtNum(t.target_count)} ${t.count_unit}` : `عدّاد مفتوح (${t.count_unit})`);

// ---------- نموذج الورد (ورقة سفلية) ----------
function openForm(task, preset, done) {
  const editing = !!task;
  const t0 = task || {};
  const win0 = preset?.win ? WINDOWS.find((w) => w[0] === preset.win) : null;
  const s = {
    kind: preset?.kind ?? (editing && t0.target_count === 1 ? 'check' : 'count'),
    unit: preset?.unit ?? t0.count_unit ?? 'مرة',
    custom: false,
    days: new Set(t0.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]),
  };
  s.custom = !UNITS.includes(s.unit);

  const title = h('input', { class: 'input', value: preset?.title ?? t0.title ?? '', maxlength: 120, placeholder: 'مثال: الاستغفار بعد العصر', 'aria-label': 'اسم الورد' });
  const target = h('input', { class: 'input', type: 'text', inputmode: 'numeric', dir: 'ltr', value: String(preset?.target ?? t0.target_count ?? ''), placeholder: 'مثلاً 100', 'aria-label': 'الهدف اليومي' });
  const otherUnit = h('input', { class: 'input', maxlength: 20, value: s.custom ? s.unit : '', placeholder: 'اكتب الوحدة', 'aria-label': 'وحدة أخرى' });
  const fromI = h('input', { class: 'input', type: 'time', value: win0?.[2] ?? t0.start_time ?? '00:00', 'aria-label': 'من' });
  const toI = h('input', { class: 'input', type: 'time', value: win0?.[3] ?? t0.deadline_time ?? '23:59', 'aria-label': 'إلى' });
  const desc = h('textarea', { class: 'input', rows: 2, maxlength: 1000, placeholder: 'ملاحظة أو نيّة تذكّرك بالورد (اختياري)' }, t0.description || '');
  const endDate = h('input', { class: 'input', type: 'date', value: t0.end_date || '' });
  const err = h('div', { class: 'err', role: 'alert', hidden: true });

  const kindSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'نوع الورد' });
  const kindHint = h('div', { class: 'hint muted small' });
  const countBox = h('div', { class: 'stack' });
  const unitChips = h('div', { class: 'chips' });
  const winChips = h('div', { class: 'chips' });
  const paintKind = () => {
    mount(kindSeg, [['count', 'عدّاد بهدف'], ['check', 'إتمام ✓']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(s.kind === k), onclick: () => { s.kind = k; paintKind(); } }, l)));
    countBox.hidden = s.kind === 'check';
    kindHint.textContent = s.kind === 'check' ? 'زر واحد تضغطه عند إتمام الورد، مثل أذكار الصباح.' : 'تسجّل عدداً وتتابع تقدّمك نحو هدفك اليومي.';
  };
  const paintUnit = () => {
    mount(unitChips, UNITS.map((u) => h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(!s.custom && s.unit === u), onclick: () => { s.custom = false; s.unit = u; paintUnit(); } }, u)),
      h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(s.custom), onclick: () => { s.custom = true; paintUnit(); otherUnit.focus(); } }, 'أخرى'));
    otherUnit.hidden = !s.custom;
  };
  const paintWin = () => mount(winChips, WINDOWS.map(([, label, a, b]) => h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(fromI.value === a && toI.value === b), onclick: () => { fromI.value = a; toI.value = b; paintWin(); } }, label)));
  fromI.addEventListener('input', paintWin); toI.addEventListener('input', paintWin);
  const days = h('div', { class: 'chips' }, WEEKDAYS.map((n, i) => h('label', { class: 'chip-check' },
    h('input', { type: 'checkbox', checked: s.days.has(i), onchange: (e) => { e.target.checked ? s.days.add(i) : s.days.delete(i); } }), h('span', {}, n))));
  paintKind(); paintUnit(); paintWin();

  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
  const save = h('button', { class: 'btn primary block', type: 'submit' }, editing ? 'حفظ التعديلات' : 'إضافة إلى خطتي');
  const form = h('form', {
    novalidate: true,
    onsubmit: (e) => {
      e.preventDefault(); err.hidden = true;
      const raw = toLatin(target.value).trim();
      if (s.kind === 'count' && raw && !/^\d+$/.test(raw)) { err.textContent = 'الهدف رقم صحيح بلا فواصل'; err.hidden = false; return; }
      const unit = s.kind === 'check' ? 'مرة' : s.custom ? otherUnit.value.trim() : s.unit;
      const body = {
        title: title.value, description: desc.value, count_unit: unit,
        target_count: s.kind === 'check' ? 1 : raw ? Number(raw) : null,
        start_time: fromI.value, deadline_time: toI.value,
        days_of_week: s.days.size === 7 ? null : [...s.days].sort(), end_date: endDate.value || null,
      };
      busy(save, async () => {
        try {
          const r = await (editing ? put(`/api/my/plan/${task.id}`, body) : post('/api/my/plan', body));
          m.close();
          toast(editing ? 'تم حفظ التعديلات' : r.starts_tomorrow ? 'أُضيف الورد، ويبدأ من الغد لأن وقته انتهى اليوم' : 'أُضيف الورد إلى خطتك', 'ok');
          done();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; err.scrollIntoView({ block: 'center' }); }
      });
    },
  },
  field('اسم الورد', title),
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'نوع الورد'), kindSeg, kindHint),
  countBox,
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'متى؟'), winChips,
    h('div', { class: 'grid g2', style: 'margin-top:.6rem' }, field('من', fromI), field('إلى', toI)),
    h('div', { class: 'hint muted small' }, 'المواعيد تقريبية بتوقيت المنصة؛ عدّلها لتوافق مواقيت الصلاة عندك. يُفتح الورد في بداية الوقت ويُغلق في نهايته.')),
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'الأيام'), days),
  h('details', { class: 'more-opts' }, h('summary', {}, 'خيارات إضافية'),
    h('div', { class: 'stack', style: 'margin-top:.7rem' }, field('ملاحظة', desc), field('ينتهي في (اختياري)', endDate))),
  editing ? h('div', { class: 'dev-banner' }, 'تعديل الأيام أو الوقت يسري على الأيام السابقة أيضاً.') : null,
  err, h('div', { class: 'sheetfoot' }, save));
  countBox.append(field('الهدف اليومي', target, 'اتركه فارغاً لعدّاد مفتوح بلا هدف.'), h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'الوحدة'), unitChips, otherUnit));
  const m = modal(editing ? 'تعديل الورد' : 'ورد جديد', form);
}

// ---------- صفحة خطتي ----------
export async function renderPlan(root) {
  const out = h('div', { class: 'stack' });
  let limit = 20;

  const chip = (ic, text) => h('span', { class: 'pi-chip' }, icon(ic), text);
  async function act(fn) { try { await fn(); await load(); } catch (e) { toast(e.message || 'حدث خطأ', 'err'); } }

  function card(t) {
    const paused = t.status === 'paused';
    const win = windowLabel(t.start_time, t.deadline_time);
    return h('article', { class: `card planitem${paused ? ' paused' : ''}` },
      h('div', { class: 'pi-head' }, h('h3', {}, t.title), paused ? h('span', { class: 'badge s-upcoming' }, 'موقوف مؤقتاً') : null),
      t.description ? h('p', { class: 'muted small', style: 'margin:0;white-space:pre-wrap' }, t.description) : null,
      h('div', { class: 'pi-meta' }, chip('tasks', goalLabel(t)), chip('clock', win || 'طوال اليوم'), chip('calendar', daysLabel(t.days_of_week)),
        t.end_date ? chip('calendar', `ينتهي ${fmtDayShort(t.end_date)}`) : null),
      h('div', { class: 'pi-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => openForm(t, null, load) }, icon('edit'), 'تعديل'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => act(() => post(`/api/my/plan/${t.id}/${paused ? 'resume' : 'pause'}`)) }, paused ? 'استئناف' : 'إيقاف مؤقت'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          const ok = await confirmDialog(t.has_history ? 'لهذا الورد سجلّ سابق: سيُؤرشف ويبقى في إحصاءاتك، ولن يظهر في لوحتك بعد اليوم. المتابعة؟' : 'سيُحذف هذا الورد نهائياً. المتابعة؟', { okText: t.has_history ? 'أرشفة' : 'حذف', danger: true });
          if (ok) act(async () => { const r = await del(`/api/my/plan/${t.id}`); toast(r.archived ? 'أُرشف الورد وبقي سجلّه' : 'حُذف الورد', 'ok'); });
        } }, 'حذف')));
  }

  function emptyPlan() {
    return h('div', { class: 'planempty' },
      emptyState('لم تضف أوراداً إلى خطتك بعد. ابدأ من اقتراح أو أنشئ وردك بنفسك.', 'tasks'),
      h('div', { class: 'tpl-grid' }, TEMPLATES.map((t) => h('button', { class: 'tpl', type: 'button', onclick: () => openForm(null, t, load) },
        h('b', {}, t.title), h('span', { class: 'muted small' }, `${t.kind === 'check' ? 'إتمام ✓' : `${fmtNum(t.target)} ${t.unit}`} · ${WINDOWS.find((w) => w[0] === t.win)[1]}`)))));
  }

  async function load() {
    const d = await get('/api/my/plan');
    limit = d.limit;
    mount(out, d.tasks.length ? [h('div', { class: 'muted small' }, `لديك ${fmtNum(d.tasks.length)} من أصل ${fmtNum(limit)} وردًا`), ...d.tasks.map(card)] : emptyPlan());
  }

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'خطتي'), h('div', { class: 'muted' }, 'أوراد تضعها لنفسك: اسمها وهدفها ووقتها. تظهر في «وردي اليوم» وتدخل في إحصاءاتك، ولا يراها غيرك.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => openForm(null, null, load) }, icon('plus'), 'ورد جديد'))),
    out);
  await load();
}
