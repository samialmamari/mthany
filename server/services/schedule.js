/**
 * محرّك الأوراد اليومية: يولّد استحقاق كل ورد في كل يوم، ويحسب حالة كل (ورد × عضو × يوم) تلقائياً.
 * التواريخ نصوص محلية YYYY-MM-DD، والأوقات المطلقة بالمللي ثانية UTC.
 */
import { db, placeholders } from '../db.js';
import { addDays, dow, localDate, localToMs } from '../util/time.js';

export const STATUS = {
  upcoming: 'لم يحن وقته',
  open: 'متاح للتسجيل',
  on_time: 'سُجّل في وقته',
  missed: 'لم يُسجَّل',
};

const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function loadPauses() {
  const m = new Map();
  for (const p of db.prepare('SELECT task_id, from_date, to_date FROM task_pauses').all()) {
    if (!m.has(p.task_id)) m.set(p.task_id, []);
    m.get(p.task_id).push(p);
  }
  return m;
}

export function hydrateTask(t, pauses) {
  return { ...t, days_of_week: t.days_of_week == null ? null : parse(t.days_of_week, null), pauses: pauses?.get(t.id) || [] };
}

// ------------------------------------------------------------------ السياق
export function loadContext() {
  const users = new Map();
  for (const u of db.prepare('SELECT id,name,phone,role,active,created_at FROM users').all()) {
    users.set(u.id, { ...u, created_date: localDate(u.created_at), groups: [] });
  }
  const groupMembers = new Map();
  for (const m of db.prepare('SELECT user_id, group_id, joined_at FROM user_groups').all()) {
    users.get(m.user_id)?.groups.push({ group_id: m.group_id, joined_date: localDate(m.joined_at) });
    if (!groupMembers.has(m.group_id)) groupMembers.set(m.group_id, []);
    groupMembers.get(m.group_id).push(m.user_id);
  }
  const assignees = new Map();
  for (const a of db.prepare('SELECT * FROM task_assignees').all()) {
    if (!assignees.has(a.task_id)) assignees.set(a.task_id, []);
    assignees.get(a.task_id).push(a);
  }
  return { users, groupMembers, assignees };
}

// ------------------------------------------------------------------ توليد الاستحقاقات
/** يرجع [{date, opens, deadline, final}] لورد داخل المدى [from,to] */
export function occurrencesForTask(task, from, to) {
  const out = [];
  const lo = from > task.start_date ? from : task.start_date;
  const hi = task.end_date && task.end_date < to ? task.end_date : to;
  const pz = task.pauses || [];
  for (let d = lo; d <= hi; d = addDays(d, 1)) {
    if (task.days_of_week && !task.days_of_week.includes(dow(d))) continue;
    if (pz.some((p) => d >= p.from_date && d <= (p.to_date || '9999-12-31'))) continue;
    const deadline = localToMs(d, task.deadline_time);
    out.push({ date: d, opens: localToMs(d, task.start_time), deadline, final: deadline + (task.grace_minutes || 0) * 60_000 });
  }
  return out;
}

// ------------------------------------------------------------------ المشمولون بالورد
/** Map(userId → أول تاريخ يصبح فيه العضو مشمولاً بالورد) */
export function eligibleUsers(task, ctx) {
  const res = new Map();
  const put = (uid, date) => {
    const u = ctx.users.get(uid);
    if (!u || !u.active) return;
    const cur = res.get(uid);
    if (!cur || date < cur) res.set(uid, date);
  };
  for (const a of ctx.assignees.get(task.id) || []) {
    if (a.kind === 'all') {
      for (const u of ctx.users.values()) if (u.role !== 'admin') put(u.id, u.created_date);
    } else if (a.kind === 'user') {
      put(a.ref_id, localDate(a.created_at));
    } else if (a.kind === 'group') {
      for (const uid of ctx.groupMembers.get(a.ref_id) || []) {
        const mem = ctx.users.get(uid).groups.find((g) => g.group_id === a.ref_id);
        put(uid, mem ? mem.joined_date : ctx.users.get(uid).created_date);
      }
    }
  }
  return res;
}

// ------------------------------------------------------------------ الحالة
export function statusOf({ sub, nowMs, occ }) {
  if (sub) return 'on_time';
  if (nowMs > occ.final) return 'missed';
  if (nowMs >= occ.opens) return 'open';
  return 'upcoming';
}

/**
 * يحسب الصفوف: لكل (ورد × عضو × تاريخ) صف بحالته.
 * opts: { from, to, taskIds, userIds (تقييد), groupIds, nowMs, includePersonal }
 * الأوراد الشخصية (owner_id) خاصة بأصحابها: لا تدخل في أي حساب إداري، وتُضمَّن فقط حين يمرّر
 * المستدعي includePersonal مع userIds لشاشات العضو نفسه.
 */
export function computeRows(opts) {
  const nowMs = opts.nowMs ?? Date.now();
  const { from, to } = opts;
  const ctx = opts.ctx || loadContext();

  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const args = [];
  if (opts.includePersonal && opts.userIds?.length) { sql += ` AND (owner_id IS NULL OR owner_id IN (${placeholders(opts.userIds)}))`; args.push(...opts.userIds); }
  else sql += ' AND owner_id IS NULL';
  if (opts.taskIds?.length) { sql += ` AND id IN (${placeholders(opts.taskIds)})`; args.push(...opts.taskIds); }
  const pz = loadPauses();
  const tasks = db.prepare(sql).all(...args).map((t) => hydrateTask(t, pz));

  const subs = new Map();
  for (const s of db.prepare('SELECT * FROM submissions WHERE occ_date BETWEEN ? AND ?').all(from, to)) {
    subs.set(`${s.task_id}|${s.user_id}|${s.occ_date}`, s);
  }

  let allowed = opts.userIds ? new Set(opts.userIds) : null;
  if (opts.groupIds?.length) {
    const g = new Set();
    for (const gid of opts.groupIds) for (const uid of ctx.groupMembers.get(gid) || []) g.add(uid);
    allowed = allowed ? new Set([...allowed].filter((x) => g.has(x))) : g;
  }

  const rows = [];
  for (const task of tasks) {
    const occs = occurrencesForTask(task, from, to);
    if (!occs.length) continue;
    for (const [uid, since] of eligibleUsers(task, ctx)) {
      if (allowed && !allowed.has(uid)) continue;
      const user = ctx.users.get(uid);
      for (const occ of occs) {
        const sub = subs.get(`${task.id}|${uid}|${occ.date}`);
        if (!sub && occ.date < since) continue; // لم يكن مشمولاً وقتها
        rows.push({
          task_id: task.id, task_title: task.title, count_unit: task.count_unit, target_count: task.target_count,
          user_id: uid, user_name: user.name, user_phone: user.phone,
          date: occ.date, opens_at: occ.opens, deadline_at: occ.deadline, final_at: occ.final,
          status: statusOf({ sub, nowMs, occ }),
          submission_id: sub?.id ?? null, submitted_at: sub?.submitted_at ?? null, count: sub?.count ?? null,
        });
      }
    }
  }
  return rows;
}

// ------------------------------------------------------------------ ملخّصات
export function emptyCounts() {
  return { total: 0, upcoming: 0, open: 0, on_time: 0, missed: 0 };
}

export function tally(rows) {
  const c = emptyCounts();
  for (const r of rows) { c.total++; c[r.status]++; }
  return { ...c, ...rates(c) };
}

/**
 * المواظبة = (سُجّل في وقته) ÷ (المستحق = في وقته + لم يُسجَّل) — دون المتاح بعد أو ما لم يحن وقته.
 * لا تسجيل لاحق: اليوم إمّا سُجّل في وقته وإمّا لم يُسجَّل.
 */
export function rates(c) {
  const due = c.on_time + c.missed;
  return { due, compliance: due ? Math.round((c.on_time / due) * 1000) / 10 : null };
}

/** معرّفات الأعضاء الذين يحق للفاعل متابعتهم (null = الكل) */
export function scopeUserIds(actor) {
  if (actor.role === 'admin') return null;
  if (actor.role !== 'supervisor') return [actor.id];
  const r = db.prepare(`SELECT DISTINCT ug.user_id FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE g.supervisor_id = ?`).all(actor.id);
  return r.map((x) => x.user_id);
}

/** هل يجوز للعضو تسجيل هذا الورد في هذا اليوم؟ يرجع {occ, task} أو null */
export function findAssignedOccurrence(taskId, userId, date) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!t) return null;
  const task = hydrateTask(t, loadPauses());
  const since = eligibleUsers(task, loadContext()).get(userId);
  if (!since || date < since) return null;
  const occ = occurrencesForTask(task, date, date)[0];
  return occ ? { task, occ } : null;
}
