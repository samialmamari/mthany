import { Router } from 'express';
import { db, now } from '../db.js';
import { cleanBody, cleanTitle } from '../util/sanitize.js';
import { isDate, localDate } from '../util/time.js';
import { bad, notFound, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { messageOf } from '../services/progress.js';

/** رسالة اليوم: آية أو تدبر يظهر في لوحة العضو، وتتحكم به الإدارة */
const r = Router();
const adminOnly = requireRole('admin');

r.get('/messages', requireRole('admin', 'supervisor'), (_req, res) => {
  const today = localDate();
  res.json({
    today, current: messageOf(today),
    messages: db.prepare('SELECT * FROM daily_messages ORDER BY (show_date IS NULL), show_date DESC, sort, id').all()
      .map((m) => ({ ...m, active: !!m.active, is_today: m.show_date === today })),
  });
});

function fields(b, ex) {
  const text = b.text !== undefined ? cleanBody(b.text, 600) : ex.text;
  if (text.length < 5) throw bad('اكتب نص الرسالة');
  const source = b.source !== undefined ? cleanTitle(b.source, 60) : ex.source;
  let show_date = ex.show_date;
  if (b.show_date !== undefined) {
    show_date = b.show_date || null;
    if (show_date && !isDate(show_date)) throw bad('تاريخ غير صالح');
  }
  if (show_date) {
    const clash = db.prepare('SELECT id FROM daily_messages WHERE show_date=? AND active=1 AND id<>?').get(show_date, ex.id ?? 0);
    if (clash) throw bad('يوجد رسالة فعّالة لهذا التاريخ؛ عدّلها أو اختر تاريخاً آخر');
  }
  return { text, source, show_date, active: b.active === undefined ? ex.active : (b.active ? 1 : 0) };
}

r.post('/messages', adminOnly, (req, res) => {
  const f = fields(req.body || {}, { text: '', source: '', show_date: null, active: 1 });
  const t = now();
  const sort = (db.prepare('SELECT MAX(sort) m FROM daily_messages').get().m ?? -1) + 1;
  const id = db.prepare('INSERT INTO daily_messages(text,source,show_date,active,sort,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(f.text, f.source, f.show_date, f.active, sort, req.user.id, t, t).lastInsertRowid;
  audit(req.user.id, 'message.add', 'message', Number(id), { show_date: f.show_date });
  res.status(201).json({ id });
});

r.patch('/messages/:id', adminOnly, (req, res) => {
  const ex = db.prepare('SELECT * FROM daily_messages WHERE id=?').get(Number(req.params.id));
  if (!ex) throw notFound();
  const f = fields(req.body || {}, ex);
  db.prepare('UPDATE daily_messages SET text=?,source=?,show_date=?,active=?,updated_at=? WHERE id=?').run(f.text, f.source, f.show_date, f.active, now(), ex.id);
  audit(req.user.id, 'message.edit', 'message', ex.id, { show_date: f.show_date, active: !!f.active });
  res.json({ ok: true });
});

r.delete('/messages/:id', adminOnly, (req, res) => {
  const m = db.prepare('SELECT * FROM daily_messages WHERE id=?').get(Number(req.params.id));
  if (!m) throw notFound();
  db.prepare('DELETE FROM daily_messages WHERE id=?').run(m.id);
  audit(req.user.id, 'message.delete', 'message', m.id, {});
  res.json({ ok: true });
});

export default r;
