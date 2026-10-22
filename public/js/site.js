import { h, mount, get, post, fail, toast, state } from './core.js';

/**
 * الموقع التعريفي العام (قبل تسجيل الدخول): شريط علوي وتذييل وصفحات ثابتة.
 * هادئ ومباشر: لا نوافذ منبثقة ولا حركات ولا شرائح متحركة.
 */
const NAV = [
  ['#/site', 'الرئيسية'],
  ['#/site/about', 'عن الدورة'],
  ['#/site/courses', 'التسجيل'],
  ['#/gift', 'الإهداء'],
];
const REG_LINKS = [
  ['#/site/courses', 'دورات عن بُعد'],
  ['#/site/year-plan', 'خطة العام'],
  ['#/site/membership', 'العضوية الدائمة'],
  ['#/site/retreats', 'الخلوات الحضورية'],
];

const fmtDate = (d) => (d ? new Intl.DateTimeFormat('ar-OM-u-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(`${d}T00:00:00Z`)) : '');
export const dateRange = (a, b) => (a && b && a !== b ? `${fmtDate(a)} — ${fmtDate(b)}` : fmtDate(a));

/** للمسجَّل دخوله: يُشترك باسمه ورقمه المحفوظَين في حسابه */
const accountNote = () => h('p', { class: 's-account' }, '✓ سيُسجَّل اشتراكك باسم ', h('strong', {}, state.user.name), ' — بيانات حسابك، فلا حاجة لكتابتها.');

/** صندوق «طريقة الدفع»: رقم التحويل مع نسخ، خطوات مختصرة، ورفع الإيصال مع معاينته */
export function paymentBox(payment, amount) {
  const phone = payment?.phone || '';
  const changed = new Set();
  const input = h('input', { class: 's-file-input', id: 'receipt-file', type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf' });
  const pickLabel = h('span', {}, '📎 ارفع إيصال التحويل');
  const pick = h('label', { class: 's-btn s-btn-green s-btn-block s-upload', for: 'receipt-file' }, pickLabel);
  const prev = h('div', { class: 's-receipt', hidden: true });
  let url = null;
  const clear = () => { input.value = ''; paint(); };
  function paint() {
    if (url) { URL.revokeObjectURL(url); url = null; }
    const f = input.files[0];
    prev.hidden = !f;
    pickLabel.textContent = f ? '🔄 تغيير الإيصال' : '📎 ارفع إيصال التحويل';
    if (f) {
      const isImg = f.type.startsWith('image/');
      if (isImg) url = URL.createObjectURL(f);
      mount(prev,
        isImg ? h('img', { src: url, alt: 'معاينة الإيصال' }) : h('div', { class: 's-receipt-pdf' }, '📄'),
        h('div', { class: 's-receipt-info' }, h('strong', {}, f.name), h('small', {}, `${Math.max(1, Math.round(f.size / 1024))} ك.ب`)),
        h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: clear }, 'إزالة'));
    }
    changed.forEach((fn) => fn());
  }
  input.addEventListener('change', paint);
  const copy = h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(phone); toast('تم نسخ الرقم', 'ok'); } catch { toast('انسخ الرقم يدوياً', 'err'); }
  } }, 'نسخ الرقم');
  const node = h('section', { class: 's-pay', 'aria-label': 'طريقة الدفع' },
    h('h3', {}, 'طريقة الدفع'),
    phone
      ? [h('p', { class: 's-pay-lead' }, 'حوّل مبلغ الدورة ', h('strong', {}, amount), ' إلى الرقم'),
        h('div', { class: 's-pay-phone' }, h('span', { class: 's-pay-num', dir: 'ltr' }, phone), copy),
        payment.holder ? h('small', { class: 's-pay-holder' }, `باسم: ${payment.holder}`) : null,
        h('ol', { class: 's-pay-steps' },
          h('li', {}, 'حوّل المبلغ'),
          h('li', {}, 'صوّر الإيصال'),
          h('li', {}, 'ارفعه هنا (صورة أو PDF)')),
        ]
      : h('p', { class: 's-err' }, 'رقم التحويل لم يُضبط بعد. تواصل مع الإدارة لإتمام الدفع.'),
    h('div', { class: 's-upload-wrap' }, input, pick), prev);
  return { node, ready: !!phone, file: () => input.files[0] || null, onChange: (fn) => changed.add(fn) };
}

/** صفحة الشكر بعد التسجيل: دعاء من الإدارة، ورابط مجتمع واتساب، وتوضيح خطوة المراجعة */
function thanksPage(root, current, o) {
  const links = (o.links || []).filter((l) => l.href);
  shell(root, current, h('section', { class: 's-section' }, h('div', { class: 's-wrap s-done' },
    h('div', { class: 's-done-ic' }, '🌿'),
    h('h1', {}, o.gift ? 'وصل إهداؤك، جزاك الله خيراً' : 'جزاك الله خيراً على تسجيلك'),
    o.titles?.length ? h('p', { class: 's-done-courses' }, o.titles.join(' · ')) : null,
    o.thanks ? h('blockquote', { class: 's-dua' }, o.thanks) : null,
    o.receipt
      ? h('p', {}, o.member ? 'سيتم مراجعة الإيصال وفتح لوحة المتابعة لك قريباً بإذن الله.' : 'سيتم مراجعة الإيصال والتواصل معك على رقمك قريباً بإذن الله.')
      : o.member ? h('p', {}, 'سيراجع الفريق تسجيلك ويفتح لك لوحة المتابعة قريباً بإذن الله.') : (o.bank ? h('p', {}, o.bank) : null),
    o.skipped?.length ? h('p', { class: 's-err' }, `تعذّر التسجيل في: ${o.skipped.map((x) => `${x.title || ''} (${x.reason})`).join('، ')}`) : null,
    links.length ? h('div', { class: 's-wa' }, h('p', {}, 'انضم إلى مجتمع واتساب الخاص بدورتك:'),
      links.map((l) => h('a', { class: 's-btn s-btn-green', href: l.href, target: '_blank', rel: 'noopener noreferrer' }, `💬 ${links.length > 1 ? l.title : 'مجتمع الدورة على واتساب'}`))) : null,
    h('div', { class: 's-row', style: 'margin-top:1.2rem' },
      o.member ? h('a', { class: 's-btn s-btn-peach', href: '#/my' }, 'لوحة متابعتي') : null,
      h('a', { class: 's-btn s-btn-ghost', href: '#/site/courses' }, 'كل الدورات'),
      o.member ? null : h('a', { class: 's-btn s-btn-green', href: '#/site' }, 'الرئيسية')))));
}

/** عنوان يسمح بكلمة مميّزة واحدة بين <b></b> دون إدراج HTML */
function richTitle(txt) {
  const out = [];
  const re = /<b>(.*?)<\/b>/g;
  let last = 0; let m;
  while ((m = re.exec(txt))) {
    if (m.index > last) out.push(txt.slice(last, m.index));
    out.push(h('b', {}, m[1]));
    last = m.index + m[0].length;
  }
  if (last < txt.length) out.push(txt.slice(last));
  return out;
}

export const seatBadge = (c) => h('span', { class: `s-seat s-seat-${c.seat_state}` }, c.seat_label);

// ---------------------------------------------------------------- الهيكل
/** قائمة «التسجيل»: تفتح بالضغط وتغلق باختيار أو بمفتاح Esc — بلا نوافذ منبثقة */
function regMenu(current) {
  const isHere = REG_LINKS.some(([href]) => href === current);
  const items = h('div', { class: 's-menu-items' }, REG_LINKS.map(([href, label]) =>
    h('a', { href, onclick: () => { box.open = false; } }, label)));
  const box = h('details', { class: 's-menu' },
    h('summary', { 'aria-current': isHere ? 'page' : null }, 'التسجيل ▾'), items);
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.open = false; });
  return box;
}

function header(current) {
  const drawer = h('nav', { class: 's-drawer', hidden: true, 'aria-label': 'القائمة' },
    ...NAV.map(([href, label]) => h('a', { href, 'aria-current': current === href ? 'page' : null, onclick: () => toggle(false) }, label)),
    ...REG_LINKS.map(([href, label]) => h('a', { href, style: 'padding-inline-start:1.6rem;opacity:.9', onclick: () => toggle(false) }, '— ', label)),
    h('a', { class: 's-gift', href: '#/gift', onclick: () => toggle(false) }, '🎁 أهدِ دورة'),
    state.user ? null : h('a', { class: 's-gift', href: '#/register', onclick: () => toggle(false) }, 'إنشاء حساب'),
    h('a', { href: state.user ? '#/my' : '#/login', onclick: () => toggle(false) }, state.user ? 'لوحتي' : 'دخول'));
  const btn = h('button', { class: 's-menubtn', type: 'button', 'aria-expanded': 'false', 'aria-label': 'فتح القائمة', onclick: () => toggle(drawer.hidden) }, '☰ القائمة');
  function toggle(open) {
    drawer.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'إغلاق القائمة' : 'فتح القائمة');
  }
  return h('header', { class: 's-header' },
    h('div', { class: 's-bar' },
      h('a', { class: 's-logo', href: '#/site' }, h('img', { src: '/img/logo.png', alt: 'مثاني' })),
      h('div', { class: 's-spacer' }),
      h('nav', { class: 's-nav', 'aria-label': 'التنقل' },
        h('a', { href: '#/site', 'aria-current': current === '#/site' ? 'page' : null }, 'الرئيسية'),
        h('a', { href: '#/site/about', 'aria-current': current === '#/site/about' ? 'page' : null }, 'عن الدورة'),
        regMenu(current),
        h('a', { href: '#/gift', 'aria-current': current === '#/gift' ? 'page' : null }, 'الإهداء'),
        h('a', { href: state.user ? '#/my' : '#/login' }, state.user ? 'لوحتي' : 'دخول')),
      state.user ? null : h('a', { class: 's-btn s-btn-light s-btn-sm s-signup', href: '#/register' }, 'إنشاء حساب'),
      h('a', { class: 's-btn s-btn-peach s-btn-sm', href: '#/gift' }, '🎁 أهدِ دورة'),
      btn),
    drawer);
}

function footer(d) {
  return h('footer', { class: 's-footer s-pattern' }, h('div', { class: 's-wrap' },
    h('div', { class: 's-footer-grid' },
      h('div', {}, h('h4', {}, 'مثاني'), h('p', {}, 'نعين على مواصلة ذكر الله والدعاء، بخطوات هادئة تناسب كل الأعمار.')),
      h('div', {}, h('h4', {}, 'التسجيل'), ...REG_LINKS.map(([href, label]) => h('a', { href }, label))),
      h('div', {}, h('h4', {}, 'روابط'),
        h('a', { href: '#/site/about' }, 'عن الدورة'),
        h('a', { href: '#/gift' }, 'أهدِ دورة'),
        state.user ? null : h('a', { href: '#/register' }, 'إنشاء حساب'),
        h('a', { href: state.user ? '#/my' : '#/login' }, state.user ? 'لوحتي' : 'تسجيل الدخول'),
        d?.contact?.note ? h('p', { style: 'margin-top:.5rem' }, d.contact.note) : null)),
    h('div', { class: 's-copy' }, `جميع الحقوق محفوظة — مؤسسة مثاني ${new Date().getFullYear()}`)));
}

/** قالب الصفحة: شريط + محتوى + شريط إهداء للجوال + تذييل */
export function shell(root, current, body, d) {
  mount(root, h('div', { class: 'site' },
    header(current),
    h('main', { class: 's-main', id: 'site-main', tabindex: -1 }, body),
    current === '#/gift' ? null : h('div', { class: 's-giftbar' }, h('a', { class: 's-btn s-btn-peach s-btn-block', href: '#/gift' }, '🎁 أهدِ دورة لمن تحب')),
    footer(d)));
  window.scrollTo(0, 0);
}

export const loading = () => h('div', { class: 's-wrap', style: 'padding:3rem 1rem;text-align:center;color:#5b6b68' }, 'جارٍ التحميل…');

// ---------------------------------------------------------------- الصفحة الرئيسية
export async function renderSiteHome(root) {
  shell(root, '#/site', loading());
  let d;
  try { d = await get('/api/site/home'); }
  catch (e) { fail(e); shell(root, '#/site', h('div', { class: 's-wrap', style: 'padding:3rem 1rem' }, h('p', {}, 'تعذّر تحميل المحتوى، حدّث الصفحة.'))); return; }

  const hero = h('section', { class: 's-hero s-pattern' }, h('div', { class: 's-wrap' },
    h('div', { class: 's-eyebrow' }, d.hero.eyebrow),
    h('h1', {}, richTitle(d.hero.title)),
    h('p', {}, d.hero.text),
    h('div', { class: 's-hero-actions' },
      h('a', { class: 's-btn s-btn-peach', href: state.user && d.hero.primary.href === '#/register' ? '#/site/courses' : d.hero.primary.href }, d.hero.primary.label),
      h('a', { class: 's-btn s-btn-light', href: d.hero.secondary.href }, d.hero.secondary.label)),
    h('p', { class: 's-hero-note' }, 'التسجيل بسيط: اختر ما يناسبك، واملأ بياناتك، وابدأ.')));

  const about = h('section', { class: 's-section' }, h('div', { class: 's-wrap' },
    h('div', { class: 's-section-head' }, h('h2', {}, 'ما هي دورة الاستشفاء؟')),
    h('div', { class: 's-cards c3' }, d.about.map((c) => h('article', { class: 's-card' },
      h('span', { class: 's-ic' }, c.icon), h('h3', {}, c.title), h('p', {}, c.text))))));

  const paths = h('section', { class: 's-section', style: 'background:#fffdf8' }, h('div', { class: 's-wrap' },
    h('div', { class: 's-section-head' }, h('h2', {}, 'اختر طريقك'),
      h('p', {}, 'أربعة طرق للانتفاع، اختر ما يناسب وقتك وحالك.')),
    h('div', { class: 's-cards c4' }, d.paths.map((p) => h('div', { class: 's-card s-card-path' },
      h('span', { class: 's-ic' }, p.icon), h('h3', {}, p.title), h('p', {}, p.text),
      h('a', { class: `s-btn s-btn-sm s-btn-block ${['#/site/courses', '#/site/year-plan'].includes(p.href) ? 's-btn-peach' : 's-btn-ghost'}`, href: p.href, style: 'margin-top:1rem' }, p.cta))))));

  const gift = h('section', { class: 's-gift-strip s-pattern' }, h('div', { class: 's-wrap' },
    h('div', { class: 's-eyebrow', style: 'color:var(--s-peach)' }, '🎁 الإهداء'),
    h('h2', {}, d.gift.title), h('p', {}, d.gift.text),
    h('div', { style: 'margin-top:1.2rem' }, h('a', { class: 's-btn s-btn-peach', href: '#/gift' }, d.gift.cta))));

  shell(root, '#/site', [hero, about, paths, gift], d);
}

// ---------------------------------------------------------------- صفحة الدورات عن بُعد
export async function renderSiteCourses(root, query) {
  shell(root, '#/site/courses', loading());
  let d;
  try { d = await get('/api/site/courses'); } catch (e) { fail(e); return; }

  let month = ''; let state2 = ''; let term = '';
  const q = h('input', { class: 's-input', type: 'search', placeholder: 'ابحث باسم الدورة أو المحاضر…', 'aria-label': 'بحث' });
  const monthSel = h('select', { class: 's-input', 'aria-label': 'الشهر' }, h('option', { value: '' }, 'كل الشهور'),
    d.months.map((m) => h('option', { value: m }, d.month_names[m - 1])));
  const stateSel = h('select', { class: 's-input', 'aria-label': 'حالة التسجيل' },
    h('option', { value: '' }, 'كل الحالات'), h('option', { value: 'open' }, 'متاح'), h('option', { value: 'few' }, 'مقاعد قليلة'), h('option', { value: 'full' }, 'مكتمل'));
  const list = h('div', { class: 's-cards c3' });
  const count = h('p', { class: 's-count' });

  function paint() {
    term = q.value.trim(); month = monthSel.value; state2 = stateSel.value;
    const rows = d.courses.filter((c) => {
      if (term && !`${c.title} ${c.instructor} ${c.summary}`.includes(term)) return false;
      if (month && Number(c.start_date?.slice(5, 7)) !== Number(month)) return false;
      if (state2 === 'open' && c.seat_state !== 'open') return false;
      if (state2 === 'few' && c.seat_state !== 'few') return false;
      if (state2 && state2 === 'full' && c.can_register) return false;
      return true;
    });
    count.textContent = rows.length ? `${rows.length} دورة` : '';
    mount(list, rows.length ? rows.map(courseCard)
      : h('p', { class: 's-empty' }, 'لا توجد دورات مطابقة. جرّب تغيير البحث أو الفلترة.'));
  }
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(paint, 200); });
  monthSel.addEventListener('change', paint); stateSel.addEventListener('change', paint);
  paint();

  shell(root, '#/site/courses', [
    h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
      h('div', { class: 's-eyebrow' }, 'التسجيل'),
      h('h1', {}, 'الدورات عن بُعد'),
      h('p', {}, 'لقاءات مباشرة تحضرها من بيتك، مع ورد يومي ومتابعة لطيفة في المنصة.'))),
    h('section', { class: 's-section' }, h('div', { class: 's-wrap' },
      h('div', { class: 's-filters' }, q, monthSel, stateSel),
      count, list)),
  ], d);
  void query;
}

// ---------------------------------------------------------------- تفاصيل الدورة
export async function renderSiteCourse(root, id) {
  shell(root, '#/site/courses', loading());
  let d;
  try { d = await get(`/api/site/courses/${id}`); }
  catch (e) {
    shell(root, '#/site/courses', h('section', { class: 's-section' }, h('div', { class: 's-wrap' },
      h('p', {}, e.status === 404 ? 'هذه الدورة غير متاحة.' : e.message),
      h('a', { class: 's-btn s-btn-ghost', href: '#/site/courses' }, 'كل الدورات'))));
    return;
  }
  const c = d.course;
  const facts = [
    c.instructor && ['👤 المحاضر', c.instructor],
    c.start_date && ['🗓️ التاريخ', dateRange(c.start_date, c.end_date)],
    c.time_label && ['🕗 الوقت', c.time_label],
    c.duration_label && ['⏳ المدة', c.duration_label],
    ['💳 السعر', c.price],
    [c.seats != null ? '🎟️ المقاعد' : '🎟️ التسجيل', c.seats != null ? `${c.seats_left} متبقٍ من ${c.seats}` : c.seat_label],
  ].filter(Boolean);

  const body = [
    h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
      h('a', { class: 's-back', href: '#/site/courses' }, '→ كل الدورات'),
      h('h1', {}, c.title),
      c.summary ? h('p', {}, c.summary) : null,
      h('div', { style: 'margin-top:.6rem' }, seatBadge(c)))),
    h('section', { class: 's-section' }, h('div', { class: 's-wrap s-detail' },
      h('div', { class: 's-detail-main' },
        c.has_image ? h('img', { class: 's-course-img', src: `/api/site/courses/${c.id}/image`, alt: '', loading: 'lazy' }) : null,
        c.description ? h('div', { class: 's-card' }, h('h2', {}, 'عن الدورة'), h('p', { style: 'white-space:pre-wrap;margin:0' }, c.description)) : null,
        c.goals.length ? h('div', { class: 's-card' }, h('h2', {}, 'الأهداف'), h('ul', { class: 's-list' }, c.goals.map((g) => h('li', {}, g)))) : null,
        c.topics.length ? h('div', { class: 's-card' }, h('h2', {}, 'المحاور'), h('ol', { class: 's-list s-list-num' }, c.topics.map((t) => h('li', {}, t)))) : null,
        c.schedule?.length ? h('div', { class: 's-card' }, h('h2', {}, 'الجدول والمحطات'),
          h('ol', { class: 's-timeline' }, c.schedule.map((x) => h('li', {},
            x.when ? h('span', { class: 'when' }, x.when) : null,
            x.what ? h('span', { class: 'what' }, x.what) : null)))) : null,
        c.attend_note ? h('div', { class: 's-card' }, h('h2', {}, 'طريقة الحضور'), h('p', { style: 'margin:0' }, c.attend_note)) : null,
        c.faq.length ? h('div', { class: 's-card' }, h('h2', {}, 'الأسئلة الشائعة'),
          c.faq.map((f) => h('details', { class: 's-faq' }, h('summary', {}, f.q), h('p', {}, f.a)))) : null),
      h('aside', { class: 's-detail-side' },
        h('div', { class: 's-card s-sticky' },
          h('div', { class: 's-price', style: 'font-size:1.6rem' }, c.price),
          h('dl', { class: 's-facts' }, facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
          c.can_register
            ? h('a', { class: 's-btn s-btn-peach s-btn-block', href: `#/site/register?c=${c.id}` }, 'سجّل الآن')
            : h('span', { class: 's-btn s-btn-ghost s-btn-block', style: 'opacity:.6;cursor:default' }, c.seat_state === 'full' ? 'اكتمل العدد' : 'التسجيل مغلق'),
          h('a', { class: 's-btn s-btn-ghost s-btn-block', style: 'margin-top:.6rem', href: `#/gift?c=${c.id}` }, '🎁 أهدِ هذه الدورة'),
          d.bank_note ? h('p', { class: 's-note' }, d.bank_note) : null))))];
  shell(root, '#/site/courses', body, d);
}

// ---------------------------------------------------------------- التسجيل في دورة
/** الإهداء: إن لم تُحدَّد دورة عرضنا قائمة لاختيارها، وإلا فتحنا النموذج في وضع الإهداء */
export async function renderSiteRegister(root, query, opts = {}) {
  const id = Number(query.get('c'));
  shell(root, '#/site/courses', loading());
  let d;
  try { d = await get(`/api/site/courses/${id}`); }
  catch { shell(root, '#/site/courses', h('section', { class: 's-section' }, h('div', { class: 's-wrap' }, h('p', {}, 'هذه الدورة غير متاحة.'), h('a', { class: 's-btn s-btn-ghost', href: '#/site/courses' }, 'كل الدورات')))); return; }
  const c = d.course;
  if (!c.can_register) {
    shell(root, '#/site/courses', h('section', { class: 's-section' }, h('div', { class: 's-wrap' },
      h('h1', {}, c.title), h('p', {}, c.seat_state === 'full' ? 'اكتمل العدد في هذه الدورة.' : 'التسجيل في هذه الدورة مغلق حالياً.'),
      h('a', { class: 's-btn s-btn-ghost', href: '#/site/courses' }, 'كل الدورات'))));
    return;
  }

  if (!state.user) {
    // التسجيل في الدورة يتطلب حساباً: تظهر فيه لوحة المتابعة وحالة الطلب ورابط المجتمع
    shell(root, '#/site/courses', [
      h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
        h('a', { class: 's-back', href: `#/site/courses/${c.id}` }, '→ عودة للدورة'), h('h1', {}, 'التسجيل في الدورة'), h('p', {}, c.title))),
      h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow' }, h('div', { class: 's-card', style: 'text-align:center' },
        h('div', { class: 's-done-ic' }, '🔐'),
        h('h2', {}, 'أنشئ حسابك أولاً'),
        h('p', {}, 'بعد التسجيل في الدورة تظهر لك لوحة المتابعة بحالة طلبك، وتُفتح لك الأعمال اليومية فور أن تراجع الإدارة إيصالك.'),
        h('div', { class: 's-row', style: 'margin-top:1.2rem' }, h('a', { class: 's-btn s-btn-peach', href: '#/register' }, 'إنشاء حساب جديد'), h('a', { class: 's-btn s-btn-ghost', href: '#/login' }, 'لدي حساب')))))], d);
    return;
  }

  const name = h('input', { class: 's-input', maxlength: 80, autocomplete: 'name', placeholder: 'الاسم الثلاثي' });
  const phone = h('input', { class: 's-input', type: 'tel', dir: 'ltr', autocomplete: 'tel', placeholder: '9X XXX XXX' });
  const note = h('textarea', { class: 's-input', rows: 2, maxlength: 400, placeholder: 'ملاحظة للفريق (اختياري)' });
  const err = h('p', { class: 's-err', hidden: true });
  const pay = c.price_minor > 0 ? paymentBox(d.payment, c.price) : null;
  const btn = h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'submit' }, 'سجّلني في الدورة');
  const syncBtn = () => { btn.disabled = pay ? !(pay.ready && pay.file()) : false; };
  pay?.onChange(syncBtn);

  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      const fields = { course_id: c.id, name: name.value, phone: phone.value, note: note.value, kind: 'self', gift_from: '' };
      let payload = fields;
      if (pay) {
        const receipt = pay.file();
        if (!receipt) throw new Error('ارفع إيصال التحويل لإتمام التسجيل');
        payload = new FormData();
        for (const [k, v] of Object.entries(fields)) payload.append(k, String(v));
        payload.append('receipt', receipt);
      }
      const r = await post('/api/site/register', payload);
      thanksPage(root, '#/site/courses', {
        titles: [r.course.title], thanks: r.thanks_text, member: !!state.user, receipt: r.receipt,
        bank: r.course.free ? 'الدورة مجانية، وسيصلك رابط الحضور قبل الموعد.' : `${r.bank_note} المبلغ: ${r.course.price}.`,
        links: [{ title: r.course.title, href: r.whatsapp_link }],
      });
    } catch (ex) { err.textContent = ex.message; err.hidden = false; syncBtn(); }
  } },
    state.user ? accountNote() : [
      h('label', { class: 's-field' }, h('span', {}, 'الاسم'), name),
      h('label', { class: 's-field' }, h('span', {}, 'رقم الهاتف'), phone, h('small', {}, 'الدولة الافتراضية سلطنة عُمان (+968).'))],
    pay?.node,
    h('label', { class: 's-field' }, h('span', {}, 'ملاحظة'), note),
    err, btn,
    h('p', { class: 's-note', style: 'text-align:center' }, 'تريد أن تُهدي هذه الدورة لشخص آخر؟ ', h('a', { href: `#/gift?c=${c.id}` }, 'أهدِ هذه الدورة')));
  syncBtn();

  shell(root, '#/site/courses', [
    h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
      h('a', { class: 's-back', href: `#/site/courses/${c.id}` }, '→ عودة للدورة'),
      h('h1', {}, 'التسجيل في الدورة'),
      h('p', {}, c.title))),
    h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow' },
      h('div', { class: 's-card' },
        h('dl', { class: 's-facts' },
          c.start_date ? h('div', {}, h('dt', {}, '🗓️ التاريخ'), h('dd', {}, dateRange(c.start_date, c.end_date))) : null,
          c.time_label ? h('div', {}, h('dt', {}, '🕗 الوقت'), h('dd', {}, c.time_label)) : null,
          h('div', {}, h('dt', {}, '💳 السعر'), h('dd', {}, c.price))),
        form))),
  ], d);
}

// ---------------------------------------------------------------- خطة العام
const PICK_KEY = 'mathani_year_pick';
const readPick = () => { try { const v = JSON.parse(localStorage.getItem(PICK_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writePick = (a) => { try { localStorage.setItem(PICK_KEY, JSON.stringify(a)); } catch { /* تصفح خاص */ } };
const monthYear = (d, months) => (d ? `${months[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : '');
const dayRange = (a, b) => (a && b ? `${Number(a.slice(8))} – ${Number(b.slice(8))} ${months_(a)}` : fmtDate(a));
let MONTHS_CACHE = [];
const months_ = (d) => MONTHS_CACHE[Number(d.slice(5, 7)) - 1] || '';

export async function renderSiteYearPlan(root) {
  shell(root, '#/site/year-plan', loading());
  let d;
  try { d = await get('/api/site/year-plan'); } catch (e) { fail(e); return; }
  MONTHS_CACHE = d.months;
  let pick = readPick().filter((id) => d.courses.some((c) => c.id === id && c.can_register));
  writePick(pick);

  const grid = h('div', { class: 's-cards c3' });
  const bar = h('div', { class: 's-pickbar', hidden: true });

  function toggle(id) {
    pick = pick.includes(id) ? pick.filter((x) => x !== id) : [...pick, id];
    writePick(pick); paint();
  }
  function paintBar() {
    const chosen = d.courses.filter((c) => pick.includes(c.id));
    bar.hidden = !chosen.length;
    const total = chosen.reduce((a, c) => a + c.price_minor, 0);
    mount(bar,
      h('div', { class: 'grow' }, h('strong', {}, `${chosen.length} دورة مختارة`),
        h('div', { class: 's-pick-names' }, chosen.map((c) => c.ordinal).join('، '))),
      h('span', { class: 's-price' }, `${Math.floor(total / 1000)}.${String(total % 1000).padStart(3, '0')} ر.ع`),
      h('a', { class: 's-btn s-btn-peach', href: '#/site/year-checkout' }, 'متابعة التسجيل'));
  }
  function paint() {
    mount(grid, d.courses.map((c) => {
      const chosen = pick.includes(c.id);
      return h('article', { class: 's-card s-course s-year' + (c.is_past ? ' s-dim' : '') + (c.is_next ? ' s-next' : '') },
        c.is_next ? h('span', { class: 's-ribbon' }, '★ الدورة القادمة') : null,
        h('div', { class: 's-year-no' }, `الدورة ${c.ordinal}`),
        h('h3', {}, monthYear(c.start_date, d.months)),
        h('div', { class: 's-meta' },
          c.start_date ? h('span', {}, '🗓️ ', dayRange(c.start_date, c.end_date)) : null,
          c.time_label ? h('span', {}, '🕗 ', c.time_label) : null),
        h('div', { class: 's-course-foot' }, h('span', { class: 's-price' }, c.price), seatBadge(c)),
        c.can_register ? h('div', { class: 's-course-actions' },
          h('a', { class: 's-btn s-btn-peach s-btn-block', href: `#/site/register?c=${c.id}` }, 'سجّل الآن'),
          h('div', { class: 's-row' },
            h('button', { class: `s-btn s-btn-sm ${chosen ? 's-btn-green' : 's-btn-ghost'}`, type: 'button', 'aria-pressed': String(chosen), onclick: () => toggle(c.id) }, chosen ? '✓ في اختياري' : 'أضف إلى اختياري'),
            h('a', { class: 's-btn s-btn-ghost s-btn-sm', href: `#/gift?c=${c.id}` }, '🎁 إهداء')))
          : h('span', { class: 's-btn s-btn-ghost s-btn-block', style: 'opacity:.6;cursor:default' }, c.is_past ? 'انتهت' : c.seat_state === 'full' ? 'اكتمل العدد' : 'غير متاحة'));
    }));
    paintBar();
  }
  paint();

  shell(root, '#/site/year-plan', [
    h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
      h('div', { class: 's-eyebrow' }, 'التسجيل المبكر'),
      h('h1', {}, 'خطة العام'),
      h('p', {}, 'احجز مقعدك في الدورة التي تناسبك ورتّب وقتك مبكراً.'))),
    h('section', { class: 's-section' }, h('div', { class: 's-wrap' }, grid, bar)),
  ], d);
}

// ---------------------------------------------------------------- ملخص الاختيار والتسجيل
export async function renderYearCheckout(root) {
  shell(root, '#/site/year-plan', loading());
  let d;
  try { d = await get('/api/site/year-plan'); } catch (e) { fail(e); return; }
  MONTHS_CACHE = d.months;
  const pick = readPick();
  const chosen = d.courses.filter((c) => pick.includes(c.id) && c.can_register);
  if (!chosen.length) {
    shell(root, '#/site/year-plan', h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow' },
      h('p', {}, 'لم تختر دورة بعد.'), h('a', { class: 's-btn s-btn-green', href: '#/site/year-plan' }, 'عودة إلى خطة العام'))));
    return;
  }
  const total = chosen.reduce((a, c) => a + c.price_minor, 0);
  const fmtR = (m) => `${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, '0')} ر.ع`;

  const name = h('input', { class: 's-input', maxlength: 80, autocomplete: 'name', placeholder: 'الاسم الثلاثي' });
  const phone = h('input', { class: 's-input', type: 'tel', dir: 'ltr', autocomplete: 'tel', placeholder: '9X XXX XXX' });
  const note = h('textarea', { class: 's-input', rows: 2, maxlength: 400, placeholder: 'ملاحظة للفريق (اختياري)' });
  const err = h('p', { class: 's-err', hidden: true });
  const pay = total > 0 ? paymentBox(d.payment, fmtR(total)) : null;
  const btn = h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'submit' }, 'سجّلني في الدورات');
  const syncBtn = () => { btn.disabled = pay ? !(pay.ready && pay.file()) : false; };
  pay?.onChange(syncBtn); syncBtn();

  const rows = chosen.map((c) => h('div', { class: 's-sum-row' },
    h('div', {}, h('strong', {}, `الدورة ${c.ordinal}`), h('div', { class: 'muted' }, `${monthYear(c.start_date, d.months)} · ${dayRange(c.start_date, c.end_date)}`)),
    h('div', { class: 's-row', style: 'flex:0 0 auto;gap:.5rem;align-items:center' },
      h('span', {}, c.price),
      h('button', { class: 's-btn s-btn-ghost s-btn-sm', type: 'button', onclick: () => { writePick(readPick().filter((x) => x !== c.id)); renderYearCheckout(root); } }, 'إزالة'))));

  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      let payload = { course_ids: chosen.map((c) => c.id), name: name.value, phone: phone.value, note: note.value };
      if (pay) {
        const receipt = pay.file();
        if (!receipt) throw new Error('ارفع إيصال التحويل لإتمام التسجيل');
        payload = new FormData();
        payload.append('course_ids', chosen.map((c) => c.id).join(',')); payload.append('note', note.value); payload.append('receipt', receipt);
      }
      const r = await post('/api/site/register-many', payload);
      writePick([]);
      thanksPage(root, '#/site/year-plan', {
        titles: r.done.map((x) => x.title), thanks: r.thanks_text, member: !!state.user, receipt: r.receipt, skipped: r.skipped,
        bank: r.total_minor ? `${r.bank_note} الإجمالي: ${fmtR(r.total_minor)}.` : 'التسجيل مجاني.',
        links: r.done.map((x) => ({ title: x.title, href: x.whatsapp_link })),
      });
    } catch (ex) { err.textContent = ex.message; err.hidden = false; syncBtn(); }
  } },
    state.user ? [accountNote(), pay?.node] : [
      h('label', { class: 's-field' }, h('span', {}, 'الاسم'), name),
      h('label', { class: 's-field' }, h('span', {}, 'رقم الهاتف'), phone, h('small', {}, 'الدولة الافتراضية سلطنة عُمان (+968).'))],
    h('label', { class: 's-field' }, h('span', {}, 'ملاحظة'), note),
    err, btn);

  shell(root, '#/site/year-plan', [
    h('section', { class: 's-page-head' }, h('div', { class: 's-wrap' },
      h('a', { class: 's-back', href: '#/site/year-plan' }, '→ عودة إلى خطة العام'),
      h('h1', {}, 'ملخص اختيارك'),
      h('p', {}, 'راجع الدورات التي اخترتها قبل التسجيل.'))),
    h('section', { class: 's-section' }, h('div', { class: 's-wrap s-narrow' },
      h('div', { class: 's-card' }, rows,
        h('div', { class: 's-sum-total' }, h('span', {}, 'الإجمالي'), h('span', { class: 's-price' }, fmtR(total)))),
      h('div', { class: 's-card', style: 'margin-top:1rem' }, form))),
  ], d);
}

// ---------------------------------------------------------------- بطاقات مشتركة
export function courseCard(c) {
  return h('article', { class: 's-card s-course' + (c.can_register ? '' : ' s-dim') },
    h('h3', {}, c.title),
    c.summary ? h('p', { style: 'margin-bottom:.2rem' }, c.summary) : null,
    h('div', { class: 's-meta' },
      c.instructor ? h('span', {}, '👤 ', c.instructor) : null,
      c.start_date ? h('span', {}, '🗓️ ', dateRange(c.start_date, c.end_date)) : null,
      c.time_label ? h('span', {}, '🕗 ', c.time_label) : null,
      c.duration_label ? h('span', {}, '⏳ ', c.duration_label) : null,
      c.place ? h('span', {}, '📍 ', c.place) : null),
    h('div', { class: 's-course-foot' }, h('span', { class: 's-price' }, c.price), seatBadge(c)),
    h('div', { class: 's-course-actions' },
      c.can_register
        ? h('a', { class: 's-btn s-btn-peach s-btn-block', href: `#/site/register?c=${c.id}` }, 'سجّل الآن')
        : h('span', { class: 's-btn s-btn-ghost s-btn-block', style: 'opacity:.6;cursor:default' }, c.seat_state === 'full' ? 'اكتمل العدد' : 'التسجيل مغلق'),
      h('div', { class: 's-row' },
        h('a', { class: 's-btn s-btn-ghost s-btn-sm', href: `#/site/courses/${c.id}` }, 'التفاصيل'),
        h('a', { class: 's-btn s-btn-ghost s-btn-sm', href: `#/gift?c=${c.id}` }, '🎁 إهداء'))));
}

export function monthCard(c, months) {
  return h('a', { class: 's-month', href: `#/site/year?c=${c.id}` },
    h('span', { class: 'n' }, months[(c.month || 1) - 1]),
    h('span', { class: 't' }, c.title),
    seatBadge(c));
}
