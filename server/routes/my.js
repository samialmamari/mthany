import { Router } from 'express';
import { db, now, placeholders, tx } from '../db.js';
import { addDays, isDate, localDate } from '../util/time.js';
import { bad, forbidden, requireAuth } from '../middleware/auth.js';
import { cleanBody } from '../util/sanitize.js';
import { computeRows, findAssignedOccurrence, tally } from '../services/schedule.js';
import { REG_LABEL, regState } from '../services/registrations.js';
import { getSite } from '../services/site.js';
import { messageOf, mushafPosition, streakOf, totalsOf } from '../services/progress.js';
import plan from './plan.js';

const r = Router();
r.use(requireAuth);

// لوحة المتابعة تُفتح بعد قبول الإدارة لإيصال المشترك؛ قبل ذلك يرى طلباته فقط
const locked = (u) => u.role === 'user' && !u.tracking_access;
r.use((req, _res, next) => (locked(req.user) && !['/registrations', '/today'].includes(req.path)
  ? next(forbidden('تُفتح لوحة المتابعة بعد مراجعة الإدارة لإيصالك بإذن الله'))
  : next()));

// ---------------------------------------------------------------- مساعدات العرض
function decorate(rows) {
  if (!rows.length) return [];
  const tids = [...new Set(rows.map((x) => x.task_id))];
  const tasks = new Map(db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders(tids)})`).all(...tids).map((t) => [t.id, t]));
  const sids = rows.map((x) => x.submission_id).filter(Boolean);
  const subs = new Map(sids.length ? db.prepare(`SELECT * FROM submissions WHERE id IN (${placeholders(sids)})`).all(...sids).map((s) => [s.id, s]) : []);
  const t = now();
  return rows.map((x) => {
    const task = tasks.get(x.task_id);
    const sub = subs.get(x.submission_id);
    let action = null;
    if (t >= x.opens_at && t <= x.final_at) action = sub ? 'edit' : 'submit';
    const target = task.target_count;
    return {
      task_id: x.task_id, date: x.date, title: x.task_title, description: task.description, count_unit: task.count_unit, target_count: target,
      sort: task.sort ?? 0, personal: !!task.owner_id,
      ui: target === 1 ? 'check' : task.count_unit === 'صفحة' ? 'pages' : 'count', link_url: task.link_url || '', read_text: task.read_text || '',
      start_time: task.start_time, deadline_time: task.deadline_time, grace_minutes: task.grace_minutes, opens_at: x.opens_at, deadline_at: x.deadline_at, final_at: x.final_at, status: x.status, action,
      submission: sub ? { id: sub.id, count: sub.count, note: sub.note, submitted_at: sub.submitted_at, updated_at: sub.updated_at } : null,
    };
  });
}

// أوراد المنصة أولاً بترتيب الإدارة، ثم أوراد العضو الشخصية بترتيب أوقاتها
const byTask = (a, b) => (a.personal - b.personal) || (a.personal ? a.opens_at - b.opens_at : a.sort - b.sort) || (a.task_id - b.task_id);

// ---------------------------------------------------------------- تسجيلاتي في الدورات (متابعة حالة الاشتراك)
r.get('/registrations', (req, res) => {
  const rows = db.prepare(`SELECT cr.id, cr.status, cr.reject_reason, cr.created_at, cr.confirmed_at, c.id AS course_id, c.title, c.whatsapp_link
    FROM course_registrations cr JOIN courses c ON c.id = cr.course_id
    WHERE (cr.user_id = ? OR (cr.user_id IS NULL AND cr.phone = ?)) AND cr.kind = 'self' ORDER BY cr.id DESC LIMIT 30`).all(req.user.id, req.user.phone);
  res.json({ locked: locked(req.user), registrations: rows.map((x) => {
    const st = regState(x);
    return { id: x.id, course_id: x.course_id, title: x.title, created_at: x.created_at, status: st, status_label: REG_LABEL[st],
      reject_reason: x.reject_reason, whatsapp_link: st === 'cancelled' || st === 'rejected' ? '' : x.whatsapp_link || getSite().whatsapp_link || '' };
  }) });
});

// ---------------------------------------------------------------- خطتي: أوراد العضو الشخصية
r.use('/plan', plan);

// ---------------------------------------------------------------- وردي اليوم / السجل
r.get('/today', (req, res) => {
  const t = now();
  const today = localDate(t);
  if (locked(req.user)) return res.json({ locked: true, now: t, today, user: { name: req.user.name }, message: null, streak: 0, progress: { done: 0, total: 0, percent: 0 }, today_tasks: [] });
  const rows = computeRows({ from: addDays(today, -30), to: today, userIds: [req.user.id], nowMs: t, includePersonal: true });
  const items = decorate(rows);
  const todayItems = items.filter((x) => x.date === today).sort(byTask);
  const totals = totalsOf(req.user.id);
  for (const it of todayItems) {
    const tot = totals.get(it.task_id);
    it.total_all_time = tot?.total ?? 0;
    if (it.ui === 'pages') it.mushaf = mushafPosition(it.total_all_time);
  }
  const done = todayItems.filter((x) => x.submission && (!x.target_count || x.submission.count >= x.target_count)).length;
  // لكل ورد وزن متساوٍ حتى لا يطغى ورد هدفه 500 على ورد هدفه 1
  const ratio = todayItems.reduce((a, x) => a + Math.min(1, (x.submission?.count ?? 0) / (x.target_count || 1)), 0);
  res.json({
    now: t, today,
    user: { name: req.user.name },
    message: messageOf(today),
    streak: streakOf(req.user.id, today, t),
    progress: { done, total: todayItems.length, percent: todayItems.length ? Math.round((ratio / todayItems.length) * 100) : 0 },
    today_tasks: todayItems,
  });
});

r.get('/history', (req, res) => {
  const t = now();
  const today = localDate(t);
  const to = isDate(req.query.to) && req.query.to < today ? req.query.to : today;
  const from = isDate(req.query.from) ? req.query.from : addDays(to, -30);
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw bad('المدى أطول من المسموح');
  const rows = computeRows({ from, to, userIds: [req.user.id], nowMs: t, includePersonal: true })
    .filter((x) => x.status !== 'upcoming' && x.status !== 'open')
    .sort((a, b) => b.date.localeCompare(a.date) || a.task_id - b.task_id);
  res.json({ from, to, items: decorate(rows.slice(0, 600)) });
});

// ---------------------------------------------------------------- تسجيل العدد وتعديله
r.post('/submit', (req, res) => {
  const taskId = Number(req.body?.task_id);
  const date = req.body?.date;
  if (!taskId || !isDate(date)) throw bad('بيانات الورد غير مكتملة');
  const found = findAssignedOccurrence(taskId, req.user.id, date);
  if (!found) throw forbidden('هذا الورد غير مسند إليك');
  const { occ } = found;
  const t = now();
  if (t < occ.opens) throw bad('لم يحن وقت تسجيل هذا الورد بعد');

  const existing = db.prepare('SELECT * FROM submissions WHERE task_id=? AND user_id=? AND occ_date=?').get(taskId, req.user.id, date);
  if (t > occ.final) throw bad('انتهى وقت هذا اليوم؛ لا يمكن تسجيله أو تعديله بعد انتهائه');

  const raw = req.body?.count;
  const count = raw === '' || raw === null ? NaN : Number(raw);
  if (!Number.isInteger(count) || count < 0 || count > 10_000_000) throw bad('أدخل عدداً صحيحاً أكبر من صفر');
  // الصفر = إلغاء التسجيل (إزالة علامة الإتمام أو إنقاص العدد إلى صفر)
  if (count === 0) {
    if (existing) db.prepare('DELETE FROM submissions WHERE id=?').run(existing.id);
    return res.json({ ok: true, id: null });
  }
  const note = req.body?.note === undefined ? (existing?.note ?? '') : cleanBody(req.body.note, 500);

  const id = tx(() => {
    if (existing) {
      db.prepare('UPDATE submissions SET note=?, count=?, updated_at=?, edit_count=edit_count+1 WHERE id=?').run(note, count, t, existing.id);
      return existing.id;
    }
    return db.prepare('INSERT INTO submissions(task_id,user_id,occ_date,note,count,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(taskId, req.user.id, date, note, count, t, t).lastInsertRowid;
  });
  res.status(existing ? 200 : 201).json({ ok: true, id });
});

// ---------------------------------------------------------------- الإحصاءات
const SUBMITTED = (st) => st === 'on_time';
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

r.get('/stats', (req, res) => {
  const t = now();
  const today = localDate(t);
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const from = addDays(today, -(days - 1));
  const rows = computeRows({ from, to: today, userIds: [req.user.id], nowMs: t, includePersonal: true });

  const tids = [...new Set(rows.map((x) => x.task_id))].sort((a, b) => a - b);
  const tasks = tids.map((tid) => {
    const list = rows.filter((x) => x.task_id === tid).sort((a, b) => a.date.localeCompare(b.date));
    // اليوم المفتوح لا يُرسم قبل أن ينتهي حتى لا يهبط الخط إلى صفر قبل أن يسجّل العضو
    const points = list.map((x) => ({ date: x.date, status: x.status, value: SUBMITTED(x.status) ? x.count : x.status === 'missed' ? 0 : null })).filter((p) => p.value != null);

    // أيام متتالية: نتجاوز اليوم المفتوح ونتوقف عند أول يوم لم يُسجَّل
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i].status;
      if (st === 'open' || st === 'upcoming') continue;
      if (SUBMITTED(st)) streak++; else break;
    }
    const vals = points.map((p) => p.value);
    const last7 = avg(vals.slice(-7)); const prev7 = avg(vals.slice(-14, -7));
    const delta = last7 != null && prev7 ? Math.round(((last7 - prev7) / prev7) * 100) : null;
    const c = { on_time: 0, missed: 0 };
    for (const x of list) if (c[x.status] !== undefined) c[x.status]++;
    const due = c.on_time + c.missed;
    const total = vals.reduce((a, b) => a + b, 0);
    const best = points.reduce((b, p) => (p.value > (b?.value ?? -1) ? p : b), null);
    const target = list[0].target_count;
    return {
      task_id: tid, title: list[0].task_title, count_unit: list[0].count_unit, target_count: target, points,
      summary: {
        ...c, due, streak, delta, total, best,
        average: points.length ? Math.round((total / points.length) * 10) / 10 : null,
        goal_days: target ? points.filter((p) => p.value >= target).length : null,
      },
    };
  });

  // خريطة الشهور: نسبة الإنجاز لكل يوم
  const byDate = new Map();
  for (const x of rows) {
    if (!byDate.has(x.date)) byDate.set(x.date, { total: 0, done: 0 });
    const d = byDate.get(x.date); d.total++; if (SUBMITTED(x.status)) d.done++;
  }
  const heatmap = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({ date, done: d.done, total: d.total, percent: d.total ? Math.round((d.done / d.total) * 100) : 0 }));

  const totals = totalsOf(req.user.id);
  const cumulative = [...totals.values()].filter((x) => x.total > 0)
    .map((x) => ({ task_id: x.id, title: x.title, unit: x.count_unit, total: x.total, days: x.days, mushaf: x.count_unit === 'صفحة' ? mushafPosition(x.total) : null }));

  res.json({ days, from, to: today, overall: tally(rows), tasks, heatmap, cumulative, streak: streakOf(req.user.id, today, t) });
});

export default r;
