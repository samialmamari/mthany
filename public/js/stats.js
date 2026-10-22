import { h, mount, icon, get, fail, fmtNum, fmtDayShort, fmtMonth, todayStr, emptyState, WEEKDAYS } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
let uid = 0;

const short = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : fmtNum(n));
const axisDate = (d) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`;

/** سلّم المحور الرأسي بخطوات 1/2/5 × 10^k */
function scale(vmax, percent) {
  if (percent) return { step: 25, max: 100 };
  if (vmax <= 0) return { step: 1, max: 4 };
  const rough = vmax / 4, p = 10 ** Math.floor(Math.log10(rough)), f = rough / p;
  const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
  return { step, max: Math.ceil(vmax / step) * step };
}

/**
 * مخطط خطي بأسلوب مؤشر الأسهم: كل قطعة خضراء عند الصعود وحمراء عند الهبوط،
 * مع مساحة خفيفة تحت الخط ونقطة تفاعلية وتلميح عند المرور/اللمس.
 */
function drawChart(box, tip, pts, opt) {
  const W = Math.max(240, box.clientWidth), H = 220;
  const m = { l: 40, r: 14, t: 16, b: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const { step, max } = scale(Math.max(...pts.map((p) => p.value), opt.target || 0), false);
  const x = (i) => m.l + (pts.length === 1 ? iw / 2 : (i * iw) / (pts.length - 1));
  const y = (v) => m.t + ih - (v / max) * ih;
  const id = `g${++uid}`;
  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opt.label });

  svg.append(sv('defs', {}, sv('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
    sv('stop', { offset: '0%', style: 'stop-color:var(--primary);stop-opacity:.22' }), sv('stop', { offset: '100%', style: 'stop-color:var(--primary);stop-opacity:0' }))));

  for (let v = 0; v <= max + 1e-9; v += step) {
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), style: 'stroke:var(--line)', 'stroke-dasharray': v === 0 ? '' : '3 4' }));
    const t = sv('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', style: 'fill:var(--muted);font-size:11px' }); t.textContent = short(v);
    svg.append(t);
  }
  const every = Math.ceil(pts.length / Math.max(2, Math.floor(iw / 62)));
  pts.forEach((p, i) => {
    if (i % every && i !== pts.length - 1) return;
    if (i === pts.length - 1 && i % every && pts.length - 1 - (i - (i % every)) < every / 2) return;
    const t = sv('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', style: 'fill:var(--muted);font-size:11px' }); t.textContent = axisDate(p.date);
    svg.append(t);
  });

  const base = y(0);
  if (opt.target) { // خط الهدف اليومي
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(opt.target), y2: y(opt.target), 'stroke-width': 1.5, 'stroke-dasharray': '6 4', style: 'stroke:var(--primary);opacity:.7' }));
    const tl = sv('text', { x: W - m.r, y: y(opt.target) - 5, 'text-anchor': 'end', style: 'fill:var(--primary);font-size:11px;font-weight:700' }); tl.textContent = `الهدف ${short(opt.target)}`;
    svg.append(tl);
  }
  const area = `M${x(0)},${base} ` + pts.map((p, i) => `L${x(i)},${y(p.value)}`).join(' ') + ` L${x(pts.length - 1)},${base} Z`;
  if (pts.length > 1) svg.append(sv('path', { d: area, fill: `url(#${id})` }));
  for (let i = 1; i < pts.length; i++) {
    const up = pts[i].value > pts[i - 1].value, down = pts[i].value < pts[i - 1].value;
    svg.append(sv('line', { x1: x(i - 1), y1: y(pts[i - 1].value), x2: x(i), y2: y(pts[i].value), 'stroke-width': 2.5, 'stroke-linecap': 'round', style: `stroke:var(--c-${up ? 'ok' : down ? 'bad' : 'exempt'})` }));
  }
  const dots = pts.length <= 45;
  pts.forEach((p, i) => {
    const last = i === pts.length - 1;
    if (!dots && !last) return;
    if (last) svg.append(sv('circle', { cx: x(i), cy: y(p.value), r: 8, style: 'fill:var(--primary);opacity:.15' }));
    svg.append(sv('circle', { cx: x(i), cy: y(p.value), r: last ? 4.5 : 3, style: 'fill:var(--surface);stroke:var(--primary);stroke-width:2' }));
  });

  // تفاعل
  const guide = sv('line', { y1: m.t, y2: base, style: 'stroke:var(--muted);stroke-dasharray:3 3', visibility: 'hidden' });
  const hot = sv('circle', { r: 6, style: 'fill:var(--primary);stroke:var(--surface);stroke-width:2', visibility: 'hidden' });
  const hit = sv('rect', { x: m.l, y: 0, width: iw, height: H, fill: 'transparent', style: 'touch-action:pan-y' });
  svg.append(guide, hot, hit);
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = pts.length === 1 ? 0 : Math.min(pts.length - 1, Math.max(0, Math.round(((px - m.l) / iw) * (pts.length - 1))));
    const p = pts[i];
    guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', x(i)); hot.setAttribute('cy', y(p.value)); hot.setAttribute('visibility', 'visible');
    mount(tip, h('b', {}, fmtDayShort(p.date)), h('div', {}, `${fmtNum(p.value)} ${opt.unit}${opt.target && p.value >= opt.target ? ' ✓' : ''}`));
    tip.hidden = false;
    tip.style.left = `${Math.min(W - 70, Math.max(70, x(i)))}px`;
    tip.style.top = `${y(p.value)}px`;
  };
  const hide = () => { guide.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  box.replaceChildren(svg, tip);
}

function chart(pts, opt) {
  const box = h('div', { class: 'chartbox' });
  const tip = h('div', { class: 'tip', hidden: true });
  if (pts.length < 2) {
    box.classList.add('thin');
  }
  let raf = 0, lastW = 0;
  const paint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { lastW = box.clientWidth; if (lastW) drawChart(box, tip, pts, opt); }); };
  new ResizeObserver(() => { if (box.clientWidth !== lastW) paint(); }).observe(box);
  paint();
  return box;
}

const tile = (v, l, cls = '') => h('div', { class: `tile ${cls}` }, h('div', { class: 'v num' }, v), h('div', { class: 'l' }, l));

function deltaBadge(d) {
  if (d == null) return h('span', { class: 'badge s-upcoming' }, 'لا مقارنة بعد');
  if (d === 0) return h('span', { class: 'badge s-upcoming' }, '— ثابت');
  return h('span', { class: `badge ${d > 0 ? 's-on_time' : 's-missed'}`, title: 'مقارنة متوسط آخر 7 أيام بالـ 7 السابقة' }, `${d > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(d))}%`);
}

function taskCard(t) {
  const s = t.summary;
  const pts = t.points;
  return h('article', { class: 'card statcard' },
    h('div', { class: 'row between' },
      h('div', {}, h('h3', { style: 'margin:0' }, t.title), h('div', { class: 'num' }, h('span', { class: 'big' }, fmtNum(s.total)), ' ', h('span', { class: 'muted' }, `${t.count_unit} في الفترة`))),
      h('div', { style: 'text-align:end' }, deltaBadge(s.delta), h('div', { class: 'muted small' }, 'مقابل الأسبوع السابق'))),
    h('div', { class: 'stat-tiles' },
      tile(s.average == null ? '—' : fmtNum(s.average), `متوسط ${t.count_unit}/يوم`),
      tile(s.best ? fmtNum(s.best.value) : '—', s.best ? `أعلى يوم (${fmtDayShort(s.best.date)})` : 'أعلى يوم'),
      t.target_count ? tile(fmtNum(s.goal_days), `أيام بلغت فيها الهدف (${fmtNum(t.target_count)})`) : tile(fmtNum(s.on_time), 'أيام سجّلتها'),
      tile(fmtNum(s.streak), 'أيام متتالية', s.streak >= 3 ? 'hot' : '')),
    pts.length ? chart(pts, { unit: t.count_unit, target: t.target_count, label: `مخطط ${t.title}: عدد ${t.count_unit} يومياً` }) : h('p', { class: 'muted' }, 'لا بيانات بعد — ستظهر الرسوم بعد أول تسجيل.'),
    pts.length === 1 ? h('p', { class: 'muted small' }, 'يلزم يومان على الأقل لرسم خط التقدّم.') : null,
    pts.length ? h('details', { class: 'small' }, h('summary', { class: 'muted' }, 'عرض البيانات كجدول'),
      h('div', { class: 'tablewrap', style: 'margin-top:.5rem;max-height:260px;overflow:auto' }, h('table', { class: 't', style: 'min-width:0' },
        h('thead', {}, h('tr', {}, h('th', {}, 'التاريخ'), h('th', {}, t.count_unit))),
        h('tbody', {}, [...pts].reverse().map((p) => h('tr', {}, h('td', {}, fmtDayShort(p.date)), h('td', { class: 'num' }, fmtNum(p.value)))))))) : null);
}

/** تقويم شهري يلوّن كل يوم بنسبة الإنجاز */
function heatmapCard(days) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const months = [...new Set(days.map((d) => d.date.slice(0, 7)))].slice(-3);
  const today = todayStr();
  const level = (p) => (p === 0 ? 'l1' : p < 50 ? 'l2' : p < 100 ? 'l3' : 'l4');
  const grid = (ym) => {
    const first = `${ym}-01`;
    const startDow = new Date(`${first}T00:00:00Z`).getUTCDay();
    const dim = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push(h('div', { class: 'cell empty' }));
    for (let d = 1; d <= dim; d++) {
      const date = `${ym}-${String(d).padStart(2, '0')}`;
      const info = byDate.get(date);
      cells.push(h('div', {
        class: ['cell', info ? level(info.percent) : '', date === today ? 'today' : ''].filter(Boolean).join(' '),
        title: info ? `${fmtDayShort(date)}: ${fmtNum(info.done)} من ${fmtNum(info.total)} (${fmtNum(info.percent)}%)` : fmtDayShort(date),
      }, fmtNum(d)));
    }
    return h('div', {}, h('div', { style: 'font-weight:700;margin:.6rem 0 .4rem' }, fmtMonth(first)),
      h('div', { class: 'heat' }, ['أحد', 'اثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'].map((w) => h('div', { class: 'dh' }, w)), cells));
  };
  return h('section', { class: 'card' }, h('h3', {}, 'تقويم المواظبة'),
    h('p', { class: 'muted small' }, 'كل مربع يوم: كلما اكتمل وردك اشتدّ لون اليوم.'),
    months.map(grid),
    h('div', { class: 'heatlegend' }, 'لم يُسجَّل',
      h('i', { style: 'background:var(--accent-soft)' }), h('i', { style: 'background:#e6edd7' }), h('i', { style: 'background:#cfe0b4' }), h('i', { style: 'background:var(--c-ok)' }), 'مكتمل'));
}

/** المجاميع منذ البداية: الاستغفار التراكمي، الختمات… */
function cumulativeCard(rows, streak) {
  return h('section', {}, h('h2', {}, 'حصادك منذ البداية'),
    h('div', { class: 'grid g3' },
      streak ? h('div', { class: 'card kpi' }, h('div', { class: 'v', style: 'color:var(--accent)' }, `🔥 ${fmtNum(streak)}`), h('div', { class: 'l' }, 'يوماً متتالياً')) : null,
      ...rows.map((c) => h('div', { class: 'card kpi' },
        h('div', { class: 'v' }, fmtNum(c.total)),
        h('div', { class: 'l' }, `${c.unit} · ${c.title}`),
        c.mushaf ? h('div', { class: 'muted small num', style: 'margin-top:.3rem' }, `ختمات: ${fmtNum(c.mushaf.khatmat)} · الجزء ${fmtNum(c.mushaf.juz)}`) : null))));
}

export async function renderStats(root) {
  let days = 30;
  const out = h('div', { class: 'stack-lg' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'الفترة' });
  const paintSeg = () => mount(seg, [[7, '7 أيام'], [30, '30 يوماً'], [90, '90 يوماً']].map(([d, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(days === d), onclick: () => { days = d; paintSeg(); load(); } }, l)));

  async function load() {
    try {
      const d = await get(`/api/my/stats?days=${days}`);
      const o = d.overall;
      mount(out,
        h('div', { class: 'grid g3' },
          h('div', { class: 'card kpi' }, h('div', { class: 'v' }, o.compliance == null ? '—' : `${fmtNum(o.compliance)}%`), h('div', { class: 'l' }, 'مواظبتك على أورادك')),
          h('div', { class: 'card kpi ok' }, h('div', { class: 'v' }, fmtNum(o.on_time)), h('div', { class: 'l' }, 'مرات سجّلت فيها وردك')),
          h('div', { class: 'card kpi' }, h('div', { class: 'v' }, fmtNum(o.missed)), h('div', { class: 'l' }, 'أيام لم تسجّلها بعد'))),
        d.cumulative?.length ? cumulativeCard(d.cumulative, d.streak) : null,
        d.heatmap?.length ? heatmapCard(d.heatmap) : null,
        d.tasks.length ? h('section', {}, h('h2', {}, 'تفاصيل كل ورد'), h('div', { class: 'stack-lg' }, d.tasks.map(taskCard))) : emptyState('لا أوراد مسندة إليك بعد', 'chart'));
    } catch (e) { fail(e); }
  }
  paintSeg();
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'إحصاءاتي'), h('div', { class: 'muted' }, 'تابع تقدّمك في كل ورد يوماً بيوم')), h('div', { class: 'actions' }, seg)), out);
  await load();
}
