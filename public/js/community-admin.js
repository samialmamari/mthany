import {
  h, mount, icon, get, post, put, patch, del, qs, toast, fail, busy, modal, confirmDialog, state, emptyState, fmtDateTime, fmtNum,
} from './core.js';
import { postBadge, richText } from './community.js';

const POST_TABS = [['pending', 'بانتظار المراجعة'], ['published', 'منشور'], ['needs_edit', 'مُعادة للتعديل'], ['rejected', 'مرفوض'], ['archived', 'مؤرشف']];
const ADMIN_TABS = [['reports', 'بلاغات'], ['stats', 'إحصاءات'], ['audit', 'سجل القرارات'], ['settings', 'الإعدادات']];
const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);

const AUDIT = {
  'community.publish': 'نشر موضوع', 'community.reject': 'رفض موضوع', 'community.return': 'إعادة موضوع للتعديل', 'community.archive': 'أرشفة موضوع', 'community.restore': 'استعادة موضوع',
  'community.delete': 'حذف موضوع', 'community.pin': 'تثبيت موضوع', 'community.unpin': 'إلغاء تثبيت', 'community.settings': 'تعديل إعدادات المجتمع', 'community.ban': 'تقييد مستخدم',
  'community.unban': 'رفع التقييد', 'community.category_add': 'إضافة تصنيف', 'community.category_edit': 'تعديل تصنيف', 'community.category_delete': 'حذف تصنيف',
  'community.reports_dismissed': 'تجاهل بلاغات', 'community.reports_actioned': 'معالجة بلاغات', 'community.request_delete': 'طلب حذف من الكاتب', 'community.author_delete': 'حذف من الكاتب',
  'community.dismiss_delete_request': 'تجاهل طلب حذف', 'community.submit': 'إرسال للمراجعة', 'community.withdraw': 'سحب للمسودة', 'community.edit_published': 'تعديل موضوع منشور',
};

function askText(title, label, { required = false, okText = 'تأكيد', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = h('textarea', { class: 'input', rows: 3, maxlength: 500 });
    const err = h('div', { class: 'err', hidden: true });
    const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { if (required && !t.value.trim()) { err.textContent = 'هذا الحقل مطلوب'; err.hidden = false; return; } finish(t.value.trim()); m.close(); } }, okText);
    const m = modal(title, h('div', {}, field(label, t), err, h('div', { class: 'mf' }, ok)), { onClose: () => finish(null) });
  });
}

function reactSummary(p) {
  const entries = Object.entries(p.reactions);
  return h('div', { class: 'row small', style: 'gap:.4rem' },
    entries.length ? entries.map(([e, c]) => h('span', { class: 'kind' }, `${e} ${fmtNum(c)}`)) : h('span', { class: 'muted' }, 'لا تفاعلات بعد'),
    entries.length ? h('button', { class: 'linkbtn', onclick: async () => {
      try {
        const { reactions } = await get(`/api/community/admin/posts/${p.id}/reactions`);
        modal('من تفاعل؟', h('div', { class: 'stack' }, Object.entries(reactions).map(([e, us]) => h('div', {}, h('strong', {}, `${e} (${fmtNum(us.length)})`), h('div', { class: 'muted small' }, us.map((u) => u.name).join('، '))))));
      } catch (err) { fail(err); }
    } }, 'عرض من تفاعل') : null);
}

function banDialog(author, onDone) {
  const pb = h('input', { type: 'checkbox', checked: true }); const rb = h('input', { type: 'checkbox' });
  const reason = h('input', { class: 'input', placeholder: 'السبب (اختياري، يظهر للمستخدم)', maxlength: 300 });
  const ok = h('button', { class: 'btn danger', onclick: () => busy(ok, async () => {
    await put(`/api/community/admin/bans/${author.id}`, { post_banned: pb.checked, react_banned: rb.checked, reason: reason.value });
    toast('تم تقييد المستخدم', 'ok'); m.close(); onDone?.();
  }) }, 'تطبيق التقييد');
  const m = modal(`تقييد ${author.name}`, h('div', {}, h('label', { class: 'check' }, pb, 'منع الكتابة'), h('label', { class: 'check' }, rb, 'منع التفاعل أيضاً'), field('السبب', reason), h('div', { class: 'mf' }, ok)));
}

export async function renderCommunityAdmin(root, query, onChange) {
  const isAdmin = state.user.role === 'admin';
  const TABS = [...POST_TABS, ...(isAdmin ? ADMIN_TABS : [])];
  let tab = TABS.some(([k]) => k === query.get('tab')) ? query.get('tab') : 'pending';
  let page = 1; const selected = new Set(); let counts = {};
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const out = h('div', { class: 'stack' });
  const q = h('input', { class: 'input', type: 'search', placeholder: 'بحث في المواضيع أو الكُتّاب…', style: 'max-width:340px' });
  const isPostTab = () => POST_TABS.some(([k]) => k === tab);
  const badge = { reports: counts.reports };

  const paintTabs = () => mount(tabs, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; page = 1; selected.clear(); paintTabs(); load(); } },
    l, counts[k] ? h('span', { class: 'count-pill' }, fmtNum(counts[k])) : null)));

  const refresh = async () => { await load(); onChange?.(); };
  async function act(p, action, { confirm, okText, danger } = {}) {
    if (confirm && !(await confirmDialog(confirm, { okText, danger }))) return;
    try { await post(`/api/community/admin/posts/${p.id}/${action}`, {}); toast('تم', 'ok'); await refresh(); } catch (e) { fail(e); }
  }
  async function decide(p, action) {
    let note = '';
    if (action === 'reject') { note = await askText('رفض الموضوع', 'سبب الرفض (اختياري)', { okText: 'رفض', danger: true }); if (note === null) return; }
    if (action === 'return') { note = await askText('إعادة للتعديل', 'ملاحظات للمستخدم (مطلوبة)', { required: true, okText: 'إعادة للمستخدم' }); if (note === null) return; }
    try { await post(`/api/community/admin/posts/${p.id}/${action}`, { note }); toast(action === 'publish' ? 'تم النشر' : action === 'reject' ? 'تم الرفض' : 'أُعيد للمستخدم', 'ok'); await refresh(); } catch (e) { fail(e); }
  }
  async function bulk(action) {
    if (!selected.size) return toast('حدّد مواضيع أولاً', 'err');
    let note = '';
    if (action === 'reject') { note = await askText(`رفض ${fmtNum(selected.size)} مواضيع`, 'سبب الرفض (اختياري)', { okText: 'رفض الكل', danger: true }); if (note === null) return; }
    else if (!(await confirmDialog(`نشر ${fmtNum(selected.size)} مواضيع؟`, { okText: 'نشر الكل' }))) return;
    try { const r = await post('/api/community/admin/posts/bulk', { ids: [...selected], action, note }); toast(`تم: ${fmtNum(r.done)}${r.failed ? ` · تعذّر: ${fmtNum(r.failed)}` : ''}`, r.failed ? 'err' : 'ok'); selected.clear(); await refresh(); } catch (e) { fail(e); }
  }

  function card(p, { reports } = {}) {
    const btns = [];
    if (['pending', 'rejected', 'needs_edit', 'archived'].includes(p.status)) btns.push(h('button', { class: 'btn sm primary', onclick: () => decide(p, 'publish') }, icon('check'), p.status === 'archived' ? 'نشر من جديد' : 'نشر'));
    if (p.status === 'pending') btns.push(h('button', { class: 'btn sm danger', onclick: () => decide(p, 'reject') }, 'رفض'));
    if (['pending', 'published'].includes(p.status)) btns.push(h('button', { class: 'btn sm', onclick: () => decide(p, 'return') }, 'إعادة للتعديل'));
    if (isAdmin) {
      if (p.status === 'published') btns.push(h('button', { class: 'btn sm', onclick: () => act(p, p.pinned ? 'unpin' : 'pin') }, p.pinned ? '📌 إلغاء التثبيت' : '📌 تثبيت'));
      if (p.status === 'published') btns.push(h('button', { class: 'btn sm', onclick: () => act(p, 'archive', { confirm: 'أرشفة الموضوع؟ يختفي من المجتمع ويمكن استعادته.', okText: 'أرشفة' }) }, 'أرشفة'));
      if (p.delete_requested) btns.push(h('button', { class: 'btn sm', onclick: () => act(p, 'dismiss_delete') }, 'تجاهل طلب الحذف'));
      btns.push(h('button', { class: 'btn sm danger', onclick: () => act(p, 'delete', { confirm: `حذف «${p.title}» نهائياً؟ لا يمكن التراجع.`, okText: 'حذف نهائي', danger: true }) }, 'حذف'));
      btns.push(h('button', { class: 'btn sm', onclick: () => banDialog(p.author, refresh) }, 'تقييد الكاتب'));
    }
    return h('article', { class: 'card post' },
      h('div', { class: 'row between' },
        h('div', { class: 'row', style: 'gap:.5rem' },
          tab === 'pending' ? h('input', { type: 'checkbox', 'aria-label': 'تحديد', checked: selected.has(p.id), onchange: (e) => { e.target.checked ? selected.add(p.id) : selected.delete(p.id); paintBulk(); } }) : null,
          p.category ? h('span', { class: 'kind' }, p.category.name) : null, postBadge(p.status), p.pinned ? h('span', { class: 'badge s-late' }, '📌 مثبّت') : null,
          p.auto_published ? h('span', { class: 'kind' }, 'نشر تلقائي') : null, p.delete_requested ? h('span', { class: 'badge s-open' }, 'طلب حذف') : null,
          p.open_reports ? h('span', { class: 'badge s-missed' }, `${fmtNum(p.open_reports)} بلاغ`) : null),
        h('span', { class: 'muted small' }, `${p.author.name} · ${fmtDateTime(p.submitted_at || p.created_at)}`)),
      h('h3', { class: 'post-title' }, p.title),
      p.has_image ? h('img', { class: 'post-img', src: `/api/community/posts/${p.id}/image?v=${p.updated_at}`, alt: '', loading: 'lazy' }) : null,
      richText(p.body),
      p.status === 'published' ? reactSummary(p) : null,
      p.decision_note ? h('div', { class: 'decision late' }, h('strong', {}, 'ملاحظة القرار: '), p.decision_note) : null,
      reports ? h('div', { class: 'decision bad' }, h('strong', {}, 'البلاغات:'), h('ul', { style: 'margin:.3rem 0 0;padding-inline-start:1.2rem' }, reports.map((r) => h('li', {}, `${r.reporter}: ${r.reason || 'بلا سبب'}`)))) : null,
      reports ? h('div', { class: 'row', style: 'margin-top:.4rem' },
        h('button', { class: 'btn sm', onclick: () => resolveReports(p, 'dismissed') }, 'تجاهل البلاغات'),
        p.status === 'published' && isAdmin ? h('button', { class: 'btn sm', onclick: async () => { await resolveReports(p, 'actioned', true); await act(p, 'archive'); } }, 'أرشفة الموضوع') : null,
        isAdmin ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(`حذف «${p.title}» نهائياً؟`, { danger: true, okText: 'حذف' })) { await resolveReports(p, 'actioned', true); await act(p, 'delete'); } } }, 'حذف') : null,
        isAdmin ? h('button', { class: 'btn sm', onclick: () => banDialog(p.author, refresh) }, 'تقييد الكاتب') : null)
        : (btns.length ? h('div', { class: 'row', style: 'margin-top:.4rem' }, btns) : null));
  }
  async function resolveReports(p, action, silent) {
    try { await post(`/api/community/admin/posts/${p.id}/reports/resolve`, { action }); if (!silent) { toast('تمت المعالجة', 'ok'); await refresh(); } } catch (e) { fail(e); }
  }

  const bulkBar = h('div', { class: 'row card', hidden: true, style: 'position:sticky;top:.5rem;z-index:5' });
  function paintBulk() {
    bulkBar.hidden = tab !== 'pending' || !selected.size;
    mount(bulkBar, h('strong', {}, `${fmtNum(selected.size)} محدد`), h('button', { class: 'btn sm primary', onclick: () => bulk('publish') }, 'نشر المحدد'), h('button', { class: 'btn sm danger', onclick: () => bulk('reject') }, 'رفض المحدد'), h('button', { class: 'btn sm', onclick: () => { selected.clear(); load(); } }, 'إلغاء التحديد'));
  }
  const pager = (d) => (d.pages > 1 ? h('div', { class: 'row between' }, h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => { page--; load(); } }, 'السابق'), h('span', { class: 'muted' }, `${fmtNum(page)} من ${fmtNum(d.pages)}`),
    h('button', { class: 'btn sm', disabled: page >= d.pages, onclick: () => { page++; load(); } }, 'التالي')) : null);

  // ---------- المحتوى حسب التبويب ----------
  async function showPosts() {
    const d = await get('/api/community/admin/posts' + qs({ status: tab, page, q: q.value.trim() }));
    paintBulk();
    mount(out, bulkBar,
      tab === 'pending' && d.posts.length ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { d.posts.forEach((p) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id))); showPosts(); } }), 'تحديد كل ما في الصفحة') : null,
      d.posts.length ? d.posts.map((p) => card(p)) : emptyState(tab === 'pending' ? 'لا توجد مواضيع بانتظار المراجعة 🎉' : 'لا توجد مواضيع', 'inbox'), pager(d));
  }
  async function showReports() {
    const { posts } = await get('/api/community/admin/reports');
    mount(out, posts.length ? posts.map((p) => card(p, { reports: p.reports })) : emptyState('لا توجد بلاغات مفتوحة', 'check'));
  }
  async function showStats() {
    const s = await get('/api/community/admin/stats');
    const tile = (v, l, c = '') => h('div', { class: `card kpi ${c}` }, h('div', { class: 'v' }, fmtNum(v)), h('div', { class: 'l' }, l));
    mount(out, h('div', { class: 'grid g4' }, tile(s.published, 'منشورة', 'ok'), tile(s.pending, 'بانتظار المراجعة', 'open'), tile(s.open_reports, 'بلاغات مفتوحة', 'bad'), tile(s.total_reactions, 'إجمالي التفاعلات')),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h3', {}, 'الأكثر تفاعلاً'), s.top_reacted.length ? h('ol', { style: 'padding-inline-start:1.2rem;margin:0' }, s.top_reacted.map((p) => h('li', {}, `${p.title} — ${p.author}`, h('b', { class: 'num', style: 'margin-inline-start:.4rem' }, `${fmtNum(p.reactions)}`)))) : h('p', { class: 'muted' }, 'لا تفاعلات بعد')),
        h('div', { class: 'card' }, h('h3', {}, 'الأكثر مساهمة'), s.top_authors.length ? h('ol', { style: 'padding-inline-start:1.2rem;margin:0' }, s.top_authors.map((a) => h('li', {}, `${a.name}`, h('b', { class: 'num', style: 'margin-inline-start:.4rem' }, `${fmtNum(a.published)} منشور`)))) : h('p', { class: 'muted' }, 'لا مساهمات بعد'))));
  }
  async function showAudit() {
    const d = await get('/api/community/admin/audit' + qs({ page }));
    mount(out, d.entries.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't stackable' },
      h('thead', {}, h('tr', {}, ['التاريخ', 'من', 'الإجراء', 'التفاصيل'].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.entries.map((e) => h('tr', {}, h('td', { 'data-l': 'التاريخ', class: 'nowrap' }, fmtDateTime(e.created_at)), h('td', { 'data-l': 'من' }, e.actor || 'تلقائي'),
        h('td', { 'data-l': 'الإجراء' }, AUDIT[e.action] || e.action),
        h('td', { 'data-l': 'التفاصيل', class: 'small' }, [e.details.title, e.details.name, e.details.note && `الملاحظة: ${e.details.note}`, e.details.reason && `السبب: ${e.details.reason}`, e.details.auto && 'تلقائي'].filter(Boolean).join(' · ') || '—')))))) : emptyState('لا سجلات', 'list'), pager(d));
  }
  async function showSettings() {
    const [{ settings: s, emoji_catalog: catalog, categories }, { users }, { bans }] = await Promise.all([get('/api/community/admin/settings'), get('/api/admin/users?active=1'), get('/api/community/admin/bans')]);
    const enabled = h('input', { type: 'checkbox', checked: s.enabled }); const supRev = h('input', { type: 'checkbox', checked: s.supervisors_review });
    const limit = h('input', { class: 'input', type: 'number', min: 1, max: 50, value: s.daily_limit, style: 'max-width:120px' });
    const auto = h('input', { type: 'checkbox', checked: s.auto_publish.enabled }); const trusted = new Set(s.auto_publish.user_ids);
    const emojis = new Set(s.emojis);
    const emojiBox = h('div', { class: 'chips' }); const emojiCount = h('span', { class: 'muted small' });
    const paintEmojis = () => { emojiCount.textContent = `${fmtNum(emojis.size)} مختار (من 6 إلى 8)`; mount(emojiBox, catalog.map((e) => h('label', { class: 'chip-check' }, h('input', { type: 'checkbox', checked: emojis.has(e), onchange: (ev) => { if (ev.target.checked) { if (emojis.size >= 8) { ev.target.checked = false; toast('الحد الأقصى 8', 'err'); return; } emojis.add(e); } else emojis.delete(e); paintEmojis(); } }), h('span', {}, e)))); };
    paintEmojis();
    const search = h('input', { class: 'input', type: 'search', placeholder: 'بحث عن مستخدم موثوق…' }); const picker = h('div', { class: 'picker' });
    const paintUsers = () => mount(picker, users.filter((u) => u.role !== 'admin' && (!search.value || u.name.includes(search.value))).map((u) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: trusted.has(u.id), onchange: (e) => { e.target.checked ? trusted.add(u.id) : trusted.delete(u.id); } }), u.name)));
    search.addEventListener('input', paintUsers); paintUsers();
    const digest = h('input', { type: 'checkbox', checked: s.digest.enabled }); const dtime = h('input', { class: 'input', type: 'time', value: s.digest.time, style: 'max-width:140px' });
    const rules = h('textarea', { class: 'input', rows: 6, maxlength: 2000 }, s.rules_text);
    const err = h('div', { class: 'err', hidden: true });
    const save = h('button', { class: 'btn primary', onclick: () => busy(save, async () => {
      try {
        await put('/api/community/admin/settings', { enabled: enabled.checked, supervisors_review: supRev.checked, daily_limit: Number(limit.value), emojis: [...emojis], auto_publish: { enabled: auto.checked, user_ids: [...trusted] }, digest: { enabled: digest.checked, time: dtime.value }, rules_text: rules.value });
        err.hidden = true; toast('تم حفظ الإعدادات', 'ok'); onChange?.();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }) }, 'حفظ الإعدادات');

    const newCat = h('input', { class: 'input', placeholder: 'اسم تصنيف جديد', maxlength: 40 });
    const catList = h('div', { class: 'stack' }, categories.map((c) => {
      const name = h('input', { class: 'input', value: c.name, maxlength: 40 });
      return h('div', { class: 'row' }, name,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.active, onchange: async (e) => { try { await patch(`/api/community/admin/categories/${c.id}`, { active: e.target.checked }); toast('تم', 'ok'); } catch (x) { e.target.checked = !e.target.checked; fail(x); } } }), 'فعّال'),
        h('button', { class: 'btn sm', onclick: async () => { try { await patch(`/api/community/admin/categories/${c.id}`, { name: name.value }); toast('تم الحفظ', 'ok'); } catch (x) { fail(x); } } }, 'حفظ الاسم'),
        h('span', { class: 'muted small' }, `${fmtNum(c.posts)} موضوع`),
        h('button', { class: 'btn sm danger', onclick: async () => { try { await del(`/api/community/admin/categories/${c.id}`); showSettings(); } catch (x) { fail(x); } } }, 'حذف'));
    }));
    mount(out,
      h('section', { class: 'card stack' }, h('h3', {}, 'عام'),
        h('label', { class: 'check' }, enabled, 'تشغيل المجتمع (عند الإيقاف يختفي عن المستخدمين)'),
        field('الحد الأقصى للمواضيع المرسلة يومياً لكل مستخدم', limit),
        h('label', { class: 'check' }, supRev, 'السماح للمشرفين بمراجعة مواضيع مجموعاتهم فقط (نشر/رفض/إعادة)')),
      h('section', { class: 'card stack' }, h('h3', {}, 'الإيموجي المتاحة'), emojiBox, emojiCount),
      h('section', { class: 'card stack' }, h('h3', {}, 'النشر التلقائي للموثوقين'), h('p', { class: 'muted small' }, 'مواضيعهم تُنشر فوراً دون مراجعة (يُسجَّل ذلك في السجل). معطّل افتراضياً.'),
        h('label', { class: 'check' }, auto, 'تفعيل النشر التلقائي'), search, picker),
      h('section', { class: 'card stack' }, h('h3', {}, 'ملخص واتساب اليومي للمراجعين'), h('p', { class: 'muted small' }, 'رسالة واحدة يومياً بعدد المواضيع المعلّقة بدل رسالة لكل موضوع، وتحترم خيار واتساب وساعات الهدوء لكل مستخدم.'),
        h('label', { class: 'check' }, digest, 'تفعيل الملخص'), field('وقت الإرسال', dtime)),
      h('section', { class: 'card stack' }, h('h3', {}, 'قواعد المجتمع'), h('p', { class: 'muted small' }, 'تظهر للمستخدم عند أول كتابة ويقبلها مرة واحدة.'), rules),
      err, h('div', {}, save),
      h('section', { class: 'card stack' }, h('h3', {}, 'التصنيفات'), catList, h('div', { class: 'row' }, newCat,
        h('button', { class: 'btn primary', onclick: async () => { try { await post('/api/community/admin/categories', { name: newCat.value }); showSettings(); } catch (x) { fail(x); } } }, icon('plus'), 'إضافة'))),
      h('section', { class: 'card stack' }, h('h3', {}, 'المستخدمون المقيَّدون'), bans.length ? bans.map((b) => h('div', { class: 'row between' },
        h('div', {}, h('strong', {}, b.name), h('div', { class: 'muted small' }, [b.post_banned && 'ممنوع من الكتابة', b.react_banned && 'ممنوع من التفاعل', b.reason].filter(Boolean).join(' · '))),
        h('button', { class: 'btn sm', onclick: async () => { await del(`/api/community/admin/bans/${b.user_id}`); showSettings(); } }, 'رفع التقييد'))) : h('p', { class: 'muted' }, 'لا يوجد مستخدمون مقيَّدون')));
  }

  async function load() {
    try {
      const c = await get('/api/community/admin/counts'); counts = c.counts; paintTabs();
      q.hidden = !isPostTab();
      if (isPostTab()) await showPosts();
      else if (tab === 'reports') await showReports();
      else if (tab === 'stats') await showStats();
      else if (tab === 'audit') await showAudit();
      else await showSettings();
    } catch (e) { fail(e); }
  }
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { page = 1; load(); }, 250); });
  paintTabs();
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'إدارة المجتمع'), h('div', { class: 'actions' }, q)), tabs, out);
  await load();
  void badge;
  const t = setInterval(() => { if (isPostTab() || tab === 'reports') load(); }, 45_000);
  return () => clearInterval(t);
}
