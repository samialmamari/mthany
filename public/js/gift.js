import { h, mount, get, post, toast, state, fail, busy } from './core.js';
import { shell, paymentBox, dateRange, loading } from './site.js';

/**
 * الإهداء: معالج من 4 خطوات للمُهدي، وصفحة استلام للمُهدى إليه، و«هداياي» داخل الحساب.
 * بلا نوافذ منبثقة ولا حركات؛ زر رئيسي واحد في كل شاشة.
 */
const NEXT_KEY = 'mathani_next';
export const setNext = (hash) => { try { sessionStorage.setItem(NEXT_KEY, hash); } catch { /* تصفح خاص */ } };
export const takeNext = () => { try { const v = sessionStorage.getItem(NEXT_KEY); sessionStorage.removeItem(NEXT_KEY); return v; } catch { return null; } };

const STATUS_CLASS = { pending: 's-open', sent: 's-on_time', received: 's-on_time', rejected: 's-missed', declined: 's-missed', transfer_requested: 's-open' };
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));

// ------------------------------------------------------------------ بطاقة الإهداء
/** card = { from, to, message, theme, course: { title, start_date, end_date, time_label, remote } } */
export function giftCard(card) {
  const c = card.course;
  return h('article', { class: `g-card g-${card.theme || 'green'}`, 'aria-label': 'بطاقة إهداء' },
    h('div', { class: 'g-logo' }, h('img', { src: '/img/logo.png', alt: 'مثاني' })),
    h('div', { class: 'g-kicker' }, 'هدية من مثاني'),
    h('h2', { class: 'g-title' }, c.title),
    h('div', { class: 'g-fromto' },
      h('div', {}, h('small', {}, 'من'), h('strong', {}, card.from)),
      h('div', {}, h('small', {}, 'إلى'), h('strong', {}, card.to))),
    card.message ? h('blockquote', { class: 'g-msg' }, card.message) : null,
    h('div', { class: 'g-meta' },
      c.start_date ? h('span', {}, `🗓️ ${dateRange(c.start_date, c.end_date)}`) : null,
      c.time_label ? h('span', {}, `🕗 ${c.time_label}`) : null,
      c.remote ? h('span', {}, '💻 عن بُعد') : null));
}

const THEMES = {
  green: { bg: ['#0f5c55', '#0a3f42'], ink: '#ffffff', accent: '#e0a47c', soft: 'rgba(255,255,255,.14)' },
  peach: { bg: ['#e9b48f', '#d28d62'], ink: '#2c1a0e', accent: '#0f5c55', soft: 'rgba(255,255,255,.35)' },
  sand: { bg: ['#fbf7ee', '#efe6d2'], ink: '#1e2b2a', accent: '#b9703f', soft: 'rgba(15,92,85,.08)' },
};

function wrapLines(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

/** يرسم البطاقة على canvas (بلا مكتبات) ويُرجع Blob لصورة PNG */
async function cardBlob(card) {
  const t = THEMES[card.theme] || THEMES.green;
  const W = 1080; const H = 1350; const PAD = 90;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  try { await document.fonts.load('700 40px Tajawal'); await document.fonts.load('400 40px Tajawal'); } catch { /* الخط الاحتياطي */ }
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, t.bg[0]); g.addColorStop(1, t.bg[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.direction = 'rtl'; ctx.textAlign = 'center'; ctx.fillStyle = t.ink;
  const font = (w, px) => { ctx.font = `${w} ${px}px Tajawal, "Noto Sans Arabic", Tahoma, sans-serif`; };

  // الشعار على قاعدة خضراء ليبقى ظاهراً مع كل الألوان
  ctx.fillStyle = '#0f5c55'; ctx.beginPath(); ctx.roundRect((W - 300) / 2, 70, 300, 150, 28); ctx.fill();
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = '/img/logo.png'; });
    const lh = 100; const lw = (img.width / img.height) * lh; ctx.drawImage(img, (W - lw) / 2, 95, lw, lh);
  } catch { /* بلا شعار */ }

  let y = 310;
  ctx.fillStyle = t.accent; font(700, 40); ctx.fillText('هدية من مثاني', W / 2, y); y += 90;
  ctx.fillStyle = t.ink; font(700, 64);
  for (const line of wrapLines(ctx, card.course.title, W - PAD * 2)) { ctx.fillText(line, W / 2, y); y += 90; }
  y += 20;
  ctx.fillStyle = t.soft; ctx.beginPath(); ctx.roundRect(PAD, y, W - PAD * 2, 150, 24); ctx.fill();
  ctx.fillStyle = t.ink; font(400, 34); ctx.fillText('من', W * 0.7, y + 55); ctx.fillText('إلى', W * 0.3, y + 55);
  font(700, 46); ctx.fillText(card.from, W * 0.7, y + 115); ctx.fillText(card.to, W * 0.3, y + 115);
  y += 230;
  if (card.message) {
    font(400, 42); ctx.fillStyle = t.ink;
    for (const line of wrapLines(ctx, `«${card.message}»`, W - PAD * 2).slice(0, 8)) { ctx.fillText(line, W / 2, y); y += 66; }
  }
  const meta = [card.course.start_date && `🗓 ${dateRange(card.course.start_date, card.course.end_date)}`, card.course.time_label && `🕗 ${card.course.time_label}`, card.course.remote && '💻 عن بُعد'].filter(Boolean);
  font(400, 36); ctx.fillStyle = t.accent;
  let my = H - 110 - (meta.length - 1) * 56;
  for (const m of meta) { ctx.fillText(m, W / 2, my); my += 56; }
  return new Promise((ok) => cv.toBlob(ok, 'image/png'));
}

/** أزرار حفظ البطاقة كصورة ومشاركتها */
export function cardActions(card, name = 'بطاقة-إهداء-مثاني') {
  const save = async (share) => {
    const blob = await cardBlob(card);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'err'); return; }
    const file = new File([blob], `${name}.png`, { type: 'image/png' });
    if (share && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'هدية من مثاني' }); return; } catch { return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return h('div', { class: 's-row g-actions' },
    h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: (e) => busy(e.currentTarget, () => save(false)) }, '⬇️ حفظ كصورة'),
    typeof navigator.canShare === 'function' ? h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: (e) => busy(e.currentTarget, () => save(true)) }, '📤 مشاركة') : null);
}

// ------------------------------------------------------------------ مساعدات الصفحات
const gate = (root, title, text, ret) => shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow' }, h('div', { class: 's-card', style: 'text-align:center' },
  h('div', { class: 's-done-ic' }, '🎁'), h('h2', {}, title), h('p', {}, text),
  h('div', { class: 's-row', style: 'margin-top:1.2rem' },
    h('a', { class: 's-btn s-btn-peach', href: '#/register', onclick: () => setNext(ret) }, 'إنشاء حساب سريع'),
    h('a', { class: 's-btn s-btn-ghost', href: '#/login', onclick: () => setNext(ret) }, 'لدي حساب'))))));

const stepsBar = (n, total, label) => h('div', { class: 'g-steps', role: 'group', 'aria-label': `الخطوة ${n} من ${total}` },
  h('div', { class: 'g-steps-top' }, h('strong', {}, `الخطوة ${n} من ${total}`), h('span', {}, label)),
  h('div', { class: 'g-bar', role: 'progressbar', 'aria-valuenow': n, 'aria-valuemin': 1, 'aria-valuemax': total }, h('i', { style: `width:${(n / total) * 100}%` })));

const pageHead = (title, sub) => h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
  h('a', { class: 's-back', href: '#/site/courses' }, '→ الدورات'), h('h1', {}, title), sub ? h('p', {}, sub) : null));

// ------------------------------------------------------------------ معالج الإهداء (4 خطوات)
export async function renderGift(root, query) {
  if (!state.user) { gate(root, 'أنشئ حسابك أولاً', 'لتُهدي دورة تحتاج حساباً بسيطاً، لتتابع هديتك وتعرف متى استُلمت.', `#/gift${query.get('c') ? `?c=${query.get('c')}` : ''}`); return; }
  shell(root, '#/gift', loading());
  let o;
  try { o = await get('/api/gifts/options'); } catch (e) { fail(e); return; }
  const { countries: list, default: def } = await get('/api/auth/countries');
  const sorted = [...list].sort((a, b) => (a.code === def ? -1 : b.code === def ? 1 : 0));

  const st = { course: o.courses.find((c) => c.id === Number(query.get('c'))) || null, name: '', mode: 'whatsapp', contact: '', country: def, message: o.defaults.message, anonymous: false };
  const TOTAL = 4;
  const body = h('div', { class: 's-card' });
  const err = h('p', { class: 's-err', role: 'alert', hidden: true });
  const fail_ = (m) => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'center' }); };
  const nav = (step) => { err.hidden = true; ({ 1: step1, 2: step2, 3: step3, 4: step4 })[step](); window.scrollTo(0, 0); };

  function step1() {
    if (st.course) { /* مختارة من صفحة الدورة */ }
    const cards = o.courses.map((c) => h('label', { class: 'g-course' },
      h('input', { type: 'radio', name: 'course', value: c.id, checked: st.course?.id === c.id, onchange: () => { st.course = c; } }),
      h('span', {}, h('strong', {}, c.title), h('small', {}, [c.start_date && dateRange(c.start_date, c.end_date), c.price].filter(Boolean).join(' · ')))));
    mount(body, stepsBar(1, TOTAL, 'اختيار الدورة'), cards.length ? h('div', { class: 'g-courses', role: 'radiogroup', 'aria-label': 'الدورة' }, cards) : h('p', { class: 's-empty' }, 'لا دورات متاحة للإهداء حالياً.'), err,
      h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'button', disabled: !cards.length, onclick: () => (st.course ? nav(2) : fail_('اختر الدورة التي تريد إهداءها')) }, 'التالي'));
  }

  function step2() {
    const name = h('input', { class: 's-input', maxlength: 80, value: st.name, placeholder: 'الاسم', autocomplete: 'off' });
    const phone = h('input', { class: 's-input', type: 'tel', dir: 'ltr', inputmode: 'tel', value: st.mode === 'whatsapp' ? st.contact : '', placeholder: '9X XXX XXX' });
    const email = h('input', { class: 's-input', type: 'email', dir: 'ltr', value: st.mode === 'email' ? st.contact : '', placeholder: 'name@example.com' });
    const country = h('select', { class: 's-input', 'aria-label': 'رمز الدولة' }, sorted.map((c) => h('option', { value: c.code, selected: c.code === st.country }, `${flag(c.code)} ${c.dial}  ${c.name}`)));
    const contactBox = h('div');
    const paint = () => mount(contactBox, st.mode === 'whatsapp'
      ? h('label', { class: 's-field' }, h('span', {}, 'رقم الواتساب'), h('div', { class: 's-phone' }, country, phone), h('small', {}, 'ستصله بطاقة الإهداء على هذا الرقم.'))
      : h('label', { class: 's-field' }, h('span', {}, 'البريد الإلكتروني'), email));
    const choice = (v, label) => h('label', { class: 's-choice' }, h('input', { type: 'radio', name: 'mode', checked: st.mode === v, onchange: () => { st.mode = v; paint(); } }), h('span', {}, label));
    paint();
    mount(body, stepsBar(2, TOTAL, 'المُهدى إليه'),
      h('label', { class: 's-field' }, h('span', {}, 'اسم المُهدى إليه'), name),
      h('div', { class: 's-field' }, h('span', {}, 'نصله عبر'), h('div', { class: 's-choices', role: 'radiogroup', 'aria-label': 'طريقة الوصول' }, choice('whatsapp', 'واتساب'), choice('email', 'البريد'))),
      contactBox, err,
      h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'button', onclick: () => {
        st.name = name.value.trim(); st.contact = (st.mode === 'whatsapp' ? phone : email).value.trim(); st.country = country.value;
        if (st.name.length < 3) return fail_('اكتب اسم المُهدى إليه');
        if (!st.contact) return fail_(st.mode === 'whatsapp' ? 'اكتب رقم الواتساب' : 'اكتب البريد الإلكتروني');
        nav(3);
      } }, 'التالي'),
      h('button', { class: 's-btn s-btn-ghost s-btn-block', style: 'margin-top:.6rem', type: 'button', onclick: () => nav(1) }, 'السابق'));
    name.focus();
  }

  function step3() {
    const msg = h('textarea', { class: 's-input', rows: 4, maxlength: 400 }, st.message);
    const prev = h('div');
    const paintPrev = () => mount(prev, giftCard({ from: st.anonymous ? 'محب' : state.user.name, to: st.name, message: msg.value, theme: o.defaults.theme, course: { ...st.course, remote: true } }));
    msg.addEventListener('input', paintPrev);
    const choice = (v, label) => h('label', { class: 's-choice' }, h('input', { type: 'radio', name: 'anon', checked: st.anonymous === v, onchange: () => { st.anonymous = v; paintPrev(); } }), h('span', {}, label));
    paintPrev();
    mount(body, stepsBar(3, TOTAL, 'الرسالة'),
      h('label', { class: 's-field' }, h('span', {}, 'رسالة الإهداء'), msg, h('small', {}, 'نص جاهز يمكنك تعديله كما تشاء.')),
      h('div', { class: 's-field' }, h('span', {}, 'الاسم الذي يظهر على البطاقة'),
        h('div', { class: 's-choices', role: 'radiogroup', 'aria-label': 'الاسم' }, choice(false, 'باسمي'), choice(true, 'من محب'))),
      h('p', { class: 's-note' }, '⏱️ تُرسل الهدية فور قبول الإدارة لإيصالك.'),
      h('div', { class: 'g-preview' }, h('small', {}, 'هكذا ستبدو بطاقتك'), prev), err,
      h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'button', onclick: () => { st.message = msg.value.trim(); if (!st.message) return fail_('اكتب رسالة الإهداء'); nav(4); } }, 'التالي'),
      h('button', { class: 's-btn s-btn-ghost s-btn-block', style: 'margin-top:.6rem', type: 'button', onclick: () => { st.message = msg.value; nav(2); } }, 'السابق'));
  }

  function step4() {
    const c = st.course;
    const pay = c.price_minor > 0 ? paymentBox(c.payment, c.price) : null;
    const btn = h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'button' }, 'إتمام الإهداء');
    const sync = () => { btn.disabled = pay ? !(pay.ready && pay.file()) : false; };
    pay?.onChange(sync); sync();
    btn.addEventListener('click', () => busy(btn, async () => {
      err.hidden = true;
      try {
        const fd = new FormData();
        fd.append('course_id', c.id); fd.append('recipient_name', st.name); fd.append('recipient_contact', st.contact); fd.append('country', st.country);
        fd.append('message', st.message); fd.append('anonymous', st.anonymous ? '1' : '0');
        if (pay) { const f = pay.file(); if (!f) throw new Error('ارفع إيصال التحويل لإتمام الإهداء'); fd.append('receipt', f); }
        const r = await post('/api/gifts', fd);
        thanks(r.dua);
      } catch (ex) { fail_(ex.message); sync(); }
    }));
    mount(body, stepsBar(4, TOTAL, 'الدفع'),
      h('dl', { class: 's-facts' },
        h('div', {}, h('dt', {}, '🎁 الدورة'), h('dd', {}, c.title)),
        h('div', {}, h('dt', {}, '👤 إلى'), h('dd', {}, st.name)),
        h('div', {}, h('dt', {}, '💳 المبلغ'), h('dd', {}, c.price))),
      pay ? pay.node : h('p', { class: 's-account' }, 'هذه الدورة مجانية، لا حاجة لإيصال.'), err, btn,
      h('button', { class: 's-btn s-btn-ghost s-btn-block', style: 'margin-top:.6rem', type: 'button', onclick: () => nav(3) }, 'السابق'));
  }

  function thanks(dua) {
    shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-done' },
      h('div', { class: 's-done-ic' }, '🌿'),
      h('h1', {}, 'جزاك الله خيراً على إهدائك'),
      dua ? h('blockquote', { class: 's-dua' }, dua) : null,
      h('p', {}, 'سنراجع الإيصال ثم نرسل البطاقة إلى المُهدى إليه. تتابع حالة هديتك في «هداياي».'),
      h('div', { class: 's-row', style: 'margin-top:1.2rem' },
        h('a', { class: 's-btn s-btn-peach', href: '#/gifts' }, 'هداياي'),
        h('a', { class: 's-btn s-btn-ghost', href: '#/site/courses' }, 'كل الدورات')))));
  }

  shell(root, '#/gift', [pageHead('أهدِ دورة', 'مقعد في رحلة نور وشفاء لمن تحب.'), h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow' }, body))]);
  nav(st.course ? 2 : 1);
}

// ------------------------------------------------------------------ صفحة استلام الهدية (المُهدى إليه)
export async function renderGiftClaim(root, token) {
  shell(root, '#/gift', loading());
  let v;
  try { v = await get(`/api/gifts/claim/${token}`); }
  catch { shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow s-done' }, h('div', { class: 's-done-ic' }, '🤍'), h('h2', {}, 'رابط الهدية غير صحيح'), h('p', {}, 'تأكد من الرابط الذي وصلك، أو تواصل مع الإدارة.')))); return; }

  const info = (icon, title, text) => shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow s-done' }, h('div', { class: 's-done-ic' }, icon), h('h2', {}, title), h('p', {}, text),
    state.user ? h('a', { class: 's-btn s-btn-peach', href: '#/my' }, 'لوحة متابعتي') : h('a', { class: 's-btn s-btn-peach', href: '#/login', onclick: () => setNext('#/my') }, 'دخول'))));
  if (v.state === 'used') return info('✅', 'استُلمت هذه الهدية', 'رابط الهدية يُستعمل مرة واحدة فقط. إن كنت أنت من استلمها فادخل إلى حسابك.');
  if (v.state === 'declined') return info('🤍', 'تم الاعتذار عن هذه الهدية', 'ستتواصل الإدارة مع المُهدي لتحويلها.');
  if (v.state === 'expired') return info('⏳', 'انتهت صلاحية رابط الهدية', 'يصلح الرابط حتى بداية الدورة. تواصل مع الإدارة وسنعينك.');
  if (v.state === 'transfer_requested') return info('🕊️', 'طلب التحويل قيد المراجعة', 'ستراجع الإدارة طلبك وتصل الهدية إلى من اخترته.');
  if (v.state !== 'ok') return info('🤍', 'هذه الهدية غير متاحة', 'تواصل مع الإدارة إن كنت تظن أن هذا خطأ.');

  const err = h('p', { class: 's-err', role: 'alert', hidden: true });
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  const claim = h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'button' }, '🎁 استلم هديتك');
  claim.addEventListener('click', () => busy(claim, async () => {
    err.hidden = true;
    try {
      const r = await post(`/api/gifts/claim/${token}/claim`);
      try { state.user = (await get('/api/auth/me')).user; } catch { /* */ }
      shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-done' },
        h('div', { class: 's-done-ic' }, '🌿'), h('h1', {}, 'تم استلام هديتك'),
        h('p', {}, `أُضيفت «${r.course.title}» إلى حسابك، وفُتحت لك لوحة المتابعة.`),
        v.card.dua ? h('blockquote', { class: 's-dua' }, v.card.dua) : null,
        r.whatsapp_link ? h('div', { class: 's-wa' }, h('p', {}, 'انضم إلى مجتمع واتساب الخاص بالدورة:'), h('a', { class: 's-btn s-btn-green', href: r.whatsapp_link, target: '_blank', rel: 'noopener noreferrer' }, '💬 مجتمع الدورة على واتساب')) : null,
        h('div', { class: 's-row', style: 'margin-top:1.2rem' }, h('a', { class: 's-btn s-btn-peach', href: '#/my' }, 'لوحة متابعتي')))));
    } catch (ex) { showErr(ex.message); }
  }));

  const guestActions = h('div', { class: 'stack' },
    h('p', { class: 's-note', style: 'text-align:center' }, 'أنشئ حسابك لتُربط الدورة به وتُفتح لك لوحة المتابعة مباشرة.'),
    h('a', { class: 's-btn s-btn-peach s-btn-block', href: '#/register', onclick: () => setNext(`#/gift/${token}`) }, 'إنشاء حساب لاستلام الهدية'),
    h('a', { class: 's-btn s-btn-ghost s-btn-block', href: '#/login', onclick: () => setNext(`#/gift/${token}`) }, 'لدي حساب'));

  // اعتذار أو تحويل لشخص آخر بموافقة الإدارة (بلا نوافذ منبثقة)
  const tName = h('input', { class: 's-input', maxlength: 80, placeholder: 'اسم الشخص' });
  const tContact = h('input', { class: 's-input', dir: 'ltr', placeholder: 'رقم واتساب أو بريد' });
  const done = (msg) => shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow s-done' }, h('div', { class: 's-done-ic' }, '🕊️'), h('h2', {}, msg))));
  const more = h('div', { class: 'g-more' },
    h('details', {}, h('summary', {}, 'تحويل الهدية لشخص آخر'),
      h('p', { class: 's-note' }, 'يتم التحويل بعد موافقة الإدارة.'),
      h('label', { class: 's-field' }, h('span', {}, 'الاسم'), tName), h('label', { class: 's-field' }, h('span', {}, 'واتساب أو بريد'), tContact),
      h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
        try { await post(`/api/gifts/claim/${token}/transfer`, { name: tName.value, contact: tContact.value }); done('أرسلنا طلب التحويل إلى الإدارة'); } catch (ex) { showErr(ex.message); }
      }) }, 'إرسال طلب التحويل')),
    h('details', {}, h('summary', {}, 'الاعتذار عن الاستلام'),
      h('p', { class: 's-note' }, 'سنبلغ الإدارة لتتواصل مع المُهدي بلطف.'),
      h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
        try { await post(`/api/gifts/claim/${token}/decline`); done('تم تسجيل اعتذارك، جزاك الله خيراً'); } catch (ex) { showErr(ex.message); }
      }) }, 'تأكيد الاعتذار')));

  shell(root, '#/gift', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow stack' },
    h('p', { class: 's-claim-lead' }, 'وصلتك هدية 🤍'),
    giftCard(v.card), cardActions(v.card), err,
    state.user ? claim : guestActions, more)));
}

// ------------------------------------------------------------------ هداياي (داخل حساب المُهدي)
export async function renderMyGifts(page) {
  mount(page, h('div', { class: 'boot' }, 'جارٍ التحميل…'));
  const d = await get('/api/gifts/mine');
  const head = h('div', { class: 'page-head' }, h('h1', {}, 'هداياي'), h('a', { class: 'btn primary', href: '#/gift' }, 'أهدِ دورة'));
  if (!d.gifts.length) { mount(page, head, h('div', { class: 'empty' }, h('div', {}, 'لم تُهدِ دورة بعد.'), h('p', { class: 'muted' }, 'اهدِ مقعداً في رحلة نور وشفاء لمن تحب.'))); return; }
  mount(page, head, h('div', { class: 'stack' }, d.gifts.map((g) => {
    const file = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', 'aria-label': 'إيصال جديد' });
    const resubmit = h('button', { class: 'btn primary sm', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
      if (!file.files[0]) return toast('اختر ملف الإيصال أولاً', 'err');
      const fd = new FormData(); fd.append('receipt', file.files[0]);
      try { await post(`/api/gifts/${g.id}/resubmit`, fd); toast('أُرسل الإيصال للمراجعة', 'ok'); renderMyGifts(page); } catch (ex) { fail(ex); }
    }) }, 'رفع الإيصال');
    return h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('strong', {}, g.course_title), h('span', { class: `badge ${STATUS_CLASS[g.status] || 's-open'}` }, g.status_label)),
      h('div', { class: 'muted' }, `إلى: ${g.recipient_name}${g.anonymous ? ' · من محب' : ''}`),
      g.status === 'rejected' ? h('div', { class: 'stack' }, h('div', { class: 'err' }, `سبب الرفض: ${g.reject_reason}`), g.needs_receipt ? [file, resubmit] : null) : null,
      g.status === 'sent' ? h('div', { class: 'muted small' }, 'أُرسلت البطاقة، وبانتظار أن يستلمها.') : null,
      g.link ? h('div', { class: 'row', style: 'gap:.5rem;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(g.link); toast('نُسخ رابط الهدية', 'ok'); } catch { toast(g.link, 'ok'); } } }, 'نسخ رابط الهدية')) : null);
  })));
}
