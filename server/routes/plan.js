import { Router } from 'express';
import { db, now, tx } from '../db.js';
import { addDays, localDate, localToMs } from '../util/time.js';
import { bad, notFound } from '../middleware/auth.js';
import { closePause, openPause, parseBody } from './tasks.js';

/**
 * «خطتي»: أوراد شخصية يضعها العضو لنفسه (اسم، هدف بالعدد، وقت، أيام) بنفس محرّك الأوراد.
 * الورد الشخصي خاص بصاحبه: لا يظهر في قوائم الإدارة ولا تقاريرها ولا تذكيراتها (owner_id).
 * الصلاحية مضمونة في my.js (requireAuth + قفل المتابعة قبل قبول الإيصال).
 */
const r = Router();
export const MAX_PERSONAL = 20;

const mine = (id, uid) => db.prepare('SELECT * FROM tasks WHERE id=? AND owner_id=?').get(id, uid);

function planOut(t) {
  let days = null;
  try { days = t.days_of_week == null ? null : JSON.parse(t.days_of_week); } catch { /* */ }
  return {
    id: t.id, title: t.title, description: t.description, count_unit: t.count_unit, target_count: t.target_count,
    start_time: t.start_time, deadline_time: t.deadline_time, days_of_week: days, start_date: t.start_date, end_date: t.end_date,
    status: t.status, has_history: !!db.prepare('SELECT 1 FROM submissions WHERE task_id=?').get(t.id),
  };
}

/** الحقول المسموحة للعضو فقط: لا مهلة ولا تذكير ولا رابط ولا ترتيب (هذه للإدارة) */
function parsePersonal(b, startDate) {
  return parseBody({
    title: b.title, description: b.description, count_unit: b.count_unit, target_count: b.target_count,
    start_time: b.start_time, deadline_time: b.deadline_time, days_of_week: b.days_of_week,
    end_date: b.end_date, start_date: startDate,
  });
}

r.get('/', (req, res) => {
  const rows = db.prepare("SELECT * FROM tasks WHERE owner_id=? AND status<>'archived' ORDER BY start_time, id").all(req.user.id);
  res.json({ tasks: rows.map(planOut), limit: MAX_PERSONAL });
});

r.post('/', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) c FROM tasks WHERE owner_id=? AND status<>'archived'").get(req.user.id).c;
  if (count >= MAX_PERSONAL) throw bad(`بلغت الحد الأقصى (${MAX_PERSONAL} وردًا). احذف وردًا أو أوقفه لتضيف جديدًا`);
  const t = parsePersonal(req.body || {}, localDate());
  // نافذة الورد انتهت اليوم: يبدأ من الغد حتى لا يُحسب اليوم «لم يُسجَّل» قبل أن تتاح للعضو فرصة
  const startsTomorrow = now() > localToMs(t.start_date, t.deadline_time);
  if (startsTomorrow) {
    t.start_date = addDays(t.start_date, 1);
    if (t.end_date && t.end_date < t.start_date) throw bad('تاريخ الانتهاء يسبق بداية الورد (يبدأ غداً لأن وقته اليوم انتهى)');
  }
  const id = tx(() => {
    const tid = db.prepare(
      `INSERT INTO tasks(title,description,kind,submit_types,days_of_week,start_time,deadline_time,grace_minutes,start_date,end_date,
        count_unit,target_count,owner_id,created_at,updated_at)
       VALUES(?,?,'daily','["count"]',?,?,?,0,?,?,?,?,?,?,?)`,
    ).run(t.title, t.description, t.days_of_week, t.start_time, t.deadline_time, t.start_date, t.end_date,
      t.count_unit, t.target_count, req.user.id, now(), now()).lastInsertRowid;
    db.prepare("INSERT INTO task_assignees(task_id,kind,ref_id,created_at) VALUES(?,'user',?,?)").run(tid, req.user.id, now());
    return tid;
  });
  res.status(201).json({ task: planOut(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)), starts_tomorrow: startsTomorrow });
});

r.put('/:id', (req, res) => {
  const ex = mine(Number(req.params.id), req.user.id);
  if (!ex || ex.status === 'archived') throw notFound();
  const t = parsePersonal(req.body || {}, ex.start_date);
  db.prepare(
    `UPDATE tasks SET title=?,description=?,days_of_week=?,start_time=?,deadline_time=?,end_date=?,count_unit=?,target_count=?,updated_at=? WHERE id=?`,
  ).run(t.title, t.description, t.days_of_week, t.start_time, t.deadline_time, t.end_date, t.count_unit, t.target_count, now(), ex.id);
  res.json({ task: planOut(db.prepare('SELECT * FROM tasks WHERE id=?').get(ex.id)) });
});

r.post('/:id/:action', (req, res) => {
  if (!['pause', 'resume'].includes(req.params.action)) throw notFound();
  const t = mine(Number(req.params.id), req.user.id);
  if (!t || t.status === 'archived') throw notFound();
  tx(() => {
    if (req.params.action === 'pause' && t.status === 'active') { openPause(t.id); db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(t.id); }
    if (req.params.action === 'resume' && t.status === 'paused') { closePause(t.id); db.prepare("UPDATE tasks SET status='active' WHERE id=?").run(t.id); }
  });
  res.json({ task: planOut(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)) });
});

/** الحذف النهائي إن لم تكن له تسجيلات، وإلا أرشفة تحفظ سجلّ العضو وإحصاءاته */
r.delete('/:id', (req, res) => {
  const t = mine(Number(req.params.id), req.user.id);
  if (!t || t.status === 'archived') throw notFound();
  if (db.prepare('SELECT 1 FROM submissions WHERE task_id=?').get(t.id)) {
    tx(() => { openPause(t.id); db.prepare("UPDATE tasks SET status='archived', updated_at=? WHERE id=?").run(now(), t.id); });
    return res.json({ ok: true, archived: true });
  }
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
  res.json({ ok: true, archived: false });
});

export default r;
