import { h, $, mount, icon, get, post, state, setUnauthorizedHandler, tickNow, ROLE_LABEL } from './core.js';
import { renderLogin } from './login.js';
import { renderRegister } from './register.js';
import { renderToday, renderHistory, renderAccount } from './user.js';
import { renderDashboard, renderTracking, renderReports } from './admin-dash.js';
import { renderTasks, renderTaskForm, renderUsers, renderGroups, renderMessages } from './admin-manage.js';
import { renderStats } from './stats.js';
import { renderPlan } from './plan.js';
import { renderCommunity, renderMyPosts, renderEditor } from './community.js';
import { renderCommunityAdmin } from './community-admin.js';
import { renderNotifications } from './notifications.js';
import { renderLibrary, renderMyOrders, paintCartBadge } from './library.js';
import { renderStoreAdmin } from './store-admin.js';
import { renderCoursesAdmin } from './courses-admin.js';
import { renderRegistrationsAdmin } from './registrations-admin.js';
import { renderGift, renderGiftClaim, renderMyGifts, takeNext } from './gift.js';
import { renderSiteHome, renderSiteCourses, renderSiteCourse, renderSiteRegister, renderSiteYearPlan, renderYearCheckout } from './site.js';

const root = $('#app');
let cleanup = null;

const staff = () => state.user.role === 'admin' || state.user.role === 'supervisor';
const isAdmin = () => state.user.role === 'admin';

function navItems() {
  const today = { href: '#/my', ic: 'home', label: 'وردي اليوم', short: 'وردي' };
  const stats = { href: '#/stats', ic: 'chart', label: 'إحصاءاتي', short: 'إحصاءات' };
  const history = { href: '#/history', ic: 'history', label: 'سجلي', short: 'سجلي' };
  const account = { href: '#/account', ic: 'user', label: 'حسابي', short: 'حسابي' };
  const plan = { href: '#/plan', ic: 'tasks', label: 'خطتي', short: 'خطتي' };
  const giftNew = { href: '#/gift', ic: 'gift', label: 'أهدِ دورة', short: 'أهدِ' };
  const giftMine = { href: '#/gifts', ic: 'gift', label: 'هداياي', short: 'هداياي' };
  const guide = { href: '/guide.html', ic: 'file', label: 'دليل الاستخدام', short: 'الدليل' };
  const comm = state.community?.enabled === false && !isAdmin() ? [] : [{ href: '#/community', ic: 'users', label: 'المجتمع', short: 'المجتمع' }];
  // «طلباتي» لا تظهر في القائمة؛ يُوصل إليها من صفحة المكتبة. وعدّاد السلة يظهر على «المكتبة».
  const lib = { href: '#/library', ic: 'book', label: 'المكتبة', short: 'المكتبة', badgeKey: 'cart' };
  // «مواضيعي» لا تظهر في القائمة؛ يُوصل إليها من صفحة المجتمع
  if (!staff() && state.user.access === false) {
    // قبل قبول الإدارة لإيصاله: وردي اليوم (لوحة متابعتي) والمكتبة والحساب فقط
    const panel = { href: '#/my', ic: 'inbox', label: 'لوحة المتابعة', short: 'المتابعة' };
    const wird = { locked: true, ic: 'lock', label: 'وردي اليوم', short: 'وردي' };
    return { main: [panel, wird, lib, { href: '#/more', ic: 'more', label: 'المزيد', short: 'المزيد' }], side: [panel, wird, lib, giftNew, giftMine, account, guide], more: [giftNew, giftMine, account, guide] };
  }
  if (!staff()) {
    return {
      main: [today, stats, lib, ...comm, { href: '#/more', ic: 'more', label: 'المزيد', short: 'المزيد' }],
      side: [today, plan, stats, history, lib, ...comm, giftNew, giftMine, account, guide],
      more: [plan, history, giftNew, giftMine, account, guide],
    };
  }
  const reviewer = state.community?.reviewer ? [{ href: '#/community-admin', ic: 'inbox', label: 'إدارة المجتمع', short: 'إدارة المجتمع', badgeKey: 'pending' }] : [];
  const admin = [
    { href: '#/dashboard', ic: 'chart', label: 'نظرة عامة', short: 'نظرة' },
    { href: '#/tracking', ic: 'list', label: 'متابعة الأعضاء', short: 'المتابعة' },
    { href: '#/tasks', ic: 'tasks', label: 'الأذكار والأوراد', short: 'الأوراد' },
    { href: '#/messages', ic: 'book', label: 'رسالة اليوم', short: 'الرسالة' },
    { href: '#/users', ic: 'users', label: isAdmin() ? 'الأعضاء' : 'أعضاء حلقاتي', short: 'الأعضاء' },
    { href: '#/groups', ic: 'users', label: isAdmin() ? 'الحلقات' : 'حلقاتي', short: 'الحلقات' },
    { href: '#/reports', ic: 'chart', label: 'التقارير', short: 'التقارير' },
    ...reviewer,
    { href: '#/store-admin', ic: 'cart', label: 'المكتبة والمتجر', short: 'المتجر' },
    { href: '#/admin/courses', ic: 'calendar', label: 'الدورات والموقع', short: 'الدورات' },
    ...(isAdmin() ? [{ href: '#/admin/registrations', ic: 'inbox', label: 'المسجلون الجدد', short: 'المسجلون', badgeKey: 'regs' }] : []),
  ];
  const mine = [today, plan, stats, history, lib, giftNew, giftMine];
  return {
    main: [admin[0], admin[1], admin[2], ...(reviewer.length ? reviewer : [admin[3]]), { href: '#/more', ic: 'more', label: 'المزيد', short: 'المزيد' }],
    side: [...admin, { sep: true }, ...mine, ...comm, account, guide],
    more: [...admin.filter((i) => !['#/dashboard', '#/tracking', '#/tasks'].includes(i.href) && !(reviewer.length ? false : i === admin[3])), ...mine, ...comm, account],
    // «المزيد» للإدارة على قسمين: أدوات الإدارة، ثم ما يخص المستخدم كعضو
    moreAdmin: admin.filter((i) => !['#/dashboard', '#/tracking', '#/tasks'].includes(i.href) && !(reviewer.length ? false : i === admin[3])),
    moreMine: [...mine, ...comm, account, guide],
  };
}

const ROUTES = [
  [/^\/my$/, () => renderToday(page)], [/^\/plan$/, () => renderPlan(page)], [/^\/history$/, () => renderHistory(page)], [/^\/stats$/, () => renderStats(page)],
  [/^\/account$/, () => renderAccount(page, shell)],

  [/^\/dashboard$/, () => renderDashboard(page), 'staff'], [/^\/tracking$/, () => renderTracking(page), 'staff'],
  [/^\/tasks$/, () => renderTasks(page), 'staff'], [/^\/tasks\/new$/, () => renderTaskForm(page, null), 'admin'],
  [/^\/tasks\/(\d+)$/, (m) => renderTaskForm(page, m[1]), 'admin'], [/^\/users$/, () => renderUsers(page), 'staff'], [/^\/groups$/, () => renderGroups(page), 'staff'],
  [/^\/reports$/, () => renderReports(page), 'staff'], [/^\/messages$/, () => renderMessages(page), 'staff'],
  [/^\/community$/, () => renderCommunity(page)], [/^\/community\/mine$/, () => renderMyPosts(page)], [/^\/community\/new$/, () => renderEditor(page, null)],
  [/^\/community\/edit\/(\d+)$/, (m) => renderEditor(page, m[1])], [/^\/notifications$/, () => renderNotifications(page, refreshSummary)],
  [/^\/community-admin$/, (_m, q) => renderCommunityAdmin(page, q, refreshSummary), 'reviewer'],
  [/^\/library$/, (_m, q) => renderLibrary(page, q)], [/^\/library\/orders$/, () => renderMyOrders(page)],
  [/^\/store-admin$/, (_m, q) => renderStoreAdmin(page, q), 'admin'],
  [/^\/admin\/courses$/, (_m, q) => renderCoursesAdmin(page, q), 'admin'],
  [/^\/admin\/registrations$/, (_m, q) => renderRegistrationsAdmin(page, q, refreshSummary), 'admin'],
  [/^\/gifts$/, () => renderMyGifts(page)],
  [/^\/more$/, () => renderMore()],
];

let page;

// ---------- عدّادات الإشعارات (استطلاع كل 30 ثانية) ----------
state.notif = { unread: 0, pending_review: 0, pending_regs: 0 };
let pollTimer = null;
function paintBadges() {
  const set = (sel, n) => document.querySelectorAll(sel).forEach((el) => { el.hidden = !n; el.textContent = n > 99 ? '99+' : String(n); });
  set('.js-bell', state.notif.unread); set('.js-pending', state.notif.pending_review); set('.js-regs', state.notif.pending_regs);
  paintCartBadge();
}
async function refreshSummary() {
  if (!state.user) return;
  try { const s = await get('/api/notifications/summary'); state.notif = s; paintBadges(); } catch { /* */ }
  paintStreak();
}

/** بطاقة السلسلة في الشريط الجانبي — تُحدَّث من صفحة «وردي اليوم» */
export function paintStreak(n = state.streak) {
  if (n !== undefined) state.streak = n;
  const v = state.streak;
  document.querySelectorAll('.js-streak').forEach((el) => {
    el.hidden = !v;
    if (!v) return;
    mount(el, h('span', { class: 'fire' }, '🔥'),
      h('div', {}, h('div', { class: 'n' }, Number(v).toLocaleString('ar-OM-u-nu-latn')),
        h('div', { class: 'lbl' }, v === 1 ? 'يوم متتالٍ من المواظبة' : 'يوماً متتالياً من المواظبة')));
  });
}
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(refreshSummary, 30_000); }

function renderMore() {
  const n = navItems();
  const u = state.user;
  const tiles = (items) => h('div', { class: 'moregrid' }, items.map((i) => h('a', { class: 'mtile', href: i.href },
    h('span', { class: 'mic' }, icon(i.ic)), h('span', {}, i.label),
    i.badgeKey ? h('span', { class: `nav-badge js-${i.badgeKey}`, hidden: true }) : null)));
  mount(page,
    h('section', { class: 'profile' },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, (u.name || '؟').trim().charAt(0)),
      h('div', {}, h('div', { class: 'pname' }, u.name), h('div', { class: 'muted small' }, ROLE_LABEL[u.role]))),
    n.moreAdmin
      ? [h('h3', { class: 'moresec' }, 'الإدارة'), tiles(n.moreAdmin), h('h3', { class: 'moresec' }, 'كعضو'), tiles(n.moreMine)]
      : tiles(n.more),
    h('button', { class: 'btn danger block', style: 'margin-top:1.25rem', onclick: logout }, icon('logout'), 'تسجيل الخروج'));
  paintBadges();
}

async function logout() { try { await post('/api/auth/logout'); } catch { /* */ } state.user = null; location.hash = ''; boot(); }

/** عدد تنقلات الهاش منذ فتح الصفحة: يحدد هل يوجد «رجوع» حقيقي في سجل المتصفح */
let navCount = 0;
function goBack() {
  if (navCount > 0) { history.back(); return; }
  const path = location.hash.replace(/^#/, '').split('?')[0];
  const parent = path.match(/^\/(community|library|tasks)\//);
  location.hash = parent ? `#/${parent[1]}` : '#/more';
}

/** عنوان الشريط العلوي وزر الرجوع بحسب الصفحة الحالية (الشاشات الرئيسية في التبويب السفلي بلا رجوع) */
function paintBar(path) {
  const title = $('#apptitle');
  if (!title) return;
  const n = navItems();
  const isTab = n.main.some((i) => i.href && i.href.slice(1) === path);
  const item = [...n.main, ...n.side, ...n.more].find((i) => i.href && i.href.slice(1) === path);
  const h1 = page.querySelector('.page-head h1');
  const h1Text = h1?.textContent.trim();
  title.textContent = item?.label || h1Text || page.querySelector('h1')?.textContent.trim() || 'مثاني';
  // العنوان يظهر في الشريط، فيُخفى تكراره داخل الصفحة على الجوال
  if (h1 && (!item || h1Text === item.label)) h1.classList.add('in-bar');
  $('.tb-back').hidden = isTab;
  $('.tb-logo').hidden = !isTab;
}

function skeleton() {
  return h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', { class: 'tall' }), h('i'), h('i'), h('i'));
}

function shell() {
  const n = navItems();
  const cur = location.hash.replace(/^#/, '') || '/';
  const link = (i, cls) => (i.locked ? h('span', { class: `${cls} locked`.trim(), 'aria-disabled': 'true', title: 'يُفتح بعد موافقة الإدارة على الإيصال' }, cls === 'nav' ? icon(i.ic) : h('span', { class: 'ic' }, icon(i.ic)), cls === 'nav' ? `${i.label} — بعد موافقة الإدارة` : i.short) : h('a', { class: cls, href: i.href, 'aria-current': cur === i.href.slice(1) || (i.href === '#/tasks' && cur.startsWith('/tasks')) ? 'page' : null },
    cls === 'nav' ? icon(i.ic) : h('span', { class: 'ic' }, icon(i.ic), i.badgeKey ? h('span', { class: `nav-badge js-${i.badgeKey}`, hidden: true }) : null),
    cls === 'nav' ? i.label : i.short, cls === 'nav' && i.badgeKey ? h('span', { class: `nav-badge js-${i.badgeKey}`, hidden: true }) : null));
  page = h('main', { class: 'main', id: 'page', tabindex: -1 });
  mount(root, h('div', { class: 'shell' },
    h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('img', { src: '/img/logo.png', alt: 'مثاني' })),
      h('div', { class: 'streakcard js-streak', hidden: true }),
      n.side.map((i) => (i.sep ? h('hr', { class: 'hr' }) : link(i, 'nav'))), h('div', { class: 'sep' }),
      h('div', { class: 'who' }, h('div', { style: 'font-weight:700' }, state.user.name), h('div', { class: 'muted small' }, ROLE_LABEL[state.user.role]),
        h('button', { class: 'btn sm block', style: 'margin-top:.6rem', onclick: logout }, icon('logout'), 'تسجيل الخروج'))),
    h('div', { class: 'content' },
      h('header', { class: 'appbar' }, h('div', { class: 'topbar' },
        h('button', { class: 'tb-btn tb-back', type: 'button', 'aria-label': 'رجوع', hidden: true, onclick: goBack }, icon('chevR')),
        h('a', { class: 'tb-logo', href: '#/', 'aria-label': 'مثاني' }, h('img', { src: '/img/logo.png', alt: '' })),
        h('div', { class: 'tb-title', id: 'apptitle' }),
        h('div', { class: 'tb-actions' }, h('span', { class: 'who-name muted small' }, state.user.name),
          h('a', { class: 'bell gift-link', href: '#/gift', 'aria-label': 'أهدِ دورة' }, icon('gift')),
          h('a', { class: 'bell', href: '#/notifications', 'aria-label': 'الإشعارات' }, icon('bell'), h('span', { class: 'bell-count js-bell', hidden: true }))))),
      page),
    h('nav', { class: 'bottomnav', 'aria-label': 'التنقل' }, n.main.map((i) => link(i, '')))));
  mount(page, skeleton());
}

const SITE_PAGES = {
  '': renderSiteHome, home: renderSiteHome, courses: renderSiteCourses, register: renderSiteRegister,
  gift: (_root, q) => { location.hash = `#/gift${q.get('c') ? `?c=${q.get('c')}` : ''}`; }, year: renderSiteYearPlan, 'year-plan': renderSiteYearPlan, 'year-checkout': renderYearCheckout,
};

async function route() {
  const raw = location.hash.replace(/^#/, '');
  const [rawPath, rawQuery] = raw.split('?');
  if (rawPath.startsWith('/site')) {
    if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
    const detail = rawPath.match(/^\/site\/courses\/(\d+)$/);
    if (detail) { await renderSiteCourse(root, detail[1]); return; }
    const m = rawPath.match(/^\/site(?:\/([\w-]+))?\/?$/);
    const render = m && SITE_PAGES[m[1] || ''];
    if (render) { await render(root, new URLSearchParams(rawQuery || '')); return; }
    location.hash = '#/site';
    return;
  }
  const claim = rawPath.match(/^\/gift\/([\w-]{16,})$/);
  if (claim || rawPath === '/gift') {
    if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
    if (claim) await renderGiftClaim(root, claim[1]); else await renderGift(root, new URLSearchParams(rawQuery || ''));
    return;
  }
  if (!state.user) {
    if (rawPath === '/login') { renderLogin(root, async () => { location.hash = takeNext() || '#/my'; await boot(); }); return; }
    if (rawPath === '/register') { renderRegister(root, async () => { location.hash = takeNext() || '#/site/courses'; await boot(); }); return; }
    location.hash = '#/site';
    return;
  }
  if (rawPath === '/register') { location.hash = '#/my'; return; }
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  let hash = location.hash.replace(/^#/, '');
  const [path, query] = hash.split('?');
  if (!path || path === '/') { location.hash = staff() ? '#/dashboard' : '#/my'; return; }
  shell();
  paintBadges(); refreshSummary();
  const q = new URLSearchParams(query || '');
  for (const [re, fn, need] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    if ((need === 'staff' && !staff()) || (need === 'admin' && !isAdmin()) || (need === 'reviewer' && !state.community?.reviewer)) { location.hash = '#/my'; return; }
    paintBar(path);
    try { const c = await fn(m, q); if (typeof c === 'function') cleanup = c; tickNow(); }
    catch (e) { mount(page, h('div', { class: 'card' }, h('p', { class: 'err' }, e.message || 'حدث خطأ'), h('a', { class: 'btn', href: '#/' }, 'العودة'))); }
    if (location.hash.replace(/^#/, '').split('?')[0] === path) paintBar(path);
    window.scrollTo(0, 0);
    return;
  }
  mount(page, h('div', { class: 'empty' }, 'الصفحة غير موجودة'));
}

async function boot() {
  try {
    const me = await get('/api/auth/me');
    if (me.server) { state.tz = me.server.tz_offset_min; state.skew = me.server.now - Date.now(); }
    state.user = me.user; state.community = me.community;
  } catch (e) { mount(root, h('div', { class: 'boot' }, e.message)); return; }
  if (state.user) startPolling();
  route();
}

setUnauthorizedHandler(() => { state.user = null; location.hash = '#/login'; boot(); });
window.addEventListener('hashchange', () => { navCount++; route(); });
boot();

// تثبيت المنصة كتطبيق على الجوال (manifest) مع نسخة احتياطية للهيكل عند انقطاع الاتصال
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* */ }));
