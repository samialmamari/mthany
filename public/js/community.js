import {
  h, mount, icon, get, post, put, del, api, qs, toast, fail, busy, modal, confirmDialog, state, emptyState,
  fmtDateTime, fmtNum,
} from './core.js';

const go = (hash) => { location.hash = hash; };
export const POST_STATUS = {
  draft: ['مسودة', 'upcoming'], pending: ['بانتظار المراجعة', 'open'], published: ['منشور', 'on_time'],
  rejected: ['مرفوض', 'missed'], needs_edit: ['يحتاج تعديلاً', 'late'], archived: ['مؤرشف', 'exempt'],
};
export const postBadge = (s) => h('span', { class: `badge s-${POST_STATUS[s][1]}` }, POST_STATUS[s][0]);

let cfgCache = null;
export async function communityConfig(force = false) {
  if (!cfgCache || force) cfgCache = await get('/api/community/config');
  return cfgCache;
}

// ---------- عرض نص منسّق بسيط بأمان (عقد نصية فقط، لا HTML) ----------
function inline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] != null ? h('strong', {}, m[1]) : h('em', {}, m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function richText(src, className = 'rich') {
  const box = h('div', { class: className });
  for (const block of String(src).split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
      box.append(h('ul', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*[-•]\s+/, ''))))));
    } else {
      box.append(h('p', {}, lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))));
    }
  }
  return box;
}

const when = (ms) => fmtDateTime(ms);

/** شريط التفاعل: تحديث متفائل فوري ثم مطابقة مع ما يؤكده الخادم */
function reactBar(p, cfg) {
  const bar = h('div', { class: 'reactbar', role: 'group', 'aria-label': 'التفاعل مع الموضوع' });
  let busyNow = false;
  const paint = () => mount(bar, cfg.emojis.map((e) => h('button', {
    class: 'react', type: 'button', dataset: { e }, 'aria-pressed': String(p.my_reaction === e), 'aria-label': `تفاعل ${e}`, disabled: !cfg.can_react, onclick: () => click(e),
  }, e, p.reactions[e] ? h('b', {}, fmtNum(p.reactions[e])) : null)));
  async function click(e) {
    if (busyNow) return;
    const prev = { reactions: { ...p.reactions }, my: p.my_reaction };
    const dec = (k) => { if (p.reactions[k]) { p.reactions[k]--; if (!p.reactions[k]) delete p.reactions[k]; } };
    if (p.my_reaction === e) { dec(e); p.my_reaction = null; }
    else { if (p.my_reaction) dec(p.my_reaction); p.reactions[e] = (p.reactions[e] || 0) + 1; p.my_reaction = e; }
    paint(); bar.querySelector(`[data-e="${e}"]`)?.focus(); busyNow = true;
    try {
      const r = await api('PUT', `/api/community/posts/${p.id}/reaction`, { emoji: p.my_reaction });
      p.reactions = r.reactions; p.my_reaction = r.my_reaction; paint(); bar.querySelector(`[data-e="${e}"]`)?.focus();
    } catch (err) { p.reactions = prev.reactions; p.my_reaction = prev.my; paint(); fail(err); }
    finally { busyNow = false; }
  }
  paint();
  return bar;
}

function reportDialog(p) {
  const reason = h('textarea', { class: 'input', rows: 3, maxlength: 300, placeholder: 'سبب البلاغ (اختياري)' });
  const err = h('div', { class: 'err', hidden: true });
  const ok = h('button', { class: 'btn danger', onclick: () => busy(ok, async () => {
    try { await post(`/api/community/posts/${p.id}/report`, { reason: reason.value }); toast('وصل بلاغك للإدارة، شكراً لك', 'ok'); m.close(); }
    catch (e) { err.textContent = e.message; err.hidden = false; }
  }) }, 'إرسال البلاغ');
  const m = modal('الإبلاغ عن موضوع', h('div', {}, h('p', { class: 'muted' }, `«${p.title}»`), h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'السبب'), reason), err, h('div', { class: 'mf' }, ok)));
}

function postCard(p, { mineView = false, cfg = null } = {}) {
  const long = p.body.length > 420;
  const body = h('div', {});
  const paintBody = (full) => mount(body, richText(full || !long ? p.body : p.body.slice(0, 420) + '…'),
    long ? h('button', { class: 'linkbtn', type: 'button', onclick: () => paintBody(!full) }, full ? 'عرض أقل' : 'قراءة المزيد') : null);
  paintBody(false);
  return h('article', { class: 'card post' },
    h('div', { class: 'row between' },
      h('div', { class: 'row', style: 'gap:.5rem' }, p.pinned ? h('span', { class: 'badge s-late' }, '📌 مثبّت') : null, p.category ? h('span', { class: 'kind' }, p.category.name) : null),
      mineView ? postBadge(p.status) : (cfg && !p.is_mine ? h('button', { class: 'linkbtn small', type: 'button', onclick: () => reportDialog(p) }, '⚑ إبلاغ') : null)),
    h('h3', { class: 'post-title' }, p.title),
    h('div', { class: 'muted small' }, mineView ? `آخر تحديث ${when(p.updated_at)}` : `${p.author.name} · ${when(p.published_at)}`),
    p.has_image ? h('img', { class: 'post-img', src: `/api/community/posts/${p.id}/image?v=${p.updated_at}`, alt: '', loading: 'lazy' }) : null,
    body,
    cfg && p.status === 'published' ? reactBar(p, cfg) : null);
}

// ====================================================== صفحة المجتمع (المنشور فقط)
export async function renderCommunity(root) {
  const cfg = await communityConfig(true);
  const mineBadge = h('span', { class: 'count-pill', hidden: true });
  get('/api/community/mine').then(({ posts }) => {
    const need = posts.filter((p) => p.status === 'needs_edit' || p.status === 'draft').length;
    mineBadge.hidden = !need;
    mineBadge.textContent = String(need);
    if (need) mineBadge.title = 'مواضيع تحتاج إكمالاً أو تعديلاً';
  }).catch(() => {});
  if (!cfg.enabled) { mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'المجتمع')), emptyState('المجتمع غير متاح حالياً', 'users')); return; }
  const out = h('div', { class: 'stack' });
  let page = 1, category = '';
  const q = h('input', { class: 'input', type: 'search', placeholder: 'ابحث في المواضيع…', 'aria-label': 'بحث' });
  const chips = h('div', { class: 'chips' });
  const paintChips = () => mount(chips, [['', 'الكل'], ...cfg.categories.map((c) => [String(c.id), c.name])].map(([v, l]) =>
    h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': String(category === v), onclick: () => { category = v; page = 1; paintChips(); load(); } }, l)));
  async function load() {
    try {
      const d = await get('/api/community/posts' + qs({ page, q: q.value.trim(), category }));
      mount(out, d.posts.length ? d.posts.map((p) => postCard(p, { cfg })) : emptyState(q.value.trim() || category ? 'لا نتائج مطابقة' : 'لا توجد مواضيع منشورة بعد. كن أول من يذكّر بخير أو يطلب دعاءً!', 'users'),
        d.pages > 1 ? h('div', { class: 'row between' },
          h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => { page--; load(); } }, 'السابق'),
          h('span', { class: 'muted' }, `${fmtNum(page)} من ${fmtNum(d.pages)}`),
          h('button', { class: 'btn sm', disabled: page >= d.pages, onclick: () => { page++; load(); } }, 'التالي')) : null);
    } catch (e) { fail(e); }
  }
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'المجتمع'), h('div', { class: 'muted' }, 'مساحة للتذكير بالله والدعاء والتشجيع المتبادل — بعد مراجعة الإدارة')),
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/community/mine' }, icon('edit'), 'مواضيعي', mineBadge),
      cfg.can_post ? h('a', { class: 'btn primary', href: '#/community/new' }, icon('plus'), 'اكتب موضوعاً') : null)),
    h('div', { class: 'card stack' }, q, chips), out);
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { page = 1; load(); }, 250); });
  paintChips();
  await load();
}

// ====================================================== مواضيعي
export async function renderMyPosts(root) {
  const out = h('div', { class: 'stack' });
  async function load() {
    try {
      const { posts } = await get('/api/community/mine');
      mount(out, posts.length ? posts.map((p) => {
        const actions = [];
        if (p.status === 'draft' || p.status === 'needs_edit') actions.push(h('a', { class: 'btn sm primary', href: `#/community/edit/${p.id}` }, icon('edit'), p.status === 'draft' ? 'تعديل وإرسال' : 'تعديل وإعادة الإرسال'));
        if (p.status === 'pending') actions.push(h('button', { class: 'btn sm', onclick: () => act(p, 'withdraw', null, 'سُحب الموضوع إلى المسودات') }, 'سحب للتعديل'));
        if (p.status === 'published') {
          actions.push(h('a', { class: 'btn sm', href: `#/community/edit/${p.id}` }, 'تعديل (يعيده للمراجعة)'));
          actions.push(p.delete_requested ? h('span', { class: 'badge s-open' }, 'تم طلب الحذف') : h('button', { class: 'btn sm danger', onclick: () => requestDelete(p) }, 'طلب حذف'));
        }
        if (['draft', 'needs_edit', 'rejected'].includes(p.status)) actions.push(h('button', { class: 'btn sm danger', onclick: () => remove(p) }, 'حذف'));
        return h('div', {}, postCard(p, { mineView: true, cfg: null }),
          p.status === 'rejected' || p.status === 'needs_edit' ? h('div', { class: 'decision ' + (p.status === 'rejected' ? 'bad' : 'late') },
            h('strong', {}, p.status === 'rejected' ? 'سبب الرفض: ' : 'ملاحظات الإدارة: '), p.decision_note || (p.status === 'rejected' ? 'لم تُذكر أسباب.' : '—')) : null,
          p.status === 'published' ? h('div', { class: 'muted small', style: 'margin-top:.3rem' }, `تفاعلات: ${fmtNum(p.total_reactions)}`) : null,
          actions.length ? h('div', { class: 'row', style: 'margin-top:.5rem' }, actions) : null);
      }) : emptyState('لم تكتب أي موضوع بعد', 'edit'));
    } catch (e) { fail(e); }
  }
  async function act(p, action, body, msg) {
    try { await post(`/api/community/posts/${p.id}/${action}`, body); toast(msg, 'ok'); load(); } catch (e) { fail(e); }
  }
  async function remove(p) {
    if (!(await confirmDialog(`حذف «${p.title}» نهائياً؟`, { danger: true, okText: 'حذف' }))) return;
    try { await del(`/api/community/posts/${p.id}`); toast('تم الحذف', 'ok'); load(); } catch (e) { fail(e); }
  }
  async function requestDelete(p) {
    if (!(await confirmDialog('سيصل طلب الحذف إلى الإدارة وتقرر بشأنه. متابعة؟', { okText: 'إرسال الطلب' }))) return;
    try { await post(`/api/community/posts/${p.id}/request-delete`); toast('أُرسل طلب الحذف للإدارة', 'ok'); load(); } catch (e) { fail(e); }
  }
  mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'مواضيعي'), h('div', { class: 'muted' }, 'حالة كل موضوع كتبته وملاحظات الإدارة')),
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/community' }, icon('chevR'), 'المجتمع'), h('a', { class: 'btn primary', href: '#/community/new' }, icon('plus'), 'اكتب موضوعاً'))), out);
  await load();
}

// ====================================================== قواعد المجتمع (أول كتابة)
function termsDialog(cfg) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const agree = h('input', { type: 'checkbox' });
    const ok = h('button', { class: 'btn primary', disabled: true, onclick: () => busy(ok, async () => { await post('/api/community/accept-terms'); cfg.terms_accepted = true; finish(true); m.close(); }) }, 'موافق وأبدأ الكتابة');
    agree.addEventListener('change', () => { ok.disabled = !agree.checked; });
    const m = modal('قواعد المجتمع', h('div', {}, richText(cfg.rules_text), h('label', { class: 'check', style: 'margin-top:.8rem' }, agree, 'قرأت القواعد وأوافق عليها'), h('div', { class: 'mf' }, ok)), { onClose: () => finish(false) });
  });
}

// ====================================================== محرر الموضوع
export async function renderEditor(root, id) {
  const cfg = await communityConfig(true);
  if (!cfg.enabled) return go('#/community');
  if (!cfg.can_post) { mount(root, h('div', { class: 'card' }, h('p', { class: 'err' }, 'تم إيقاف صلاحية الكتابة في المجتمع لحسابك.'), h('a', { class: 'btn', href: '#/community' }, 'رجوع'))); return; }
  let p = null;
  if (id) {
    try { p = (await get(`/api/community/posts/${id}`)).post; } catch (e) { mount(root, h('div', { class: 'card' }, h('p', { class: 'err' }, e.message), h('a', { class: 'btn', href: '#/community/mine' }, 'رجوع'))); return; }
    if (!p.is_mine || !['draft', 'needs_edit', 'published'].includes(p.status)) { mount(root, h('div', { class: 'card' }, h('p', {}, 'لا يمكن تعديل هذا الموضوع الآن.'), h('a', { class: 'btn', href: '#/community/mine' }, 'رجوع'))); return; }
  }
  const editingPublished = p?.status === 'published';
  const title = h('input', { class: 'input', maxlength: 120, value: p?.title || '', placeholder: 'عنوان الموضوع' });
  const body = h('textarea', { class: 'input', rows: 10, maxlength: 5000, placeholder: 'اكتب فائدة أو طلب دعاء أو كلمة تشجيع…' }, p?.body || '');
  const cat = h('select', { class: 'input' }, h('option', { value: '' }, 'اختر التصنيف'), cfg.categories.map((c) => h('option', { value: c.id, selected: p?.category?.id === c.id }, c.name)));
  const counter = h('span', { class: 'muted small num' });
  const upd = () => { counter.textContent = `${fmtNum(body.value.length)} / ${fmtNum(5000)}`; };
  body.addEventListener('input', upd); upd();
  const wrap = (a, b = a) => { const s = body.selectionStart, e = body.selectionEnd, v = body.value; body.value = v.slice(0, s) + a + v.slice(s, e) + b + v.slice(e); body.focus(); body.setSelectionRange(s + a.length, e + a.length); upd(); };
  const bullet = () => { const s = body.selectionStart; const v = body.value; const ls = v.lastIndexOf('\n', s - 1) + 1; body.value = v.slice(0, ls) + '- ' + v.slice(ls); body.focus(); upd(); };
  const toolbar = h('div', { class: 'row', style: 'gap:.3rem;margin-bottom:.3rem' },
    h('button', { class: 'btn sm', type: 'button', title: 'غامق', onclick: () => wrap('**') }, h('b', {}, 'B')),
    h('button', { class: 'btn sm', type: 'button', title: 'مائل', onclick: () => wrap('*') }, h('i', {}, 'I')),
    h('button', { class: 'btn sm', type: 'button', title: 'قائمة نقطية', onclick: bullet }, '• قائمة'));

  let file = null; let removeImage = false;
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', hidden: true });
  const preview = h('div');
  const paintImg = () => mount(preview,
    file ? h('div', { class: 'row' }, h('img', { class: 'thumb', style: 'width:72px;height:72px', src: URL.createObjectURL(file), alt: '' }), h('span', { class: 'small' }, file.name), h('button', { class: 'btn sm', type: 'button', onclick: () => { file = null; paintImg(); } }, 'إزالة'))
      : p?.has_image && !removeImage ? h('div', { class: 'row' }, h('img', { class: 'thumb', style: 'width:72px;height:72px', src: `/api/community/posts/${p.id}/image?v=${p.updated_at}`, alt: '' }), h('button', { class: 'btn sm', type: 'button', onclick: () => { removeImage = true; paintImg(); } }, 'إزالة الصورة'))
        : null);
  fileInput.addEventListener('change', () => { file = fileInput.files[0] || null; removeImage = false; if (file && file.size > 5 * 1024 * 1024) { toast('الصورة أكبر من 5 ميغابايت', 'err'); file = null; } paintImg(); });
  paintImg();

  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  async function save(submit) {
    err.hidden = true;
    if (submit && !cfg.terms_accepted && !(await termsDialog(cfg))) return;
    if (editingPublished && !(await confirmDialog('تعديل موضوع منشور يسحبه من المجتمع حتى تراجعه الإدارة من جديد. متابعة؟', { okText: 'تعديل وإرسال للمراجعة' }))) return;
    const fd = new FormData();
    fd.append('title', title.value); fd.append('body', body.value); fd.append('category_id', cat.value); fd.append('submit', submit || editingPublished ? '1' : '0');
    if (file) fd.append('image', file); if (removeImage) fd.append('remove_image', '1');
    try {
      const r = await api(id ? 'PUT' : 'POST', id ? `/api/community/posts/${id}` : '/api/community/posts', fd);
      toast(r.post.status === 'pending' ? 'أُرسل موضوعك للمراجعة' : r.post.status === 'published' ? 'نُشر موضوعك' : 'تم حفظ المسودة', 'ok');
      go('#/community/mine');
    } catch (e) {
      if (e.data?.code === 'terms') { if (await termsDialog(cfg)) return save(submit); return; }
      err.textContent = e.message; err.hidden = false; err.scrollIntoView({ block: 'center' });
      if (e.data?.saved_as_draft) toast('حُفظ الموضوع كمسودة', 'ok');
    }
  }
  const btnSend = h('button', { class: 'btn primary', type: 'button' }, editingPublished ? 'تعديل وإرسال للمراجعة' : 'إرسال للمراجعة');
  const btnDraft = h('button', { class: 'btn', type: 'button' }, 'حفظ كمسودة');
  btnSend.addEventListener('click', () => busy(btnSend, () => save(true)));
  btnDraft.addEventListener('click', () => busy(btnDraft, () => save(false)));
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, id ? 'تعديل الموضوع' : 'موضوع جديد'), h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/community/mine' }, 'إلغاء'))),
    p?.status === 'needs_edit' ? h('div', { class: 'decision late', style: 'margin-bottom:1rem' }, h('strong', {}, 'ملاحظات الإدارة: '), p.decision_note) : null,
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'العنوان'), title),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'التصنيف'), cat),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'المحتوى'), toolbar, body, h('div', { class: 'row between' }, h('span', { class: 'hint muted small' }, 'يمكنك استخدام **غامق** و*مائل* وقوائم بسيطة.'), counter)),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'صورة (اختيارية)'), h('button', { class: 'btn sm', type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'اختيار صورة'), fileInput, h('div', { style: 'margin-top:.5rem' }, preview)),
      h('p', { class: 'muted small' }, `يخضع الموضوع لمراجعة الإدارة قبل ظهوره. المتبقي لك اليوم: ${fmtNum(Math.max(0, cfg.daily_limit - cfg.posts_today))} من ${fmtNum(cfg.daily_limit)}.`),
      err, h('div', { class: 'row' }, btnSend, editingPublished ? null : btnDraft)));
}
