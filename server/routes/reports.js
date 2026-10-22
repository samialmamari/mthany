import { Router } from 'express';
import ExcelJS from 'exceljs';
import { db } from '../db.js';
import { config } from '../config.js';
import { addDays, isDate, localDate } from '../util/time.js';
import { bad, forbidden, notFound, requireRole } from '../middleware/auth.js';
import { computeRows, emptyCounts, rates, scopeUserIds, STATUS, tally } from '../services/schedule.js';
import { remindManual } from '../services/reminders.js';
import { submissionDetail } from '../services/submissions.js';

const r = Router();
const staff = requireRole('admin', 'supervisor');

function range(q, fallbackDays = 0) {
  const today = localDate();
  const from = isDate(q.from) ? q.from : addDays(today, -fallbackDays);
  const to = isDate(q.to) ? q.to : today;
  if (to < from) throw bad('نطاق التاريخ غير صالح');
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw bad('المدى أطول من المسموح');
  return { from, to };
}
const ids = (v) => (v ? String(v).split(',').map(Number).filter(Boolean) : undefined);

function query(req, defaultDays) {
  const { from, to } = range(req.query, defaultDays);
  let userIds = scopeUserIds(req.user);
  const wanted = ids(req.query.user_id);
  if (wanted) userIds = userIds ? wanted.filter((x) => userIds.includes(x)) : wanted;
  const rows = computeRows({ from, to, taskIds: ids(req.query.task_id), groupIds: ids(req.query.group_id), userIds });
  return { from, to, rows };
}

// ---------------------------------------------------------------- نظرة عامة
r.get('/dashboard', staff, (req, res) => {
  const today = localDate();
  const monthStart = `${today.slice(0, 8)}01`;
  const groupIds = ids(req.query.group_id);
  const userIds = scopeUserIds(req.user);
  const mk = (from, to) => computeRows({ from, to, userIds, groupIds });

  const todayRows = mk(today, today).filter((x) => x.date === today);
  const monthRows = mk(monthStart, today);

  // ملخص لكل ورد اليوم، مع مجموع ما سُجّل
  const byTask = new Map();
  for (const x of todayRows) {
    if (!byTask.has(x.task_id)) byTask.set(x.task_id, { task_id: x.task_id, title: x.task_title, count_unit: x.count_unit, target_count: x.target_count, deadline_at: x.deadline_at, count_sum: 0, ...emptyCounts() });
    const t = byTask.get(x.task_id); t.total++; t[x.status]++; if (x.count) t.count_sum += x.count;
  }
  const tasks = [...byTask.values()].map((t) => ({ ...t, ...rates(t) })).sort((a, b) => a.task_id - b.task_id);

  // الأقل مواظبة هذا الشهر — للتشجيع والمتابعة اللطيفة
  const byUser = new Map();
  for (const x of monthRows) {
    if (!byUser.has(x.user_id)) byUser.set(x.user_id, { user_id: x.user_id, name: x.user_name, ...emptyCounts() });
    const u = byUser.get(x.user_id); u.total++; u[x.status]++;
  }
  const needEncouragement = [...byUser.values()].map((u) => ({ ...u, ...rates(u) }))
    .filter((u) => u.due > 0).sort((a, b) => (a.compliance ?? 101) - (b.compliance ?? 101) || b.missed - a.missed).slice(0, 8);

  res.json({ today, day: tally(todayRows), month: tally(monthRows), tasks, laggards: needEncouragement });
});

// ---------------------------------------------------------------- متابعة الأعضاء
r.get('/tracking', staff, (req, res) => {
  const { from, to, rows } = query(req, 0);
  const status = req.query.status;
  const filtered = status ? rows.filter((x) => x.status === status) : rows;
  filtered.sort((a, b) => b.date.localeCompare(a.date) || a.task_id - b.task_id || a.user_name.localeCompare(b.user_name, 'ar'));
  const limit = Math.min(Number(req.query.limit) || 1000, 3000);
  res.json({ from, to, summary: tally(rows), total: filtered.length, rows: filtered.slice(0, limit) });
});

r.get('/submissions/:id', staff, (req, res) => {
  const s = submissionDetail(Number(req.params.id));
  if (!s) throw notFound();
  const scope = scopeUserIds(req.user);
  if (scope && !scope.includes(s.user_id)) throw forbidden();
  res.json({ submission: s });
});

// ---------------------------------------------------------------- التقارير
function aggregate(rows, keyFn, labelFn) {
  const m = new Map();
  for (const x of rows) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, { key: k, label: labelFn(x), count_sum: 0, count_unit: x.count_unit, ...emptyCounts() });
    const a = m.get(k); a.total++; a[x.status]++; if (x.count) a.count_sum += x.count;
  }
  return [...m.values()].map((a) => ({ ...a, ...rates(a) }));
}

r.get('/reports/summary', staff, (req, res) => {
  const { from, to, rows } = query(req, 29);
  const users = aggregate(rows, (x) => x.user_id, (x) => x.user_name)
    .sort((a, b) => (a.compliance ?? 101) - (b.compliance ?? 101) || a.label.localeCompare(b.label, 'ar'));
  const tasks = aggregate(rows, (x) => x.task_id, (x) => x.task_title).sort((a, b) => a.key - b.key);
  const days = aggregate(rows, (x) => x.date, (x) => x.date).sort((a, b) => a.key.localeCompare(b.key));
  res.json({ from, to, overall: tally(rows), users, tasks, days });
});

r.get('/reports/export', staff, async (req, res) => {
  const { from, to, rows } = query(req, 29);
  const wb = new ExcelJS.Workbook();
  const head = (ws) => { ws.getRow(1).font = { bold: true }; ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }]; };
  const pct = (v) => (v == null ? '—' : `${v}%`);

  const w1 = wb.addWorksheet('ملخص الأعضاء');
  w1.columns = [
    { header: 'العضو', width: 26 }, { header: 'المستحق', width: 10 }, { header: 'في وقته', width: 10 },
    { header: 'لم يُسجَّل', width: 10 }, { header: 'نسبة المواظبة', width: 14 },
  ];
  for (const u of aggregate(rows, (x) => x.user_id, (x) => x.user_name).sort((a, b) => a.label.localeCompare(b.label, 'ar'))) {
    w1.addRow([u.label, u.due, u.on_time, u.missed, pct(u.compliance)]);
  }
  head(w1);

  const w2 = wb.addWorksheet('ملخص الأوراد');
  w2.columns = [{ header: 'الورد', width: 34 }, { header: 'المستحق', width: 10 }, { header: 'في وقته', width: 10 },
    { header: 'لم يُسجَّل', width: 10 }, { header: 'نسبة المواظبة', width: 14 }, { header: 'إجمالي العدد', width: 14 }, { header: 'الوحدة', width: 10 }];
  for (const t of aggregate(rows, (x) => x.task_id, (x) => x.task_title).sort((a, b) => a.key - b.key)) {
    w2.addRow([t.label, t.due, t.on_time, t.missed, pct(t.compliance), t.count_sum || '', t.count_unit]);
  }
  head(w2);

  const w3 = wb.addWorksheet('التفاصيل');
  w3.columns = [{ header: 'التاريخ', width: 12 }, { header: 'الورد', width: 30 }, { header: 'العضو', width: 24 }, { header: 'الهاتف', width: 16 },
    { header: 'الحالة', width: 20 }, { header: 'العدد', width: 12 }, { header: 'وقت التسجيل', width: 20 }];
  const fmt = (ms) => (ms ? new Date(ms + config.tzOffsetMin * 60_000).toISOString().slice(0, 16).replace('T', ' ') : '');
  for (const x of rows.sort((a, b) => a.date.localeCompare(b.date))) {
    w3.addRow([x.date, x.task_title, x.user_name, x.user_phone, STATUS[x.status], x.count ?? '', fmt(x.submitted_at)]);
  }
  head(w3);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report-${from}_${to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------------------------------------------------------------- التذكير اللطيف
r.post('/reminders', staff, async (req, res) => {
  const { task_id, date, user_ids } = req.body || {};
  if (!task_id || !isDate(date)) throw bad('حدّد الورد والتاريخ');
  if (!db.prepare('SELECT 1 FROM tasks WHERE id=? AND owner_id IS NULL').get(Number(task_id))) throw notFound('الورد غير موجود');
  const result = await remindManual({
    taskId: Number(task_id), date, userIds: Array.isArray(user_ids) ? user_ids.map(Number) : undefined,
    allowedUserIds: scopeUserIds(req.user), actorId: req.user.id,
  });
  res.json(result);
});

export default r;
