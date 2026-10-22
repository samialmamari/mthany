import { h, mount, icon, get, post, fail, emptyState, fmtDateTime } from './core.js';

const ICON = { post_pending: 'inbox', post_published: 'check', post_rejected: 'x', post_needs_edit: 'edit', post_report: 'alert', delete_request: 'alert', review_digest: 'bell', community_ban: 'alert' };

export async function renderNotifications(root, onChange) {
  const out = h('div', { class: 'stack' });
  async function load() {
    try {
      const d = await get('/api/notifications');
      mount(out, d.notifications.length ? d.notifications.map((n) => h('a', {
        class: 'card notif' + (n.read_at ? '' : ' unread'), href: n.link || '#/notifications',
        onclick: () => { if (!n.read_at) post('/api/notifications/read', { ids: [n.id] }).then(onChange).catch(() => {}); },
      }, h('div', { class: 'notif-ic' }, icon(ICON[n.type] || 'bell')), h('div', { class: 'grow' }, h('div', { style: 'font-weight:700' }, n.title), n.body ? h('div', { class: 'muted small' }, n.body) : null, h('div', { class: 'muted small' }, fmtDateTime(n.created_at))),
      n.read_at ? null : h('span', { class: 'dot', 'aria-label': 'غير مقروء' }))) : emptyState('لا توجد إشعارات', 'bell'));
    } catch (e) { fail(e); }
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'الإشعارات'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { await post('/api/notifications/read', { all: true }); await load(); onChange(); } }, 'تعليم الكل كمقروء'))), out);
  await load();
  onChange();
}
