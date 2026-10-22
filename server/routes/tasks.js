import { Router } from 'express';
import { db, now, tx } from '../db.js';
import { addDays, isDate, isTime, localDate } from '../util/time.js';
import { bad, notFound, requireRole } from '../middleware/auth.js';
import { hydrateTask, loadPauses } from '../services/schedule.js';
import { cleanBody, cleanTitle } from '../util/sanitize.js';

/** «المهام» في الكود هي الأوراد والأذكار: كل ورد يومي ويُسجَّل بعدد (مرة/صفحة/دقيقة…) مع هدف اختياري. */
const r = Router();
const staff = requireRole('admin', 'supervisor');
const adminOnly = requireRole('admin');

// ---------------------------------------------------------------- التحقق
export function parseBody(b) {
  const t = {};
  t.title = cleanTitle(b.title, 120);
  if (!t.title) throw bad('اسم الورد مطلوب');
  t.description = cleanBody(b.description ?? '', 1000);
  t.count_unit = cleanTitle(b.count_unit ?? 'مرة', 20) || 'مرة';
  t.sort = Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0;
  t.read_text = cleanBody(b.read_text ?? '', 20_000);
  t.link_url = String(b.link_url ?? '').trim().slice(0, 500);
  if (t.link_url) {
    try { const u = new URL(t.link_url); if (!['http:', 'https:'].includes(u.protocol)) throw 0; }
    catch { throw bad('الرابط غير صالح (يبدأ بـ http أو https)'); }
  }
  t.target_count = b.target_count === '' || b.target_count == null ? null : Number(b.target_count);
  if (t.target_count !== null && (!Number.isInteger(t.target_count) || t.target_count < 1 || t.target_count > 10_000_000)) throw bad('الهدف اليومي عدد صحيح موجب');

  t.start_time = b.start_time || '00:00';
  t.deadline_time = b.deadline_time || '23:59';
  if (!isTime(t.start_time) || !isTime(t.deadline_time)) throw bad('صيغة الوقت غير صالحة');
  if (t.deadline_time <= t.start_time) throw bad('نهاية وقت الورد يجب أن تكون بعد بدايته');
  t.grace_minutes = Number(b.grace_minutes || 0);
  if (!Number.isInteger(t.grace_minutes) || t.grace_minutes < 0 || t.grace_minutes > 1440) throw bad('مهلة التسجيل بين 0 و1440 دقيقة');
  t.remind_before_min = b.remind_before_min ? Number(b.remind_before_min) : null;
  if (t.remind_before_min !== null && (!Number.isInteger(t.remind_before_min) || t.remind_before_min < 5 || t.remind_before_min > 4320)) {
    throw bad('وقت التذكير بين 5 دقائق و3 أيام');
  }

  t.start_date = b.start_date || localDate();
  if (!isDate(t.start_date)) throw bad('تاريخ البدء غير صالح');
  t.end_date = b.end_date || null;
  if (t.end_date && (!isDate(t.end_date) || t.end_date < t.start_date)) throw bad('تاريخ الانتهاء غير صالح');

  t.days_of_week = null;
  if (b.days_of_week != null) {
    const d = [...new Set(b.days_of_week)];
    if (!d.length || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) throw bad('اختر يوماً واحداً على الأقل');
    t.days_of_week = d.length === 7 ? null : JSON.stringify(d.sort());
  }
  return t;
}

function parseAssign(b) {
  const a = b.assign || {};
  const group_ids = [...new Set((a.group_ids || []).map(Number))];
  const user_ids = [...new Set((a.user_ids || []).map(Number))];
  if (!a.all && !group_ids.length && !user_ids.length) throw bad('حدّد لمن يُسند الورد (الجميع أو حلقة أو أعضاء)');
  for (const g of group_ids) if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(g)) throw bad('حلقة غير موجودة');
  for (const u of user_ids) if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(u)) throw bad('عضو غير موجود');
  return { all: !!a.all, group_ids, user_ids };
}

function writeAssign(taskId, a) {
  const old = db.prepare('SELECT * FROM task_assignees WHERE task_id=?').all(taskId);
  const wanted = [];
  if (a.all) wanted.push(['all', null]);
  a.group_ids.forEach((g) => wanted.push(['group', g]));
  a.user_ids.forEach((u) => wanted.push(['user', u]));
  const key = (k, id) => `${k}:${id ?? ''}`;
  const wantedKeys = new Set(wanted.map(([k, id]) => key(k, id)));
  for (const o of old) if (!wantedKeys.has(key(o.kind, o.ref_id))) db.prepare('DELETE FROM task_assignees WHERE id=?').run(o.id);
  const have = new Set(old.map((o) => key(o.kind, o.ref_id)));
  for (const [k, id] of wanted) {
    if (!have.has(key(k, id))) db.prepare('INSERT INTO task_assignees(task_id,kind,ref_id,created_at) VALUES(?,?,?,?)').run(taskId, k, id, now());
  }
}

function taskOut(row) {
  const t = hydrateTask(row, loadPauses());
  const out = { ...t, pauses: undefined, submit_types: undefined };
  const as = db.prepare('SELECT kind, ref_id FROM task_assignees WHERE task_id=?').all(t.id);
  out.assign = {
    all: as.some((x) => x.kind === 'all'),
    group_ids: as.filter((x) => x.kind === 'group').map((x) => x.ref_id),
    user_ids: as.filter((x) => x.kind === 'user').map((x) => x.ref_id),
  };
  out.assign_label = out.assign.all ? 'الجميع' : [
    ...out.assign.group_ids.map((g) => db.prepare('SELECT name FROM groups WHERE id=?').get(g)?.name).filter(Boolean).map((n) => `حلقة ${n}`),
    ...(out.assign.user_ids.length ? [`${out.assign.user_ids.length} عضو`] : []),
  ].join('، ');
  return out;
}

// ---------------------------------------------------------------- CRUD
r.get('/tasks', staff, (req, res) => {
  const { status = 'all', q } = req.query;
  let sql = 'SELECT * FROM tasks WHERE owner_id IS NULL'; const a = [];
  if (status === 'all') sql += " AND status <> 'archived'"; else { sql += ' AND status = ?'; a.push(status); }
  if (q) { sql += ' AND (title LIKE ? OR description LIKE ?)'; a.push(`%${q}%`, `%${q}%`); }
  res.json({ tasks: db.prepare(sql + ' ORDER BY sort, id').all(...a).map(taskOut) });
});

r.get('/tasks/:id', staff, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND owner_id IS NULL').get(Number(req.params.id));
  if (!t) throw notFound();
  res.json({ task: taskOut(t) });
});

r.post('/tasks', adminOnly, (req, res) => {
  const t = parseBody(req.body || {});
  const assign = parseAssign(req.body || {});
  const id = tx(() => {
    const tid = db.prepare(
      `INSERT INTO tasks(title,description,kind,submit_types,days_of_week,start_time,deadline_time,grace_minutes,start_date,end_date,
        remind_before_min,count_unit,target_count,link_url,read_text,sort,created_by,created_at,updated_at)
       VALUES(?,?,'daily','["count"]',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(t.title, t.description, t.days_of_week, t.start_time, t.deadline_time, t.grace_minutes, t.start_date, t.end_date,
      t.remind_before_min, t.count_unit, t.target_count, t.link_url, t.read_text, t.sort, req.user.id, now(), now()).lastInsertRowid;
    writeAssign(tid, assign);
    return tid;
  });
  res.status(201).json({ task: taskOut(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)) });
});

r.put('/tasks/:id', adminOnly, (req, res) => {
  const ex = db.prepare('SELECT * FROM tasks WHERE id=? AND owner_id IS NULL').get(Number(req.params.id));
  if (!ex) throw notFound();
  const t = parseBody(req.body || {});
  const assign = parseAssign(req.body || {});
  tx(() => {
    db.prepare(
      `UPDATE tasks SET title=?,description=?,days_of_week=?,start_time=?,deadline_time=?,grace_minutes=?,start_date=?,end_date=?,
        remind_before_min=?,count_unit=?,target_count=?,link_url=?,read_text=?,sort=?,updated_at=? WHERE id=?`,
    ).run(t.title, t.description, t.days_of_week, t.start_time, t.deadline_time, t.grace_minutes, t.start_date, t.end_date,
      t.remind_before_min, t.count_unit, t.target_count, t.link_url, t.read_text, t.sort, now(), ex.id);
    writeAssign(ex.id, assign);
  });
  res.json({ task: taskOut(db.prepare('SELECT * FROM tasks WHERE id=?').get(ex.id)) });
});

// ---------------------------------------------------------------- إيقاف / أرشفة
export function openPause(id) {
  if (!db.prepare('SELECT 1 FROM task_pauses WHERE task_id=? AND to_date IS NULL').get(id)) {
    db.prepare('INSERT INTO task_pauses(task_id,from_date) VALUES(?,?)').run(id, localDate());
  }
}
export function closePause(id) {
  const yesterday = addDays(localDate(), -1);
  for (const p of db.prepare('SELECT * FROM task_pauses WHERE task_id=? AND to_date IS NULL').all(id)) {
    if (p.from_date > yesterday) db.prepare('DELETE FROM task_pauses WHERE id=?').run(p.id);
    else db.prepare('UPDATE task_pauses SET to_date=? WHERE id=?').run(yesterday, p.id);
  }
}

r.post('/tasks/:id/:action', adminOnly, (req, res) => {
  if (!['pause', 'resume', 'archive', 'unarchive'].includes(req.params.action)) throw notFound();
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND owner_id IS NULL').get(Number(req.params.id));
  if (!t) throw notFound();
  tx(() => {
    switch (req.params.action) {
      case 'pause': if (t.status === 'active') { openPause(t.id); db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(t.id); } break;
      case 'archive': if (t.status !== 'archived') { openPause(t.id); db.prepare("UPDATE tasks SET status='archived' WHERE id=?").run(t.id); } break;
      default: if (t.status !== 'active') { closePause(t.id); db.prepare("UPDATE tasks SET status='active' WHERE id=?").run(t.id); }
    }
  });
  res.json({ task: taskOut(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)) });
});

r.delete('/tasks/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM tasks WHERE id=? AND owner_id IS NULL').get(id)) throw notFound();
  if (db.prepare('SELECT 1 FROM submissions WHERE task_id=?').get(id)) throw bad('للورد تسجيلات سابقة؛ استخدم الأرشفة للحفاظ على السجلات');
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  res.json({ ok: true });
});

export default r;
