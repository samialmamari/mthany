// نواة الواجهة: بناء DOM الآمن، الاتصال بالخادم، النوافذ، والتنسيقات
export const state = { user: null, tz: 240, skew: 0 };

// ---------- بناء DOM (النصوص تُدرج دائماً كنص لا HTML) ----------
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function mount(el, ...kids) { el.replaceChildren(); append(el, kids); }

// ---------- أيقونات (SVG ثابتة آمنة) ----------
const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  history: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.4M3 4v4h4"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M16 4.5a3.5 3.5 0 010 7M18 14.8c2.2.6 3.5 2.3 3.5 5.2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  tasks: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 9l2 2 3.5-4M8 16h8"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  bell: '<path d="M6 16V11a6 6 0 1112 0v5l2 2H4zM10 21h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M4 20h16"/>',
  logout: '<path d="M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4M16 8l4 4-4 4M20 12H9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.3l2-1.5-2-3.4-2.3 1a7 7 0 00-2.3-1.3L14 3h-4l-.3 2.5A7 7 0 007.4 6.8l-2.3-1-2 3.4 2 1.5a7 7 0 000 2.6l-2 1.5 2 3.4 2.3-1a7 7 0 002.3 1.3L10 21h4l.3-2.5a7 7 0 002.3-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z"/>',
  chevL: '<path d="M15 5l-7 7 7 7"/>', chevR: '<path d="M9 5l7 7-7 7"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 016.5 2H20v16H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 16.5h16"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 11.2a2 2 0 002 1.6h7.4a2 2 0 002-1.6L21 7H6"/>',
  tag: '<path d="M3 12.5V4a1 1 0 011-1h8.5L21 11.5 12.5 20z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8h14v-8M8 8a2.5 2.5 0 110-5c2 0 4 5 4 5s2-5 4-5a2.5 2.5 0 110 5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 118 0v3"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || ''; // ثوابت داخلية فقط
  return s;
}

// ---------- الاتصال بالخادم ----------
export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function parse(res) {
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    if (res.status === 401 && state.user) onUnauthorized();
    throw new ApiError(data?.error || 'حدث خطأ، حاول مرة أخرى', res.status, data);
  }
  return data;
}
export async function api(method, url, body) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, init); } catch { throw new ApiError('تعذّر الاتصال بالخادم، تحقق من الإنترنت', 0); }
  return parse(res);
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const put = (u, b) => api('PUT', u, b);
export const patch = (u, b) => api('PATCH', u, b);
export const del = (u) => api('DELETE', u);
export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

/** رفع مع شريط تقدّم */
export function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onerror = () => reject(new ApiError('تعذّر الاتصال بالخادم، تحقق من الإنترنت', 0));
    x.onload = () => {
      let data = {}; try { data = JSON.parse(x.responseText); } catch { /* */ }
      if (x.status >= 200 && x.status < 300) return resolve(data);
      if (x.status === 401 && state.user) onUnauthorized();
      reject(new ApiError(data.error || 'تعذّر الإرسال', x.status, data));
    };
    x.send(formData);
  });
}

// ---------- تنبيهات ونوافذ ----------
export function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}`, role: type === 'err' ? 'alert' : 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}
export const fail = (e) => toast(e?.message || 'حدث خطأ', 'err');

/** اهتزاز خفيف عند اللمس (حيث يدعمه الجهاز) */
export const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch { /* */ } };

/** سحب الورقة السفلية لأسفل لإغلاقها (على الجوال فقط) */
function swipeToClose(box, handles, close) {
  if (!matchMedia('(max-width: 699px)').matches) return;
  let y0 = null; let dy = 0;
  const start = (e) => { y0 = e.touches[0].clientY; dy = 0; box.style.transition = 'none'; };
  const move = (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); box.style.transform = `translateY(${dy}px)`; };
  const end = () => {
    if (y0 == null) return;
    y0 = null; box.style.transition = '';
    if (dy > 110) close(); else box.style.transform = '';
  };
  for (const el of handles) {
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
  }
}

export function modal(title, body, { wide = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); document.body.style.overflow = ''; prevFocus?.focus?.(); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const grabber = h('div', { class: 'grabber', 'aria-hidden': 'true' });
  const head = h('div', { class: 'mh' }, h('h2', {}, title), h('button', { class: 'btn iconbtn', type: 'button', 'aria-label': 'إغلاق', onclick: close }, icon('x')));
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, grabber, head, body);
  swipeToClose(box, [grabber, head], close);
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } }, box);
  document.body.append(ov); document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', esc);
  (box.querySelector('input,select,textarea') || box.querySelector('button'))?.focus();
  return { close, el: box };
}

export function confirmDialog(message, { okText = 'تأكيد', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal('تأكيد', h('div', {},
      h('p', {}, message),
      h('div', { class: 'mf' },
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { finish(true); m.close(); } }, okText),
        h('button', { class: 'btn', onclick: () => { finish(false); m.close(); } }, 'إلغاء'))), { onClose: () => finish(false) });
  });
}

/** يعطّل الزر أثناء تنفيذ عملية غير متزامنة */
export async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { fail(e); } finally { btn.disabled = false; }
}

// ---------- تنسيقات التاريخ والوقت (بتوقيت المنصة) ----------
const nowServer = () => Date.now() + state.skew;
export { nowServer };
const shifted = (ms) => new Date(ms + state.tz * 60_000);
const fmt = (opts) => new Intl.DateTimeFormat('ar-OM-u-nu-latn', { timeZone: 'UTC', ...opts });
export const fmtTime = (ms) => fmt({ hour: 'numeric', minute: '2-digit', hour12: true }).format(shifted(ms));
export const fmtDateTime = (ms) => fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(shifted(ms));
export const fmtDay = (ymd) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ymd + 'T00:00:00Z'));
export const fmtDayShort = (ymd) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ymd + 'T00:00:00Z'));
export const fmtMonth = (ymd) => fmt({ month: 'long', year: 'numeric' }).format(new Date(ymd + 'T00:00:00Z'));
export const todayStr = () => shifted(nowServer()).toISOString().slice(0, 10);
export const addDaysStr = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
export const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export const STATUS = {
  upcoming: ['لم يحن وقته', 'clock'], open: ['متاح للتسجيل', 'clock'], on_time: ['سُجّل في وقته', 'check'],
  missed: ['لم يُسجَّل', 'x'],
};
export const ROLE_LABEL = { admin: 'مدير', supervisor: 'مشرف حلقة', user: 'عضو' };
export const fmtNum = (n) => Number(n).toLocaleString('ar-OM-u-nu-latn');

export function statusBadge(s) {
  const [label, ic] = STATUS[s] || [s, 'clock'];
  return h('span', { class: `badge s-${s}` }, icon(ic), label);
}

/** عدّاد تنازلي حي نحو موعد (مللي ثانية) */
export function countdown(deadline) {
  return h('span', { class: 'countdown num', dataset: { deadline } }, '');
}
function tick() {
  const t = nowServer();
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const d = Number(el.dataset.deadline);
    const diff = d - t;
    el.classList.toggle('over', diff <= 0);
    el.classList.toggle('soon', diff > 0 && diff < 3_600_000);
    if (diff <= 0) { el.textContent = 'انتهى الموعد'; continue; }
    const days = Math.floor(diff / 86_400_000), hh = Math.floor(diff / 3_600_000) % 24, mm = Math.floor(diff / 60_000) % 60, ss = Math.floor(diff / 1000) % 60;
    const p = (n) => String(n).padStart(2, '0');
    el.textContent = days > 0 ? `${days} يوم و${hh} ساعة` : `${p(hh)}:${p(mm)}:${p(ss)}`;
  }
}
setInterval(tick, 1000);
export const tickNow = tick;

export const pct = (v) => (v == null ? '—' : `${v}%`);
export function emptyState(text, ic = 'inbox') { return h('div', { class: 'empty' }, icon(ic), h('div', {}, text)); }

export function stackedBar(c) {
  const total = c.total - (c.upcoming || 0) || 1;
  const seg = (k) => h('i', { class: `b-${k}`, style: `width:${((c[k] || 0) / total) * 100}%`, title: `${STATUS[k][0]}: ${c[k] || 0}` });
  return h('div', { class: 'bar', role: 'img', 'aria-label': `سُجّل في وقته ${c.on_time}، لم يُسجَّل ${c.missed}، متاح ${c.open}` },
    seg('on_time'), seg('missed'), seg('open'));
}
