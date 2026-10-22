/**
 * منطق المجتمع: الإعدادات، المراجعون، آلة الحالات (في الخادم فقط)، وتجهيز المواضيع للعرض.
 */
import { db, now, placeholders } from '../db.js';
import { localDate, localToMs } from '../util/time.js';
import { audit } from './audit.js';

export const EMOJI_CATALOG = ['👍', '❤️', '😂', '😮', '🤲', '👏', '🌹', '🎉', '💡', '🙏', '😢', '🔥', '✨', '💯', '🤝', '😍'];

export const CS_DEFAULTS = {
  enabled: true,
  daily_limit: 3,
  supervisors_review: false,
  auto_publish: { enabled: false, user_ids: [] },
  emojis: ['🤲', '❤️', '👍', '🌹', '🙏', '👏', '✨'],
  digest: { enabled: true, time: '09:00' },
  rules_text: [
    '١. هذا مجتمع للتذكير بالله والتعاون على الخير: اكتب بصدق وأدب وأدعُ لإخوانك بظهر الغيب.',
    '٢. لا تنشر معلومات خاصة أو أرقام هواتف أو بيانات الآخرين، ولا تذكر أسماءهم دون إذنهم.',
    '٣. طلبات الدعاء مرحَّب بها؛ لا تكتب تفاصيل تضرّك أو تضرّ غيرك.',
    '٤. لا خلافات ولا جدالاً ولا محتوى بعيداً عن الذكر والدعاء والتشجيع والدعم.',
    '٥. يخضع كل موضوع لمراجعة الإدارة قبل نشره، وقد يُرفض أو يُعاد إليك للتعديل، وللإدارة أرشفة أي موضوع أو حذفه.',
  ].join('\n'),
};

export function getCS() {
  const out = structuredClone(CS_DEFAULTS);
  for (const r of db.prepare('SELECT key, value FROM community_settings').all()) {
    try { const v = JSON.parse(r.value); out[r.key] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...out[r.key], ...v } : v; } catch { /* */ }
  }
  return out;
}
export function setCS(key, value) {
  db.prepare('INSERT INTO community_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

// ------------------------------------------------------------------ المراجعون والصلاحيات
const supervisedUserIds = (supId) => db.prepare(
  'SELECT DISTINCT ug.user_id FROM user_groups ug JOIN groups g ON g.id=ug.group_id WHERE g.supervisor_id=?',
).all(supId).map((x) => x.user_id);

/** null = ليس مراجعاً | { all:true } للمدير | { userIds } للمشرف المفوَّض */
export function reviewerScope(user) {
  if (user.role === 'admin') return { all: true };
  if (user.role === 'supervisor' && getCS().supervisors_review) return { userIds: supervisedUserIds(user.id) };
  return null;
}
export const inScope = (scope, authorId) => !!scope && (scope.all || scope.userIds.includes(authorId));

export function reviewerIds(authorId) {
  const ids = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
  if (getCS().supervisors_review) {
    const sups = db.prepare("SELECT id FROM users WHERE role='supervisor' AND active=1").all();
    for (const s of sups) if (authorId == null ? supervisedUserIds(s.id).length : supervisedUserIds(s.id).includes(authorId)) ids.push(s.id);
  }
  return ids;
}

export function pendingCountFor(user) {
  const scope = reviewerScope(user);
  if (!scope) return 0;
  if (scope.all) return db.prepare("SELECT COUNT(*) c FROM community_posts WHERE status='pending'").get().c;
  if (!scope.userIds.length) return 0;
  return db.prepare(`SELECT COUNT(*) c FROM community_posts WHERE status='pending' AND author_id IN (${placeholders(scope.userIds)})`).get(...scope.userIds).c;
}

export const banOf = (uid) => db.prepare('SELECT * FROM community_bans WHERE user_id=?').get(uid) || { post_banned: 0, react_banned: 0 };

export function postsToday(uid) {
  const start = localToMs(localDate(), '00:00');
  return db.prepare("SELECT COUNT(*) c FROM community_posts WHERE author_id=? AND submitted_at >= ?").get(uid, start).c;
}

// ------------------------------------------------------------------ آلة الحالات
export const RULES = {
  submit: { from: ['draft', 'needs_edit'], to: 'pending' },
  withdraw: { from: ['pending'], to: 'draft' },
  edit_published: { from: ['published'], to: 'pending' },
  publish: { from: ['pending', 'rejected', 'needs_edit', 'archived'], to: 'published' },
  reject: { from: ['pending'], to: 'rejected' },
  return: { from: ['pending', 'published'], to: 'needs_edit' },
  archive: { from: ['published'], to: 'archived' },
  restore: { from: ['archived'], to: 'published' },
};

export class TransitionError extends Error {}

/** ينقل الموضوع بين الحالات مع التحقق والتدقيق والإشعارات؛ يرمي TransitionError عند انتقال غير صحيح */
export function move(post, action, actor, { note = '', auto = false } = {}) {
  const rule = RULES[action];
  if (!rule) throw new TransitionError('إجراء غير معروف');
  if (!rule.from.includes(post.status)) throw new TransitionError('لا يمكن تنفيذ هذا الإجراء على الموضوع في حالته الحالية');
  const t = now();
  const to = rule.to;
  const sets = { status: to, updated_at: t };
  if (['submit', 'edit_published'].includes(action)) { sets.submitted_at = t; sets.decision_note = ''; sets.reviewed_by = null; sets.reviewed_at = null; sets.pinned_at = null; sets.delete_requested_at = null; }
  if (action === 'publish') { sets.published_at = t; sets.decision_note = ''; sets.reviewed_by = auto ? null : actor.id; sets.reviewed_at = t; sets.auto_published = auto ? 1 : 0; }
  if (action === 'reject') { sets.decision_note = note; sets.reviewed_by = actor.id; sets.reviewed_at = t; }
  if (action === 'return') { sets.decision_note = note; sets.reviewed_by = actor.id; sets.reviewed_at = t; sets.pinned_at = null; }
  if (['archive', 'return'].includes(action) || to !== 'published') sets.pinned_at = null;
  const cols = Object.keys(sets);
  db.prepare(`UPDATE community_posts SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), post.id);
  if (['publish', 'reject', 'return', 'archive', 'restore'].includes(action)) {
    audit(auto ? null : actor.id, `community.${action}`, 'post', post.id, { title: post.title, author_id: post.author_id, note, auto });
  } else {
    audit(actor.id, `community.${action}`, 'post', post.id, { title: post.title });
  }
  return db.prepare('SELECT * FROM community_posts WHERE id=?').get(post.id);
}

// ------------------------------------------------------------------ تجهيز العرض
export function reactionData(postIds, userId) {
  const counts = {}; const mine = {};
  if (!postIds.length) return { counts, mine };
  for (const r of db.prepare(`SELECT post_id, emoji, COUNT(*) c FROM post_reactions WHERE post_id IN (${placeholders(postIds)}) GROUP BY post_id, emoji`).all(...postIds)) {
    (counts[r.post_id] ||= {})[r.emoji] = r.c;
  }
  for (const r of db.prepare(`SELECT post_id, emoji FROM post_reactions WHERE user_id=? AND post_id IN (${placeholders(postIds)})`).all(userId, ...postIds)) mine[r.post_id] = r.emoji;
  return { counts, mine };
}

/** يحوّل صفوف المواضيع (مع author_name وcategory_name) إلى شكل آمن للعرض — دون أرقام هواتف */
export function postsOut(rows, viewer, { admin = false } = {}) {
  const ids = rows.map((p) => p.id);
  const { counts, mine } = reactionData(ids, viewer.id);
  const reports = new Map();
  if (admin && ids.length) {
    for (const r of db.prepare(`SELECT post_id, COUNT(*) c FROM post_reports WHERE status='open' AND post_id IN (${placeholders(ids)}) GROUP BY post_id`).all(...ids)) reports.set(r.post_id, r.c);
  }
  return rows.map((p) => {
    const rc = counts[p.id] || {};
    const o = {
      id: p.id, title: p.title, body: p.body, status: p.status,
      category: p.category_id ? { id: p.category_id, name: p.category_name } : null,
      author: { id: p.author_id, name: p.author_name }, is_mine: p.author_id === viewer.id,
      created_at: p.created_at, submitted_at: p.submitted_at, published_at: p.published_at, updated_at: p.updated_at,
      pinned: !!p.pinned_at, has_image: !!p.image_name, reactions: rc, total_reactions: Object.values(rc).reduce((a, b) => a + b, 0), my_reaction: mine[p.id] || null,
    };
    if (p.author_id === viewer.id || admin) { o.decision_note = p.decision_note; o.delete_requested = !!p.delete_requested_at; }
    if (admin) { o.open_reports = reports.get(p.id) || 0; o.auto_published = !!p.auto_published; }
    return o;
  });
}

export const POST_SELECT = `SELECT p.*, u.name AS author_name, c.name AS category_name
  FROM community_posts p JOIN users u ON u.id = p.author_id LEFT JOIN community_categories c ON c.id = p.category_id`;
