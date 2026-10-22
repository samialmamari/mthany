/**
 * أرقام لوحة العضو: رسالة اليوم، والسلسلة، والتقدّم العام، والمجاميع التراكمية.
 */
import { db } from '../db.js';
import { addDays, localDate } from '../util/time.js';
import { computeRows } from './schedule.js';

export const PAGES_PER_KHATMAH = 604;
export const PAGES_PER_JUZ = 20;

/** رسالة اليوم: رسالة مخصصة لهذا التاريخ إن وُجدت، وإلا تدوير يومي بين الرسائل الفعّالة */
export function messageOf(date = localDate()) {
  const pinned = db.prepare('SELECT * FROM daily_messages WHERE show_date = ? AND active = 1 ORDER BY sort, id LIMIT 1').get(date);
  if (pinned) return { text: pinned.text, source: pinned.source };
  const pool = db.prepare('SELECT * FROM daily_messages WHERE show_date IS NULL AND active = 1 ORDER BY sort, id').all();
  if (!pool.length) return null;
  const dayIndex = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  const m = pool[((dayIndex % pool.length) + pool.length) % pool.length];
  return { text: m.text, source: m.source };
}

/**
 * سلسلة المواظبة: عدد الأيام المتتالية التي أتمّ فيها العضو كل أوراده، حتى أمس،
 * ويُضاف اليوم إن أتمّه. اليوم غير المكتمل لا يكسر السلسلة قبل انتهائه.
 */
export function streakOf(userId, today = localDate(), nowMs = Date.now()) {
  const rows = computeRows({ from: addDays(today, -120), to: today, userIds: [userId], nowMs, includePersonal: true });
  if (!rows.length) return 0;
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { total: 0, done: 0 });
    const d = byDate.get(r.date);
    d.total++;
    if (r.status === 'on_time') d.done++;
  }
  let streak = 0;
  let cursor = today;
  const todayStats = byDate.get(today);
  if (!todayStats || todayStats.done < todayStats.total) cursor = addDays(today, -1); // اليوم لم يكتمل بعد
  while (byDate.has(cursor)) {
    const d = byDate.get(cursor);
    if (!d.total || d.done < d.total) break;
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** المجموع التراكمي لكل ورد منذ البداية */
export function totalsOf(userId) {
  const rows = db.prepare(
    `SELECT t.id, t.title, t.count_unit, t.target_count, COALESCE(SUM(s.count), 0) AS total, COUNT(s.id) AS days
     FROM tasks t LEFT JOIN submissions s ON s.task_id = t.id AND s.user_id = ?
     WHERE t.owner_id IS NULL OR t.owner_id = ?
     GROUP BY t.id ORDER BY t.id`,
  ).all(userId, userId);
  return new Map(rows.map((r) => [r.id, r]));
}

/** موضع القراءة في المصحف من مجموع الصفحات المسجَّلة */
export function mushafPosition(totalPages) {
  const khatmat = Math.floor(totalPages / PAGES_PER_KHATMAH);
  const inside = totalPages % PAGES_PER_KHATMAH;
  return {
    khatmat,
    next_page: inside + 1,
    juz: Math.min(30, Math.floor(inside / PAGES_PER_JUZ) + 1),
    pages_total: totalPages,
    to_next_khatmah: PAGES_PER_KHATMAH - inside,
  };
}
