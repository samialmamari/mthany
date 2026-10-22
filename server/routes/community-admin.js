import { Router } from 'express';
import { db, now } from '../db.js';
import { cleanBody, likeEscape } from '../util/sanitize.js';
import { bad, forbidden, HttpError, notFound } from '../middleware/auth.js';
import { notify } from '../services/notify.js';
import { audit } from '../services/audit.js';
import { removeStoredFile } from '../services/submissions.js';
import {
  banOf, EMOJI_CATALOG, getCS, inScope, move, POST_SELECT, postsOut, reviewerScope, setCS, TransitionError,
} from '../services/community.js';
import { cleanTitle } from '../util/sanitize.js';
import { isTime } from '../util/time.js';

const r = Router();

// كل ما هنا للمراجعين فقط: المدير، أو المشرف المفوَّض (ضمن مجموعاته)
r.use((req, _res, next) => {
  req.scope = reviewerScope(req.user);
  if (!req.scope) return next(forbidden('هذه الصفحة للمراجعين فقط'));
  next();
});

const STATUSES = ['pending', 'published', 'needs_edit', 'rejected', 'archived'];
const loadPost = (id) => db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(Number(id));

function scopeSql(scope, alias = 'p') {
  if (scope.all) return { sql: '', args: [] };
  if (!scope.userIds.length) return { sql: ' AND 1=0', args: [] };
  return { sql: ` AND ${alias}.author_id IN (${scope.userIds.map(() => '?').join(',')})`, args: scope.userIds };
}

// ---------------------------------------------------------------- القوائم
r.get('/posts', (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : 'pending';
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const page = Math.max(1, Number(req.query.page) || 1);
  const sc = scopeSql(req.scope);
  let where = `p.status = ?${sc.sql}`; const a = [status, ...sc.args];
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) { where += " AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')"; a.push(...Array(3).fill(`%${likeEscape(q)}%`)); }
  const total = db.prepare(`SELECT COUNT(*) c FROM community_posts p JOIN users u ON u.id=p.author_id WHERE ${where}`).get(...a).c;
  const order = status === 'pending' ? 'p.submitted_at ASC' : status === 'published' ? '(p.pinned_at IS NULL), p.pinned_at DESC, p.published_at DESC' : 'p.updated_at DESC';
  const rows = db.prepare(`${POST_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
  res.json({ posts: postsOut(rows, req.user, { admin: true }), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

r.get('/counts', (req, res) => {
  const sc = scopeSql(req.scope);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const x of db.prepare(`SELECT status, COUNT(*) c FROM community_posts p WHERE 1=1${sc.sql} GROUP BY status`).all(...sc.args)) if (x.status in counts) counts[x.status] = x.c;
  if (req.user.role === 'admin') counts.reports = db.prepare("SELECT COUNT(DISTINCT post_id) c FROM post_reports WHERE status='open'").get().c;
  res.json({ counts });
});

// ---------------------------------------------------------------- القرارات
const REVIEW_ACTIONS = ['publish', 'reject', 'return'];

export function decide(p, action, actor, noteRaw) {
  const note = cleanBody(noteRaw || '', 500);
  if (action === 'return' && !note) throw bad('اكتب ملاحظات التعديل ليراها المستخدم');
  const out = move(p, action, actor, { note });
  const base = { link: action === 'publish' ? '#/community' : '#/community/mine' };
  if (action === 'publish') notify([p.author_id], { ...base, type: 'post_published', title: 'تم نشر موضوعك', body: p.title, wa: { key: 'post_published', params: [p.title] } });
  if (action === 'reject') notify([p.author_id], { ...base, type: 'post_rejected', title: 'تم رفض موضوعك', body: note ? `${p.title} — السبب: ${note}` : p.title, wa: { key: 'post_rejected', params: [p.title, note || '-'] } });
  if (action === 'return') notify([p.author_id], { ...base, type: 'post_needs_edit', title: 'موضوعك يحتاج تعديلاً', body: `${p.title} — ${note}`, wa: { key: 'post_needs_edit', params: [p.title, note] } });
  return out;
}

const guard = (req, p) => {
  if (!p) throw notFound('الموضوع غير موجود');
  if (!inScope(req.scope, p.author_id)) throw forbidden('هذا الموضوع خارج نطاق مراجعتك');
  if (p.author_id === req.user.id && req.user.role !== 'admin') throw forbidden('لا يمكنك مراجعة موضوعك بنفسك');
};
const failMove = (e) => { if (e instanceof TransitionError) throw new HttpError(409, e.message); throw e; };

r.post('/posts/bulk', (req, res) => {
  const { ids, action, note } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw bad('حدّد من 1 إلى 100 موضوع');
  if (!['publish', 'reject'].includes(action)) throw bad('الإجراء الجماعي: نشر أو رفض فقط');
  const out = { done: 0, failed: 0 };
  for (const id of ids) {
    try { const p = loadPost(id); guard(req, p); decide(p, action, req.user, note); out.done++; } catch { out.failed++; }
  }
  res.json(out);
});

r.post('/posts/:id/:action', (req, res) => {
  const { action } = req.params;
  const p = loadPost(req.params.id);
  guard(req, p);
  if (!REVIEW_ACTIONS.includes(action)) return handleAdminAction(req, res, p, action);
  try { decide(p, action, req.user, req.body?.note); } catch (e) { failMove(e); }
  res.json({ post: postsOut([loadPost(p.id)], req.user, { admin: true })[0] });
});

// من تفاعل مع الموضوع (للمراجعين فقط)
r.get('/posts/:id/reactions', (req, res) => {
  const p = loadPost(req.params.id);
  guard(req, p);
  const rows = db.prepare('SELECT r.emoji, u.id, u.name FROM post_reactions r JOIN users u ON u.id=r.user_id WHERE r.post_id=? ORDER BY r.created_at').all(p.id);
  const by = {};
  for (const x of rows) (by[x.emoji] ||= []).push({ id: x.id, name: x.name });
  res.json({ reactions: by });
});

// ---------------------------------------------------------------- إجراءات المدير فقط
const adminOnly = (req, _res, next) => (req.user.role === 'admin' ? next() : next(forbidden('هذا الإجراء للمدير فقط')));

function handleAdminAction(req, res, p, action) {
  if (req.user.role !== 'admin') throw forbidden('هذا الإجراء للمدير فقط');
  const t = now();
  switch (action) {
    case 'archive': case 'restore':
      try { move(p, action, req.user, {}); } catch (e) { failMove(e); }
      break;
    case 'delete':
      db.prepare('DELETE FROM community_posts WHERE id=?').run(p.id);
      if (p.image_name) removeStoredFile(p.image_name);
      audit(req.user.id, 'community.delete', 'post', p.id, { title: p.title, author_id: p.author_id, note: cleanBody(req.body?.note || '', 300), by_request: !!p.delete_requested_at });
      if (p.delete_requested_at) notify([p.author_id], { type: 'post_deleted', title: 'تم حذف موضوعك بناءً على طلبك', body: p.title, link: '#/community/mine' });
      return res.json({ ok: true, deleted: true });
    case 'pin':
      if (p.status !== 'published') throw new HttpError(409, 'التثبيت للمواضيع المنشورة فقط');
      db.prepare('UPDATE community_posts SET pinned_at=? WHERE id=?').run(t, p.id);
      audit(req.user.id, 'community.pin', 'post', p.id, { title: p.title });
      break;
    case 'unpin':
      db.prepare('UPDATE community_posts SET pinned_at=NULL WHERE id=?').run(p.id);
      audit(req.user.id, 'community.unpin', 'post', p.id, { title: p.title });
      break;
    case 'dismiss_delete':
      db.prepare('UPDATE community_posts SET delete_requested_at=NULL WHERE id=?').run(p.id);
      audit(req.user.id, 'community.dismiss_delete_request', 'post', p.id, { title: p.title });
      break;
    default: throw notFound('إجراء غير معروف');
  }
  res.json({ post: postsOut([loadPost(p.id)], req.user, { admin: true })[0] });
}

// ---------------------------------------------------------------- البلاغات
r.get('/reports', adminOnly, (_req, res) => {
  const posts = db.prepare(`${POST_SELECT} WHERE p.id IN (SELECT post_id FROM post_reports WHERE status='open') ORDER BY p.updated_at DESC LIMIT 100`).all();
  const rep = db.prepare("SELECT r.id, r.post_id, r.reason, r.created_at, u.name AS reporter FROM post_reports r JOIN users u ON u.id=r.reporter_id WHERE r.status='open' ORDER BY r.created_at").all();
  const out = postsOut(posts, { id: 0 }, { admin: true }).map((p) => ({ ...p, reports: rep.filter((x) => x.post_id === p.id) }));
  res.json({ posts: out });
});

r.post('/posts/:id/reports/resolve', adminOnly, (req, res) => {
  const p = loadPost(req.params.id);
  if (!p) throw notFound();
  const status = req.body?.action === 'actioned' ? 'actioned' : 'dismissed';
  const n = db.prepare("UPDATE post_reports SET status=?, resolved_by=?, resolved_at=? WHERE post_id=? AND status='open'").run(status, req.user.id, now(), p.id).changes;
  audit(req.user.id, `community.reports_${status}`, 'post', p.id, { title: p.title, count: n });
  res.json({ ok: true, resolved: n });
});

// ---------------------------------------------------------------- إحصاءات وسجل
r.get('/stats', adminOnly, (_req, res) => {
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM community_posts GROUP BY status').all().map((x) => [x.status, x.c]));
  const topReacted = db.prepare(
    `SELECT p.id, p.title, u.name AS author, COUNT(r.user_id) AS reactions FROM community_posts p JOIN users u ON u.id=p.author_id
     JOIN post_reactions r ON r.post_id=p.id WHERE p.status='published' GROUP BY p.id ORDER BY reactions DESC, p.published_at DESC LIMIT 5`,
  ).all();
  const topAuthors = db.prepare(
    `SELECT u.id, u.name, COUNT(*) AS published FROM community_posts p JOIN users u ON u.id=p.author_id WHERE p.status='published' GROUP BY u.id ORDER BY published DESC, u.name LIMIT 5`,
  ).all();
  res.json({
    published: byStatus.published || 0, pending: byStatus.pending || 0, needs_edit: byStatus.needs_edit || 0, rejected: byStatus.rejected || 0, archived: byStatus.archived || 0,
    open_reports: db.prepare("SELECT COUNT(DISTINCT post_id) c FROM post_reports WHERE status='open'").get().c,
    total_reactions: db.prepare('SELECT COUNT(*) c FROM post_reactions').get().c, top_reacted: topReacted, top_authors: topAuthors,
  });
});

r.get('/audit', adminOnly, (req, res) => {
  const limit = 30; const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
  const rows = db.prepare('SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT ? OFFSET ?').all(limit, (page - 1) * limit);
  res.json({ total, page, pages: Math.max(1, Math.ceil(total / limit)), entries: rows.map((x) => ({ ...x, details: JSON.parse(x.details || '{}') })) });
});

// ---------------------------------------------------------------- الإعدادات والتصنيفات والحظر
r.get('/settings', adminOnly, (_req, res) => {
  const cs = getCS();
  const trusted = cs.auto_publish.user_ids.length
    ? db.prepare(`SELECT id, name FROM users WHERE id IN (${cs.auto_publish.user_ids.map(() => '?').join(',')})`).all(...cs.auto_publish.user_ids) : [];
  res.json({ settings: { ...cs, auto_publish: { ...cs.auto_publish, users: trusted } }, emoji_catalog: EMOJI_CATALOG,
    categories: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM community_posts p WHERE p.category_id=c.id) AS posts FROM community_categories c ORDER BY sort, id').all() });
});

r.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  const changed = {};
  if (b.enabled !== undefined) changed.enabled = !!b.enabled;
  if (b.supervisors_review !== undefined) changed.supervisors_review = !!b.supervisors_review;
  if (b.daily_limit !== undefined) {
    const n = Number(b.daily_limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw bad('الحد اليومي بين 1 و50');
    changed.daily_limit = n;
  }
  if (b.emojis !== undefined) {
    const e = [...new Set(b.emojis)];
    if (e.length < 6 || e.length > 8 || e.some((x) => !EMOJI_CATALOG.includes(x))) throw bad('اختر من 6 إلى 8 إيموجي من القائمة المتاحة');
    changed.emojis = e;
  }
  if (b.auto_publish !== undefined) {
    const ids = [...new Set((b.auto_publish.user_ids || []).map(Number))].filter(Boolean);
    for (const id of ids) if (!db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(id)) throw bad('مستخدم غير موجود ضمن الموثوقين');
    changed.auto_publish = { enabled: !!b.auto_publish.enabled, user_ids: ids };
  }
  if (b.digest !== undefined) {
    if (b.digest.time && !isTime(b.digest.time)) throw bad('وقت الملخص غير صحيح');
    changed.digest = { enabled: !!b.digest.enabled, time: b.digest.time || '09:00' };
  }
  if (b.rules_text !== undefined) {
    const t = cleanBody(b.rules_text, 2000);
    if (t.length < 10) throw bad('نص القواعد قصير جداً');
    changed.rules_text = t;
  }
  for (const [k, v] of Object.entries(changed)) setCS(k, v);
  audit(req.user.id, 'community.settings', 'settings', null, { keys: Object.keys(changed), ...(changed.rules_text ? { rules_text: undefined } : {}) });
  res.json({ ok: true });
});

r.post('/categories', adminOnly, (req, res) => {
  const name = cleanTitle(req.body?.name, 40);
  if (name.length < 2) throw bad('اسم التصنيف قصير');
  if (db.prepare('SELECT 1 FROM community_categories WHERE name=?').get(name)) throw bad('التصنيف موجود');
  const sort = (db.prepare('SELECT MAX(sort) m FROM community_categories').get().m ?? -1) + 1;
  const id = db.prepare('INSERT INTO community_categories(name,sort) VALUES(?,?)').run(name, sort).lastInsertRowid;
  audit(req.user.id, 'community.category_add', 'category', Number(id), { name });
  res.status(201).json({ id });
});

r.patch('/categories/:id', adminOnly, (req, res) => {
  const c = db.prepare('SELECT * FROM community_categories WHERE id=?').get(Number(req.params.id));
  if (!c) throw notFound();
  const name = req.body?.name !== undefined ? cleanTitle(req.body.name, 40) : c.name;
  if (name.length < 2) throw bad('اسم التصنيف قصير');
  if (db.prepare('SELECT 1 FROM community_categories WHERE name=? AND id<>?').get(name, c.id)) throw bad('التصنيف موجود');
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : c.active;
  if (!active && db.prepare('SELECT COUNT(*) n FROM community_categories WHERE active=1 AND id<>?').get(c.id).n < 1) throw bad('يجب إبقاء تصنيف واحد فعّال على الأقل');
  db.prepare('UPDATE community_categories SET name=?, active=? WHERE id=?').run(name, active, c.id);
  audit(req.user.id, 'community.category_edit', 'category', c.id, { name, active: !!active });
  res.json({ ok: true });
});

r.delete('/categories/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM community_posts WHERE category_id=?').get(id)) throw new HttpError(409, 'التصنيف مستخدم في مواضيع؛ عطّله بدلاً من حذفه');
  db.prepare('DELETE FROM community_categories WHERE id=?').run(id);
  audit(req.user.id, 'community.category_delete', 'category', id, {});
  res.json({ ok: true });
});

r.get('/bans', adminOnly, (_req, res) => {
  res.json({ bans: db.prepare('SELECT b.*, u.name FROM community_bans b JOIN users u ON u.id=b.user_id WHERE b.post_banned=1 OR b.react_banned=1 ORDER BY b.created_at DESC').all() });
});

r.put('/bans/:userId', adminOnly, (req, res) => {
  const uid = Number(req.params.userId);
  const u = db.prepare('SELECT id, name, role FROM users WHERE id=?').get(uid);
  if (!u) throw notFound('المستخدم غير موجود');
  if (u.role === 'admin') throw bad('لا يمكن حظر مدير');
  const post_banned = req.body?.post_banned ? 1 : 0; const react_banned = req.body?.react_banned ? 1 : 0;
  const reason = cleanBody(req.body?.reason || '', 300);
  db.prepare(`INSERT INTO community_bans(user_id,post_banned,react_banned,reason,created_by,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET post_banned=excluded.post_banned, react_banned=excluded.react_banned, reason=excluded.reason, created_by=excluded.created_by, created_at=excluded.created_at`)
    .run(uid, post_banned, react_banned, reason, req.user.id, now());
  audit(req.user.id, 'community.ban', 'user', uid, { name: u.name, post_banned: !!post_banned, react_banned: !!react_banned, reason });
  if (post_banned || react_banned) notify([uid], { type: 'community_ban', title: 'تم تقييد مشاركتك في المجتمع', body: [post_banned && 'الكتابة', react_banned && 'التفاعل'].filter(Boolean).join(' و') + (reason ? ` — ${reason}` : ''), link: '#/community' });
  res.json({ ok: true, ban: banOf(uid) });
});

r.delete('/bans/:userId', adminOnly, (req, res) => {
  db.prepare('DELETE FROM community_bans WHERE user_id=?').run(Number(req.params.userId));
  audit(req.user.id, 'community.unban', 'user', Number(req.params.userId), {});
  res.json({ ok: true });
});

export default r;
