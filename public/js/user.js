import { paintStreak } from './app.js';
import { windowLabel } from './plan.js';
import {
  h, mount, icon, api, get, post, toast, fail, busy, modal, confirmDialog, state, qs, haptic,
  fmtDay, fmtDayShort, fmtDateTime, fmtNum, todayStr, addDaysStr, statusBadge, tickNow, emptyState, STATUS,
} from './core.js';

const go = (hash) => { location.hash = hash; };
const syncClock = (now) => { state.skew = now - Date.now(); };

// ---------- عرض تسجيل (للقراءة) — يستخدمه المشرف أيضاً ----------
export function submissionView(sub, unit = '') {
  return h('div', { class: 'stack' },
    h('div', {}, h('div', { class: 'muted small' }, 'العدد'), h('strong', {}, `${fmtNum(sub.count)} ${unit}`)),
    sub.note ? h('div', {}, h('div', { class: 'muted small' }, 'ملاحظة'), h('div', { style: 'white-space:pre-wrap' }, sub.note)) : null,
    h('div', { class: 'muted small' }, `سُجّل ${fmtDateTime(sub.submitted_at)}`, sub.updated_at > sub.submitted_at ? ` · عُدّل ${fmtDateTime(sub.updated_at)}` : ''));
}

// ---------- بطاقات الأوراد ----------
/** حفظ العدد مع تحديث فوري في الواجهة ثم تأكيد من الخادم */
function makeSaver(x, repaint) {
  let timer = null; let pending = null; let busyNow = false;
  const flush = async () => {
    if (busyNow || pending === null) return;
    const value = pending; pending = null; busyNow = true;
    try {
      await api('POST', '/api/my/submit', { task_id: x.task_id, date: x.date, count: value });
      if (!x.submission) x.submission = { count: value };
      x.submission.count = value;
    } catch (e) { fail(e); x.submission = x._saved ? { ...x._saved } : null; repaint(); }
    finally { busyNow = false; if (pending !== null) flush(); }
  };
  return (value) => {
    x._saved = x.submission ? { ...x.submission } : null;
    x.submission = { ...(x.submission || {}), count: value };
    repaint();
    pending = value;
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
}

const isDone = (x) => !!x.submission && x.submission.count >= (x.target_count || 1);

function goalTrack(x) {
  const c = x.submission?.count ?? 0;
  const pct = x.target_count ? Math.min(100, Math.round((c / x.target_count) * 100)) : (c ? 100 : 0);
  return h('div', { class: 'track', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `تقدّم ${x.title}` }, h('i', { style: `width:${pct}%` }));
}

/** ورد بزر إتمام واحد (أذكار الصباح والمساء، الرقية) */
function checkCard(x, save) {
  const done = isDone(x);
  return h('button', {
    class: 'checkbtn', type: 'button', 'aria-pressed': String(done),
    onclick: () => { haptic(done ? 8 : 18); save(done ? 0 : 1); },
  }, h('span', { class: 'mark' }, done ? icon('check') : null), done ? 'تم بحمد الله' : 'اضغط عند الإتمام');
}

/** عداد: زر كبير للضغط السريع (+الأصغر) وأزرار أكبر، وتثبيت رقم محدد عند الحاجة فقط */
function counterCard(x, save, repaint) {
  const c = x.submission?.count ?? 0;
  const target = x.target_count;
  const steps = target >= 500 ? [1, 10, 100] : target >= 50 ? [1, 5, 10] : [1, 3, 5];
  const bump = (n) => { haptic(n === steps[0] ? 8 : 14); x._bump = true; save(Math.max(0, Math.min(10_000_000, c + n))); };
  const manual = h('input', { class: 'input', type: 'text', inputmode: 'numeric', dir: 'ltr', value: c || '', placeholder: '0', 'aria-label': `عدد ${x.title}` });
  const setExact = () => {
    const v = String(manual.value).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '');
    if (v === '') return repaint();
    x._bump = true;
    save(Math.min(10_000_000, Number(v)));
  };
  manual.addEventListener('focus', (e) => e.target.select());
  manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setExact(); } });
  const edit = h('div', { class: 'edit', hidden: true }, manual, h('button', { class: 'btn sm', type: 'button', onclick: setExact }, 'تثبيت'));
  const toggle = h('button', { class: 'linkbtn editlink', type: 'button', 'aria-expanded': 'false', onclick: () => {
    edit.hidden = !edit.hidden; toggle.setAttribute('aria-expanded', String(!edit.hidden));
    if (!edit.hidden) manual.focus();
  } }, icon('edit'), 'تعديل العدد');
  const bumped = x._bump; x._bump = false;
  return h('div', { class: 'counter' },
    h('div', { class: 'now' }, h('b', { class: bumped ? 'bump' : '' }, fmtNum(c)), target ? h('span', { class: 'of' }, `/ ${fmtNum(target)} ${x.count_unit}`) : h('span', { class: 'of' }, x.count_unit)),
    goalTrack(x),
    h('div', { class: 'steps' },
      ...steps.map((n, i) => h('button', { class: i === 0 ? 'lead' : '', type: 'button', dir: 'ltr', onclick: () => bump(n) }, `+${fmtNum(n)}`)),
      // الزر ثابت الموضع (معطّل عند الصفر) كي لا يتحرك «+1» تحت الإصبع عند الضغط السريع
      h('button', { class: 'minus', type: 'button', 'aria-label': 'إنقاص', disabled: c <= 0, onclick: () => bump(-steps[0]) }, '−')),
    toggle, edit);
}

/** ورد القرآن: الجزء والصفحة التالية وزر «تمت القراءة» */
function pagesCard(x, save, repaint) {
  const m = x.mushaf;
  return h('div', { class: 'stack', style: 'gap:.55rem' },
    m ? h('div', { class: 'mushaf' },
      h('span', { class: 'pill' }, 'الجزء ', h('b', {}, fmtNum(m.juz))),
      h('span', { class: 'pill' }, 'الصفحة ', h('b', {}, fmtNum(m.next_page))),
      m.khatmat ? h('span', { class: 'pill khatmah' }, 'ختمات: ', h('b', {}, fmtNum(m.khatmat))) : null) : null,
    counterCard(x, save, repaint),
    !isDone(x) && x.target_count ? h('button', { class: 'btn primary block', type: 'button', onclick: () => save(x.target_count) }, icon('check'), `تمت قراءة ${fmtNum(x.target_count)} ${x.count_unit}`) : null,
    m ? h('div', { class: 'muted small' }, `المتبقي للختمة: ${fmtNum(m.to_next_khatmah)} صفحة`) : null);
}

// ---------- قارئ النص داخل التطبيق ----------
const READER_SIZES = [1, 1.15, 1.3, 1.5];
function readerSize() { try { return Math.min(READER_SIZES.length - 1, Math.max(0, Number(localStorage.getItem('reader-size')) || 1)); } catch { return 1; } }

/** يعرض نص الورد (مثل برنامج الرقية) في ورقة سفلية بدل الخروج من التطبيق */
function openReader(x) {
  let size = readerSize();
  const text = h('div', { class: 'reader-text' }, x.read_text);
  const apply = () => { text.style.fontSize = `${READER_SIZES[size]}rem`; try { localStorage.setItem('reader-size', String(size)); } catch { /* */ } };
  const step = (d) => { size = Math.min(READER_SIZES.length - 1, Math.max(0, size + d)); apply(); };
  apply();
  modal(x.title, h('div', { class: 'reader' },
    h('div', { class: 'reader-tools' },
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'تصغير الخط', onclick: () => step(-1) }, 'أ−'),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'تكبير الخط', onclick: () => step(1) }, 'أ+')),
    text), { wide: true });
}

function wirdCard(x, onChange) {
  const card = h('article', { class: 'card wird' });
  const repaint = () => {
    const done = isDone(x);
    card.classList.toggle('is-done', done);
    const save = makeSaver(x, () => { repaint(); onChange?.(); });
    mount(card,
      h('div', { class: 'head' },
        h('div', {}, h('div', { class: 'name' }, x.title, x.personal ? h('span', { class: 'mine-tag' }, 'من خطتي') : null),
          windowLabel(x.start_time, x.deadline_time) ? h('div', { class: 'wird-when' }, icon('clock'), windowLabel(x.start_time, x.deadline_time)) : null),
        done ? h('span', { class: 'done-tag' }, '✓ مكتمل') : null),
      x.description ? h('p', { class: 'muted small', style: 'margin:0;white-space:pre-wrap' }, x.description) : null,
      x.read_text || x.link_url ? h('div', { class: 'row' },
        x.read_text ? h('button', { class: 'btn sm', type: 'button', onclick: () => openReader(x) }, icon('book'), 'فتح للقراءة') : null,
        x.link_url ? h('a', { class: 'btn sm', href: x.link_url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), x.read_text ? 'رابط إضافي' : 'فتح للقراءة') : null) : null,
      !x.action ? h('p', { class: 'muted small' }, x.status === 'upcoming' ? 'لم يحن وقته بعد' : 'انتهى وقت اليوم')
        : x.ui === 'check' ? checkCard(x, save)
          : x.ui === 'pages' ? pagesCard(x, save, repaint)
            : counterCard(x, save, repaint));
  };
  repaint();
  return card;
}

// ---------- وردي اليوم ----------
export async function renderToday(root) {
  mount(root, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
  const d = await get('/api/my/today');
  syncClock(d.now);
  paintStreak(d.streak);
  const list = d.today_tasks;
  const regData = await get('/api/my/registrations').catch(() => ({ registrations: [] }));
  const regs = regData.registrations.filter((r) => r.status !== 'cancelled');
  const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: 'UTC' }).format(new Date(d.now + state.tz * 60_000)));
  const greet = hour < 12 ? 'صباح الخير' : hour < 17 ? 'طاب يومك' : 'مساء الخير';

  // الترويسة وحلقة التقدّم تُحسب محلياً لتتحدث فور كل ضغطة
  const hero = h('section', { class: 'today-hero' });
  const firstName = String(d.user.name || '').trim().split(/\s+/)[0];
  function paintProgress() {
    const done = list.filter(isDone).length;
    const ratio = list.reduce((a, x) => a + Math.min(1, (x.submission?.count ?? 0) / (x.target_count || 1)), 0);
    const pct = list.length ? Math.round((ratio / list.length) * 100) : 0;
    const all = list.length > 0 && done === list.length;
    hero.classList.toggle('done', all);
    mount(hero,
      h('div', { class: 'th-text' },
        h('div', { class: 'th-hello' }, `${greet}،`),
        h('h1', { class: 'th-name' }, `${firstName} 🌿`),
        h('div', { class: 'th-date' }, fmtDay(d.today)),
        list.length ? h('div', { class: 'th-note' }, all ? 'أتممت ورد اليوم، بارك الله فيك' : `${fmtNum(done)} من ${fmtNum(list.length)} أوراد مكتملة`) : h('div', { class: 'th-note' }, 'تقبّل الله طاعتك'),
        d.streak ? h('span', { class: 'streak-inline th-streak' }, '🔥', `${fmtNum(d.streak)} ${d.streak === 1 ? 'يوم' : 'يوماً'} متتالياً`) : null),
      list.length ? h('div', { class: 'ring', style: `--p:${pct}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'إنجاز ورد اليوم' },
        h('b', {}, `${fmtNum(pct)}%`)) : null);
  }
  paintProgress();

  mount(root,
    hero,

    regsPanel(regs, !!d.locked),

    d.message ? h('section', { class: 'verse-card', role: 'note' },
      h('div', { class: 'txt' }, d.message.text),
      d.message.source ? h('div', { class: 'src' }, d.message.source) : null) : null,

    d.locked ? null : list.length ? h('div', { class: 'wirds' }, list.map((x) => wirdCard(x, paintProgress)))
      : emptyState('لا أوراد لك اليوم. ستظهر هنا أوراد الإدارة، ويمكنك أن تضيف أوراداً خاصة بك.', 'inbox'),
    d.locked ? null : h('a', { class: 'btn block planlink', href: '#/plan' }, icon('plus'), list.some((x) => x.personal) ? 'إدارة خطتي' : 'أضف وردك الخاص إلى خطتي'));
  tickNow();
}

/** لوحة «متابعتي»: حالة طلبات التسجيل في الدورات (بانتظار المراجعة، تم التفعيل، مرفوض بسبب) */
function regsPanel(regs, locked) {
  const cls = { confirmed: 's-on_time', rejected: 's-missed', pending: 's-open' };
  if (!regs.length) {
    return locked ? h('section', { class: 'card stack', 'aria-label': 'متابعتي' }, h('h3', { style: 'margin:0' }, 'متابعتي'),
      emptyState('لا اشتراكات بعد. اشترك في دورة لتُفتح لك لوحة المتابعة.', 'inbox'),
      h('a', { class: 'btn primary', href: '#/site/courses' }, 'الدورات المتاحة')) : null;
  }
  return h('section', { class: 'card stack', 'aria-label': 'متابعتي' },
    h('h3', { style: 'margin:0' }, locked ? 'متابعتي' : 'دوراتي'),
    locked ? h('p', { class: 'muted', style: 'margin:0' }, 'تُفتح لك قائمة الأعمال اليومية فور أن تراجع الإدارة إيصالك بإذن الله.') : null,
    regs.map((x) => h('div', { class: 'stack', style: 'gap:.4rem;padding-top:.6rem;border-top:1px solid var(--line)' },
      h('div', { class: 'row between' }, h('strong', {}, x.title), h('span', { class: `badge ${cls[x.status] || 's-open'}` }, x.status_label)),
      x.status === 'rejected' ? h('div', { class: 'err' }, `سبب الرفض: ${x.reject_reason}`) : null,
      x.status === 'rejected' ? h('a', { class: 'btn sm', href: `#/site/register?c=${x.course_id}` }, 'رفع إيصال جديد') : null,
      x.whatsapp_link ? h('a', { class: 'btn sm', href: x.whatsapp_link, target: '_blank', rel: 'noopener noreferrer' }, 'مجتمع واتساب للدورة') : null)));
}

// ---------- سجلي ----------
export async function renderHistory(root) {
  const today = todayStr();
  const from = h('input', { class: 'input', type: 'date', value: addDaysStr(today, -30), 'aria-label': 'من' });
  const to = h('input', { class: 'input', type: 'date', value: today, 'aria-label': 'إلى' });
  const status = h('select', { class: 'input', 'aria-label': 'الحالة' }, h('option', { value: '' }, 'كل الحالات'),
    ['on_time', 'missed'].map((s) => h('option', { value: s }, STATUS[s][0])));
  const out = h('div', { class: 'stack' });
  async function load() {
    mount(out, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
    try {
      const d = await get('/api/my/history' + qs({ from: from.value, to: to.value }));
      const items = d.items.filter((x) => !status.value || x.status === status.value);
      mount(out, items.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't stackable hist' },
        h('thead', {}, h('tr', {}, ['التاريخ', 'الورد', 'العدد', 'الحالة'].map((t) => h('th', {}, t)))),
        h('tbody', {}, items.map((x) => h('tr', {},
          h('td', { 'data-l': 'التاريخ', class: 'nowrap' }, fmtDayShort(x.date)),
          h('td', { 'data-l': 'الورد' }, x.title),
          h('td', { 'data-l': 'العدد', class: 'num nowrap' }, x.submission ? `${fmtNum(x.submission.count)} ${x.count_unit}${x.target_count && x.submission.count >= x.target_count ? ' ✓' : ''}` : '—'),
          h('td', {}, statusBadge(x.status))))))) : emptyState('لا سجلات في هذه الفترة', 'history'));
    } catch (e) { fail(e); mount(out, ''); }
  }
  for (const el of [from, to, status]) el.addEventListener('change', load);
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'سجلي')),
    h('div', { class: 'card', style: 'margin-bottom:1rem' }, h('div', { class: 'grid g3 filters' },
      h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, 'من'), from),
      h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, 'إلى'), to),
      h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, 'الحالة'), status))),
    out);
  load();
}

// ---------- حسابي ----------
export async function renderAccount(root, refreshUser) {
  const u = state.user;
  const { sessions } = await get('/api/auth/sessions');
  const pinBox = h('div');
  function paintPin() {
    mount(pinBox,
      h('p', { class: 'muted' }, u.has_pin ? 'الرمز السري مفعّل للدخول السريع.' : 'اختياري: عيّن رمزاً سرياً للدخول السريع دون انتظار رسالة واتساب.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: pinDialog }, u.has_pin ? 'تغيير الرمز السري' : 'تعيين رمز سري'),
        u.has_pin ? h('button', { class: 'btn danger', onclick: removePin }, 'إلغاء الرمز السري') : null));
  }
  function pinDialog() {
    const cur = u.has_pin ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password' }) : null;
    const pin = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 4 });
    const err = h('div', { class: 'err', hidden: true });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      try { await post('/api/auth/pin', { pin: pin.value, current: cur?.value }); u.has_pin = true; toast('تم حفظ الرمز السري', 'ok'); m.close(); paintPin(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ');
    const m = modal('الرمز السري', h('div', {}, cur ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'الرمز الحالي'), cur) : null,
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'الرمز الجديد (4 أحرف فأكثر)'), pin), err, h('div', { class: 'mf' }, save)));
  }
  function removePin() {
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const err = h('div', { class: 'err', hidden: true });
    const ok = h('button', { class: 'btn danger', onclick: () => busy(ok, async () => {
      try { await post('/api/auth/pin', { pin: null, current: cur.value }); u.has_pin = false; toast('تم إلغاء الرمز السري', 'ok'); m.close(); paintPin(); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'إلغاء الرمز السري');
    const m = modal('إلغاء الرمز السري', h('div', {}, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'أدخل الرمز الحالي للتأكيد'), cur), err, h('div', { class: 'mf' }, ok)));
  }
  function phoneDialog() {
    const phone = h('input', { class: 'input', type: 'tel', dir: 'ltr', placeholder: '+968 9X XXX XXX' });
    const code = h('input', { class: 'input otp-input', inputmode: 'numeric', maxlength: 6, hidden: true });
    const err = h('div', { class: 'err', hidden: true });
    const dev = h('div', { class: 'dev-banner', hidden: true });
    let step = 1;
    const btn = h('button', { class: 'btn primary', onclick: () => busy(btn, async () => {
      err.hidden = true;
      try {
        if (step === 1) {
          const r = await post('/api/auth/change-phone/request', { phone: phone.value });
          step = 2; phone.disabled = true; code.hidden = false; code.focus(); btn.textContent = 'تأكيد التغيير';
          if (r.dev_code) { dev.hidden = false; dev.textContent = 'وضع التجربة: الرمز ' + r.dev_code; }
        } else {
          const r = await post('/api/auth/change-phone/confirm', { phone: phone.value, code: code.value });
          u.phone = r.phone; toast('تم تغيير رقم الهاتف', 'ok'); m.close(); refreshUser();
        }
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'إرسال رمز التحقق');
    const m = modal('تغيير رقم الهاتف', h('div', {}, h('p', { class: 'muted' }, 'اكتب الرقم الجديد بصيغة دولية (مثل +96891234567). سنرسل رمز تحقق إلى الرقم الجديد.'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'الرقم الجديد'), phone), dev, code, err, h('div', { class: 'mf' }, btn)));
  }
  paintPin();
  const prefs = u.prefs || { wa_notify: true, quiet_start: '22:00', quiet_end: '07:00' };
  const waOn = h('input', { type: 'checkbox', checked: prefs.wa_notify });
  const quietOn = h('input', { type: 'checkbox', checked: !!(prefs.quiet_start && prefs.quiet_end) });
  const qStart = h('input', { class: 'input', type: 'time', value: prefs.quiet_start || '22:00', style: 'max-width:150px' });
  const qEnd = h('input', { class: 'input', type: 'time', value: prefs.quiet_end || '07:00', style: 'max-width:150px' });
  const quietRow = h('div', { class: 'row' }, h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, 'من'), qStart), h('label', { class: 'field', style: 'margin:0' }, h('span', { class: 'lbl' }, 'إلى'), qEnd));
  const syncQuiet = () => { quietRow.hidden = !quietOn.checked || !waOn.checked; quietOn.parentElement.hidden = !waOn.checked; rtime.closest('.field').hidden = !waOn.checked; };
  waOn.addEventListener('change', syncQuiet); quietOn.addEventListener('change', syncQuiet);
  const savePrefs = h('button', { class: 'btn primary', onclick: () => busy(savePrefs, async () => {
    const r = await api('PATCH', '/api/auth/prefs', { wa_notify: waOn.checked, quiet_start: quietOn.checked ? qStart.value : null, quiet_end: quietOn.checked ? qEnd.value : null, reminder_time: rtime.value || null });
    u.prefs = r.prefs; toast('تم حفظ تفضيلات الإشعارات', 'ok');
  }) }, 'حفظ');
  const rtime = h('input', { class: 'input', type: 'time', value: prefs.reminder_time || '', style: 'max-width:150px' });
  const notifyCard = h('div', { class: 'card stack' }, h('h3', {}, 'الإشعارات والتذكير'),
    h('p', { class: 'muted small' }, 'تصلك الإشعارات داخل المنصة دائماً (الجرس). يمكنك أيضاً استلام قرارات الإدارة على مواضيعك عبر واتساب.'),
    h('label', { class: 'check' }, waOn, 'استلام إشعارات واتساب'),
    h('label', { class: 'check' }, quietOn, 'ساعات الهدوء: لا ترسل لي واتساب خلال هذه الفترة'), quietRow,
    h('hr', { class: 'hr' }),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'وقت التذكير المفضل'), rtime,
      h('div', { class: 'hint' }, 'يصلك تذكير واحد عبر واتساب في هذا الوقت بما تبقّى من أورادك. اتركه فارغاً للاكتفاء بتذكيرات الإدارة.')),
    h('div', {}, savePrefs));
  syncQuiet();
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'حسابي')),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('h3', {}, u.name), h('div', { class: 'ltr muted', style: 'margin-bottom:.8rem' }, u.phone),
        h('button', { class: 'btn', onclick: phoneDialog }, 'تغيير رقم الهاتف')),
      h('div', { class: 'card' }, h('h3', {}, 'الدخول السريع'), pinBox),
      notifyCard,
      h('div', { class: 'card' }, h('h3', {}, 'الأجهزة المسجّلة'),
        h('ul', { class: 'list-plain' }, sessions.map((s) => h('li', { class: 'row between', style: 'padding:.4rem 0;border-bottom:1px solid var(--line)' },
          h('span', { class: 'small' }, (s.user_agent || 'جهاز غير معروف').slice(0, 60), s.current ? ' (هذا الجهاز)' : ''), h('span', { class: 'muted small' }, fmtDateTime(s.created_at))))),
        h('button', { class: 'btn danger', style: 'margin-top:.8rem', onclick: async () => {
          if (await confirmDialog('سيتم تسجيل خروجك من جميع الأجهزة بما فيها هذا الجهاز.', { okText: 'تسجيل الخروج من الكل', danger: true })) {
            await post('/api/auth/logout-all'); location.reload();
          }
        } }, 'تسجيل الخروج من كل الأجهزة'))));
}
