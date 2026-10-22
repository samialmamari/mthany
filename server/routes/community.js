import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { randomToken } from '../util/crypto.js';
import { cleanBody, cleanTitle, likeEscape } from '../util/sanitize.js';
import { bad, forbidden, HttpError, notFound, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { removeStoredFile } from '../services/submissions.js';
import {
  banOf, getCS, inScope, move, POST_SELECT, postsOut, postsToday, reviewerIds, reviewerScope, TransitionError,
} from '../services/community.js';
import adminRoutes from './community-admin.js';

const r = Router();
r.use(requireAuth);

const perUser = (windowMs, limit, message) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user?.id}`, validate: false,
  message: { error: message },
});
const writeLimit = perUser(3_600_000, 30, 'عدد كبير من الطلبات، حاول لاحقاً');
const reactLimit = perUser(60_000, 120, 'تفاعلات كثيرة خلال وقت قصير');
const reportLimit = perUser(3_600_000, 10, 'بلاغات كثيرة، حاول لاحقاً');

// ---------------------------------------------------------------- الصور (تحقق من النوع والتوقيع)
const IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const extOf = (n) => path.extname(n).slice(1).toLowerCase();
const upload = multer({
  storage: multer.diskStorage({ destination: config.uploadDir, filename: (_q, f, cb) => cb(null, `c-${randomToken(18)}.${extOf(f.originalname)}`) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_q, f, cb) => (IMG[extOf(f.originalname)] ? cb(null, true) : cb(new HttpError(400, 'الصورة يجب أن تكون jpg أو png أو gif أو webp'))),
});
function validSignature(file) {
  const fd = fs.openSync(file.path, 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  const e = extOf(file.originalname);
  if (e === 'jpg' || e === 'jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (e === 'png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (e === 'gif') return b.subarray(0, 4).toString('latin1') === 'GIF8';
  if (e === 'webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

// ---------------------------------------------------------------- مساعدات
function enabledOnly(req, _res, next) {
  if (!getCS().enabled && req.user.role !== 'admin') return next(forbidden('المجتمع غير متاح حالياً'));
  next();
}
r.use(enabledOnly);

const loadPost = (id) => db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(Number(id));
const isTrue = (v) => v === '1' || v === 'true' || v === true;

function canView(user, p) {
  if (p.status === 'published' || p.author_id === user.id) return true;
  return inScope(reviewerScope(user), p.author_id);
}

function readFields(req) {
  const title = cleanTitle(req.body.title);
  const body = cleanBody(req.body.body);
  if (title.length < 3) throw bad('العنوان قصير جداً (3 أحرف على الأقل)');
  if (body.length < 10) throw bad('المحتوى قصير جداً (10 أحرف على الأقل)');
  const cat = Number(req.body.category_id) || null;
  if (cat && !db.prepare('SELECT 1 FROM community_categories WHERE id=? AND active=1').get(cat)) throw bad('تصنيف غير صالح');
  if (!cat) throw bad('اختر تصنيفاً للموضوع');
  return { title, body, category_id: cat };
}

function guardWrite(user) {
  if (banOf(user.id).post_banned) throw forbidden('تم إيقاف صلاحية الكتابة في المجتمع لحسابك');
  if (!user.community_terms_at) throw new HttpError(403, 'يلزم قبول قواعد المجتمع أولاً', { code: 'terms' });
}

const sameLocalDay = (ms) => {
  const off = config.tzOffsetMin * 60_000;
  return new Date(ms + off).toISOString().slice(0, 10) === new Date(Date.now() + off).toISOString().slice(0, 10);
};

/** يرسل الموضوع للمراجعة (أو ينشره تلقائياً لمستخدم موثوق) ويُشعر المراجعين */
function submitFlow(post, user, { edit = false } = {}) {
  const cs = getCS();
  if (!edit) {
    const counted = post.submitted_at && sameLocalDay(post.submitted_at) ? 1 : 0; // لا نحسب الموضوع نفسه مرتين
    if (postsToday(user.id) - counted >= cs.daily_limit) throw new HttpError(429, `بلغت الحد اليومي لإرسال المواضيع (${cs.daily_limit}). حاول غداً.`);
  }
  let p = move(post, edit ? 'edit_published' : 'submit', user);
  if (cs.auto_publish.enabled && cs.auto_publish.user_ids.includes(user.id)) {
    p = move(p, 'publish', user, { auto: true });
    notify([user.id], { type: 'post_published', title: 'تم نشر موضوعك', body: p.title, link: '#/community' });
  } else {
    notify(reviewerIds(user.id).filter((id) => id !== user.id), {
      type: 'post_pending', title: edit ? 'موضوع معدَّل بانتظار المراجعة' : 'موضوع جديد بانتظار المراجعة',
      body: `${user.name}: ${p.title}`, link: '#/community-admin?tab=pending',
    });
  }
  return p;
}

const failMove = (e) => { if (e instanceof TransitionError) throw new HttpError(409, e.message); throw e; };

// ---------------------------------------------------------------- الإعدادات العامة للواجهة
r.get('/config', (req, res) => {
  const cs = getCS();
  const ban = banOf(req.user.id);
  res.json({
    enabled: cs.enabled,
    categories: db.prepare('SELECT id, name FROM community_categories WHERE active=1 ORDER BY sort, id').all(),
    emojis: cs.emojis, rules_text: cs.rules_text, daily_limit: cs.daily_limit,
    terms_accepted: !!req.user.community_terms_at,
    can_post: !ban.post_banned, can_react: !ban.react_banned,
    posts_today: postsToday(req.user.id),
    is_reviewer: !!reviewerScope(req.user),
  });
});

r.post('/accept-terms', (req, res) => {
  db.prepare('UPDATE users SET community_terms_at=? WHERE id=?').run(now(), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- القراءة
r.get('/posts', (req, res) => {
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
  const page = Math.max(1, Number(req.query.page) || 1);
  let where = "p.status='published'"; const a = [];
  if (Number(req.query.category)) { where += ' AND p.category_id=?'; a.push(Number(req.query.category)); }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) { where += " AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')"; a.push(`%${likeEscape(q)}%`, `%${likeEscape(q)}%`); }
  const total = db.prepare(`SELECT COUNT(*) c FROM community_posts p WHERE ${where}`).get(...a).c;
  const rows = db.prepare(`${POST_SELECT} WHERE ${where} ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.published_at DESC LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
  res.json({ posts: postsOut(rows, req.user), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

r.get('/mine', (req, res) => {
  const rows = db.prepare(`${POST_SELECT} WHERE p.author_id=? ORDER BY p.updated_at DESC LIMIT 200`).all(req.user.id);
  res.json({ posts: postsOut(rows, req.user) });
});

r.get('/posts/:id', (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || !canView(req.user, p)) throw notFound('الموضوع غير موجود');
  res.json({ post: postsOut([p], req.user, { admin: !!reviewerScope(req.user) })[0] });
});

r.get('/posts/:id/image', (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || !p.image_name || !canView(req.user, p)) throw notFound();
  const abs = path.join(config.uploadDir, path.basename(p.image_name));
  if (!fs.existsSync(abs)) throw notFound();
  res.setHeader('Content-Type', p.image_mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(abs, { dotfiles: 'allow' });
});

// ---------------------------------------------------------------- الكتابة
function withImage(req, fn) {
  const file = req.file;
  try {
    if (file && !validSignature(file)) throw bad('الملف ليس صورة صالحة');
    return fn(file);
  } catch (e) { if (file) removeStoredFile(file.filename); throw e; }
}

r.post('/posts', writeLimit, upload.single('image'), (req, res) => {
  withImage(req, (file) => {
    guardWrite(req.user);
    const f = readFields(req);
    const t = now();
    const id = db.prepare(
      `INSERT INTO community_posts(author_id,category_id,title,body,image_name,image_mime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'draft',?,?)`,
    ).run(req.user.id, f.category_id, f.title, f.body, file?.filename ?? null, file ? IMG[extOf(file.originalname)] : null, t, t).lastInsertRowid;
    let p = loadPost(id);
    try { if (isTrue(req.body.submit)) p = loadPost(submitFlow(p, req.user).id); }
    catch (e) { if (e instanceof HttpError) { res.status(e.status).json({ error: e.message, ...(e.extra || {}), saved_as_draft: id }); return; } failMove(e); }
    res.status(201).json({ post: postsOut([p], req.user)[0] });
  });
});

r.put('/posts/:id', writeLimit, upload.single('image'), (req, res) => {
  withImage(req, (file) => {
    const p = loadPost(req.params.id);
    if (!p || p.author_id !== req.user.id) throw notFound('الموضوع غير موجود');
    guardWrite(req.user);
    if (!['draft', 'needs_edit', 'published'].includes(p.status)) throw new HttpError(409, p.status === 'pending' ? 'الموضوع قيد المراجعة؛ اسحبه أولاً إن أردت تعديله' : 'لا يمكن تعديل هذا الموضوع');
    const f = readFields(req);
    let image_name = p.image_name; let image_mime = p.image_mime; let oldImage = null;
    if (file || isTrue(req.body.remove_image)) { oldImage = p.image_name; image_name = file?.filename ?? null; image_mime = file ? IMG[extOf(file.originalname)] : null; }
    db.prepare('UPDATE community_posts SET title=?, body=?, category_id=?, image_name=?, image_mime=?, updated_at=? WHERE id=?')
      .run(f.title, f.body, f.category_id, image_name, image_mime, now(), p.id);
    if (oldImage) removeStoredFile(oldImage);
    let out = loadPost(p.id);
    try {
      if (p.status === 'published') out = loadPost(submitFlow(out, req.user, { edit: true }).id);
      else if (isTrue(req.body.submit)) out = loadPost(submitFlow(out, req.user).id);
    } catch (e) { if (e instanceof HttpError) { res.status(e.status).json({ error: e.message, ...(e.extra || {}) }); return; } failMove(e); }
    res.json({ post: postsOut([out], req.user)[0] });
  });
});

r.post('/posts/:id/submit', writeLimit, (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || p.author_id !== req.user.id) throw notFound('الموضوع غير موجود');
  guardWrite(req.user);
  try { res.json({ post: postsOut([loadPost(submitFlow(p, req.user).id)], req.user)[0] }); } catch (e) { failMove(e); }
});

r.post('/posts/:id/withdraw', (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || p.author_id !== req.user.id) throw notFound('الموضوع غير موجود');
  try { move(p, 'withdraw', req.user); } catch (e) { failMove(e); }
  res.json({ post: postsOut([loadPost(p.id)], req.user)[0] });
});

r.delete('/posts/:id', (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || p.author_id !== req.user.id) throw notFound('الموضوع غير موجود');
  if (!['draft', 'needs_edit', 'rejected'].includes(p.status)) throw new HttpError(409, p.status === 'published' ? 'الموضوع المنشور لا يُحذف مباشرة؛ اطلب الحذف من الإدارة' : 'لا يمكن حذف هذا الموضوع الآن');
  db.prepare('DELETE FROM community_posts WHERE id=?').run(p.id);
  if (p.image_name) removeStoredFile(p.image_name);
  audit(req.user.id, 'community.author_delete', 'post', p.id, { title: p.title });
  res.json({ ok: true });
});

r.post('/posts/:id/request-delete', (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || p.author_id !== req.user.id) throw notFound('الموضوع غير موجود');
  if (p.status !== 'published') throw new HttpError(409, 'طلب الحذف للمواضيع المنشورة فقط');
  if (p.delete_requested_at) throw new HttpError(409, 'سبق أن طلبت حذف هذا الموضوع');
  db.prepare('UPDATE community_posts SET delete_requested_at=? WHERE id=?').run(now(), p.id);
  audit(req.user.id, 'community.request_delete', 'post', p.id, { title: p.title });
  const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
  notify(admins, { type: 'delete_request', title: 'طلب حذف موضوع', body: `${req.user.name}: ${p.title}`, link: '#/community-admin?tab=published' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- التفاعل بالإيموجي
// تفاعل واحد لكل مستخدم على كل موضوع منشور: يُغيَّر بإرسال إيموجي آخر، ويُزال بإرسال null أو نفس الإيموجي
r.put('/posts/:id/reaction', reactLimit, (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || p.status !== 'published') throw notFound('الموضوع غير موجود');
  if (banOf(req.user.id).react_banned) throw forbidden('تم إيقاف التفاعل في المجتمع لحسابك');
  const emoji = req.body?.emoji ?? null;
  if (emoji !== null && !getCS().emojis.includes(emoji)) throw bad('إيموجي غير متاح');
  const cur = db.prepare('SELECT emoji FROM post_reactions WHERE post_id=? AND user_id=?').get(p.id, req.user.id);
  if (emoji === null || cur?.emoji === emoji) db.prepare('DELETE FROM post_reactions WHERE post_id=? AND user_id=?').run(p.id, req.user.id);
  else db.prepare('INSERT INTO post_reactions(post_id,user_id,emoji,created_at) VALUES(?,?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET emoji=excluded.emoji, created_at=excluded.created_at').run(p.id, req.user.id, emoji, now());
  const out = postsOut([loadPost(p.id)], req.user)[0];
  res.json({ reactions: out.reactions, my_reaction: out.my_reaction, total: out.total_reactions });
});

// ---------------------------------------------------------------- الإبلاغ
r.post('/posts/:id/report', reportLimit, (req, res) => {
  const p = loadPost(req.params.id);
  if (!p || p.status !== 'published') throw notFound('الموضوع غير موجود');
  if (p.author_id === req.user.id) throw bad('لا يمكنك الإبلاغ عن موضوعك');
  const reason = cleanBody(req.body?.reason || '', 300);
  try {
    db.prepare('INSERT INTO post_reports(post_id,reporter_id,reason,created_at) VALUES(?,?,?,?)').run(p.id, req.user.id, reason, now());
  } catch { throw new HttpError(409, 'سبق أن أبلغت عن هذا الموضوع'); }
  const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((x) => x.id);
  notify(admins, { type: 'post_report', title: 'بلاغ عن موضوع', body: `«${p.title}»${reason ? ` — ${reason}` : ''}`, link: '#/community-admin?tab=reports' });
  res.status(201).json({ ok: true });
});

r.use('/admin', adminRoutes);
export default r;
