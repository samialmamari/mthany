import { db, now } from '../db.js';
import { config } from '../config.js';
import { sendReminder } from './messaging.js';
import { computeRows, loadContext } from './schedule.js';
import { addDays, localDate } from '../util/time.js';

const MANUAL_COOLDOWN_MS = 30 * 60_000;

export function fmtLocal(ms) {
  return new Intl.DateTimeFormat('ar-OM-u-nu-latn', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms + config.tzOffsetMin * 60_000));
}

const logStmt = () => db.prepare(
  'INSERT INTO reminders(task_id,user_id,occ_date,mode,channel,ok,error,sent_by,sent_at) VALUES(?,?,?,?,?,?,?,?,?)',
);

async function sendOne(row, ctx, mode, sentBy) {
  const user = ctx.users.get(row.user_id);
  const r = await sendReminder(user.phone, {
    userName: user.name, taskTitle: row.task_title, deadlineText: fmtLocal(row.deadline_at),
  });
  logStmt().run(row.task_id, row.user_id, row.date, mode, r.channel, r.ok ? 1 : 0, r.error ?? null, sentBy ?? null, now());
  return r;
}

/**
 * تذكير يدوي لمن لم يرسل في استحقاق معيّن.
 * allowedUserIds: نطاق صلاحية الفاعل (null = الكل)، userIds: تحديد أشخاص بعينهم (اختياري).
 */
export async function remindManual({ taskId, date, userIds, allowedUserIds, actorId }) {
  const ctx = loadContext();
  let rows = computeRows({ from: date, to: date, taskIds: [taskId], userIds: allowedUserIds, ctx })
    .filter((r) => r.date === date && (r.status === 'open' || r.status === 'missed'));
  if (userIds?.length) rows = rows.filter((r) => userIds.includes(r.user_id));
  const result = { sent: 0, failed: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    const recent = db.prepare(
      `SELECT 1 FROM reminders WHERE task_id=? AND user_id=? AND occ_date=? AND ok=1 AND sent_at > ?`,
    ).get(row.task_id, row.user_id, row.date, now() - MANUAL_COOLDOWN_MS);
    if (recent) { result.skipped++; continue; }
    const r = await sendOne(row, ctx, 'manual', actorId);
    if (r.ok) result.sent++; else { result.failed++; result.errors.push(r.error); }
  }
  result.errors = [...new Set(result.errors)].slice(0, 3);
  return result;
}

/** مجدول التذكير التلقائي قبل الموعد النهائي (للمهام التي ضُبط لها remind_before_min) */
async function autoTick() {
  const tasks = db.prepare(`SELECT id, remind_before_min FROM tasks WHERE status='active' AND remind_before_min IS NOT NULL`).all();
  if (!tasks.length) return;
  const maxMin = Math.max(...tasks.map((t) => t.remind_before_min));
  const today = localDate();
  const rows = computeRows({
    from: today, to: addDays(today, Math.ceil(maxMin / 1440) + 1), taskIds: tasks.map((t) => t.id),
  });
  const rb = new Map(tasks.map((t) => [t.id, t.remind_before_min * 60_000]));
  const ctx = loadContext();
  const t = Date.now();
  for (const row of rows) {
    if (row.status !== 'open') continue;
    if (row.deadline_at - t > rb.get(row.task_id)) continue;
    if (row.deadline_at <= t) continue;
    const done = db.prepare(`SELECT 1 FROM reminders WHERE task_id=? AND user_id=? AND occ_date=? AND mode='auto'`)
      .get(row.task_id, row.user_id, row.date);
    if (done) continue;
    await sendOne(row, ctx, 'auto', null);
  }
}

/** تذكير يومي واحد في الوقت الذي اختاره العضو، بما تبقى من أوراده */
async function personalTick() {
  const users = db.prepare("SELECT id, name, phone, reminder_time FROM users WHERE active=1 AND wa_notify=1 AND reminder_time IS NOT NULL").all();
  if (!users.length) return;
  const today = localDate();
  const nowLocal = new Date(Date.now() + config.tzOffsetMin * 60_000);
  const minutes = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes();
  for (const u of users) {
    const [hh, mm] = u.reminder_time.split(':').map(Number);
    const due = hh * 60 + mm;
    if (minutes < due || minutes > due + 30) continue;           // نافذة نصف ساعة
    const sent = db.prepare("SELECT 1 FROM reminders WHERE user_id=? AND occ_date=? AND mode='personal'").get(u.id, today);
    if (sent) continue;
    const rows = computeRows({ from: today, to: today, userIds: [u.id], includePersonal: true })
      .filter((r) => r.status === 'open' && !r.submission_id);
    if (!rows.length) continue;
    const names = rows.map((r) => r.task_title).slice(0, 6).join('، ');
    const res = await sendReminder(u.phone, { userName: u.name, taskTitle: names, deadlineText: 'نهاية اليوم' });
    db.prepare('INSERT INTO reminders(task_id,user_id,occ_date,mode,channel,ok,error,sent_at) VALUES(0,?,?,?,?,?,?,?)')
      .run(u.id, today, 'personal', res.channel, res.ok ? 1 : 0, res.error ?? null, now());
  }
}

export function startReminderScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await autoTick(); await personalTick(); } catch (e) { console.error('[reminders]', e); } finally { running = false; }
  };
  const h = setInterval(tick, 60_000);
  h.unref();
  return () => clearInterval(h);
}
