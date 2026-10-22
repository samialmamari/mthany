import { Router } from 'express';
import { db, now, placeholders } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { pendingCountFor } from '../services/community.js';

const r = Router();
r.use(requireAuth);

r.get('/summary', (req, res) => {
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).c;
  const pending_regs = req.user.role === 'admin'
    ? db.prepare("SELECT (SELECT COUNT(*) FROM course_registrations WHERE status='pending') + (SELECT COUNT(*) FROM gifts WHERE status IN ('pending','transfer_requested')) AS c").get().c : 0;
  res.json({ unread, pending_review: pendingCountFor(req.user), pending_regs });
});

r.get('/', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  const rows = db.prepare('SELECT id,type,title,body,link,read_at,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ?').all(req.user.id, limit);
  res.json({ notifications: rows, unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).c });
});

r.post('/read', (req, res) => {
  const { ids, all } = req.body || {};
  if (all) db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), req.user.id);
  else if (Array.isArray(ids) && ids.length) {
    const clean = ids.map(Number).filter(Boolean).slice(0, 200);
    if (clean.length) db.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (${placeholders(clean)})`).run(now(), req.user.id, ...clean);
  }
  res.json({ ok: true });
});

export default r;
