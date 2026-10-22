import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mthany-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.ADMIN_PHONE = '+96890000000';
process.env.MESSAGE_PROVIDER = 'console';
process.env.DEV_SHOW_OTP = '1';
process.env.NODE_ENV = 'test';

let server, base;
const jars = {};

async function api(who, method, url, body, isForm) {
  const headers = {};
  if (jars[who]) headers.cookie = jars[who];
  let payload;
  if (isForm) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) jars[who] = sc.map((c) => c.split(';')[0]).join('; ');
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

/** نموذج متعدد الأجزاء مع إيصال تحويل (الدورة المدفوعة تتطلبه من الجميع) */
function withReceipt(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, Array.isArray(v) ? v.join(',') : String(v));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  f.append('receipt', new Blob([png], { type: 'image/png' }), 'receipt.png');
  return f;
}

async function login(who, phone) {
  const { db } = await import('../server/db.js');
  db.prepare('UPDATE otps SET created_at = created_at - 120000').run(); // تجاوز فاصل 60 ثانية
  const a = await api(who, 'POST', '/api/auth/request-otp', { phone });
  assert.equal(a.status, 200);
  const b = await api(who, 'POST', '/api/auth/verify-otp', { phone, code: a.data.dev_code });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  return b.data.user;
}

before(async () => {
  const { ensureAdmin } = await import('../server/bootstrap.js');
  const { createApp } = await import('../server/app.js');
  ensureAdmin();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('OTP: رقم غير مسجل لا يستلم رمزاً، والمسجل يدخل', async () => {
  const unk = await api('x', 'POST', '/api/auth/request-otp', { phone: '99999999' });
  assert.equal(unk.status, 200);
  assert.equal(unk.data.dev_code, undefined);
  const bad = await api('x', 'POST', '/api/auth/request-otp', { phone: '123' });
  assert.equal(bad.status, 400);
  const u = await login('admin', '90000000'); // يُطبَّع إلى +96890000000
  assert.equal(u.role, 'admin');
  const me = await api('admin', 'GET', '/api/auth/me');
  assert.equal(me.data.user.phone, '+96890000000');
});

test('OTP: محاولات خاطئة تُبطل الرمز، وحد الطلبات', async () => {
  await api('admin', 'POST', '/api/admin/users', { name: 'اختبار', phone: '91111111' });
  const a = await api('t', 'POST', '/api/auth/request-otp', { phone: '91111111' });
  for (let i = 0; i < 5; i++) {
    const w = await api('t', 'POST', '/api/auth/verify-otp', { phone: '91111111', code: '000000' === a.data.dev_code ? '111111' : '000000' });
    assert.equal(w.status, 400);
  }
  const right = await api('t', 'POST', '/api/auth/verify-otp', { phone: '91111111', code: a.data.dev_code });
  assert.equal(right.status, 400, 'الرمز الصحيح بعد 5 محاولات خاطئة يجب أن يُرفض');
  const again = await api('t', 'POST', '/api/auth/request-otp', { phone: '91111111' });
  assert.equal(again.status, 429);
});


test('الإدارة: أعضاء وحلقة وورد بهدف يومي، مع تحقق من المدخلات', async () => {
  U1 = (await api('admin', 'POST', '/api/admin/users', { name: 'أحمد', phone: '92222222' })).data.user;
  U2 = (await api('admin', 'POST', '/api/admin/users', { name: 'سالم', phone: '93333333' })).data.user;
  assert.equal((await api('admin', 'POST', '/api/admin/users', { name: 'مكرر', phone: '+968 9222 2222' })).status, 400);
  G = (await api('admin', 'POST', '/api/admin/groups', { name: 'حلقة الفجر', user_ids: [U1.id] })).data.group;

  const mk = (o) => api('admin', 'POST', '/api/admin/tasks', { title: 'الاستغفار', count_unit: 'مرة', target_count: 100, start_date: '2020-01-01', assign: { group_ids: [G.id] }, ...o });
  const ok = await mk({});
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  wird = ok.data.task;
  assert.equal(wird.target_count, 100); assert.equal(wird.count_unit, 'مرة'); assert.equal(wird.kind, 'daily');
  assert.equal((await mk({ title: '' })).status, 400, 'الاسم مطلوب');
  assert.equal((await mk({ target_count: 0 })).status, 400, 'الهدف موجب');
  assert.equal((await mk({ days_of_week: [] })).status, 400, 'يوم واحد على الأقل');
  assert.equal((await mk({ start_time: '10:00', deadline_time: '09:00' })).status, 400);
  assert.equal((await mk({ assign: {} })).status, 400, 'يلزم إسناد');
  assert.equal((await mk({ title: '<b>ورد</b>' })).data.task.title, 'ورد', 'تنقية الوسوم');
});

test('الصلاحيات: العضو لا يدخل لوحة الإدارة ولا يسجّل وردًا غير مسند إليه', async () => {
  await login('u1', '92222222'); await login('u2', '93333333');
  assert.equal((await api('u1', 'GET', '/api/admin/users')).status, 403);
  assert.equal((await api('u1', 'POST', '/api/admin/tasks', {})).status, 403);
  assert.equal((await api('anon', 'GET', '/api/my/today')).status, 401);
  const t1 = (await api('u1', 'GET', '/api/my/today')).data;
  const mine = t1.today_tasks.find((t) => t.task_id === wird.id);
  assert.ok(mine, 'U1 ضمن الحلقة فيرى الورد');
  assert.equal(mine.target_count, 100);
  assert.ok(!(await api('u2', 'GET', '/api/my/today')).data.today_tasks.some((t) => t.task_id === wird.id), 'U2 خارج الحلقة');
  assert.equal((await api('u2', 'POST', '/api/my/submit', { task_id: wird.id, date: t1.today, count: 5 })).status, 403);
});

test('تسجيل العدد: حفظ وتحديث ورفض القيم غير الصالحة', async () => {
  const today = (await api('u1', 'GET', '/api/my/today')).data.today;
  const send = (c, extra = {}) => api('u1', 'POST', '/api/my/submit', { task_id: wird.id, date: today, count: c, ...extra });
  for (const bad of [-5, 1.5, 'abc', '', null, 20_000_000]) assert.equal((await send(bad)).status, 400, `مرفوض: ${bad}`);
  assert.equal((await send(100)).status, 201);
  assert.equal((await send(0)).status, 200, 'الصفر يلغي التسجيل');
  assert.equal((await send(100)).status, 201);
  assert.equal((await send(150, { note: 'الحمد لله <script>x</script>' })).status, 200, 'التحديث قبل نهاية اليوم');
  const item = (await api('u1', 'GET', '/api/my/today')).data.today_tasks.find((t) => t.task_id === wird.id);
  assert.equal(item.submission.count, 150); assert.equal(item.status, 'on_time'); assert.equal(item.action, 'edit');
  assert.ok(!/[<>]/.test(item.submission.note), 'تنقية الملاحظة');
  assert.equal((await send(7, { date: '2999-01-01' })).status, 400, 'لا تسجيل لأيام لم تأتِ بعد');
  // حذف الورد لا يتم بعد وجود تسجيلات
  assert.equal((await api('admin', 'DELETE', `/api/admin/tasks/${wird.id}`)).status, 400);
});

test('الإدارة: المؤشرات والمتابعة والتذكير والتقارير والتصدير', async () => {
  const d = (await api('admin', 'GET', '/api/admin/dashboard')).data;
  assert.equal(d.day.on_time, 1);
  const w = d.tasks.find((t) => t.task_id === wird.id);
  assert.equal(w.count_sum, 150); assert.equal(w.target_count, 100);
  const tr = (await api('admin', 'GET', `/api/admin/tracking?task_id=${wird.id}`)).data;
  assert.equal(tr.rows.length, 1); assert.equal(tr.rows[0].count, 150);
  const sub = (await api('admin', 'GET', `/api/admin/submissions/${tr.rows[0].submission_id}`)).data.submission;
  assert.equal(sub.count, 150); assert.equal(sub.user_name, 'أحمد');
  assert.equal((await api('admin', 'POST', '/api/admin/reminders', { task_id: wird.id, date: tr.rows[0].date })).status, 200);
  const rep = (await api('admin', 'GET', '/api/admin/reports/summary')).data;
  assert.equal(rep.tasks[0].count_unit, 'مرة');
  const x = await fetch(base + '/api/admin/reports/export', { headers: { cookie: jars.admin } });
  assert.equal(x.status, 200); assert.match(x.headers.get('content-type'), /spreadsheetml/);
});

test('الحالات: الأيام الماضية بلا تسجيل = لم يُسجَّل، والعضو الجديد لا يُحاسَب على ما قبل انضمامه', async () => {
  const { db } = await import('../server/db.js');
  const q = `/api/admin/tracking?task_id=${wird.id}&from=2020-01-05&to=2020-01-07`;
  assert.equal((await api('admin', 'GET', q)).data.rows.length, 0, 'U1 انضم اليوم');
  db.prepare('UPDATE user_groups SET joined_at = 0').run();
  const tr = (await api('admin', 'GET', q)).data;
  assert.equal(tr.rows.length, 3); assert.ok(tr.rows.every((r) => r.status === 'missed'));
  assert.equal(tr.summary.compliance, 0);
});

test('الأيام المحددة والإيقاف المؤقت: لا استحقاق في أيام غير مختارة ولا في فترة الإيقاف', async () => {
  const fri = await api('admin', 'POST', '/api/admin/tasks', { title: 'سورة الكهف', count_unit: 'مرة', days_of_week: [5], start_date: '2020-01-01', assign: { all: true } });
  assert.equal(fri.status, 201);
  const tid = fri.data.task.id;
  (await import('../server/db.js')).db.prepare('UPDATE users SET created_at = 0').run();
  // 2020-01-03 و10 و17 جمعات
  const rows = (await api('admin', 'GET', `/api/admin/tracking?task_id=${tid}&from=2020-01-01&to=2020-01-20`)).data.rows;
  assert.deepEqual([...new Set(rows.map((r) => r.date))], ['2020-01-17', '2020-01-10', '2020-01-03']);
  assert.equal((await api('admin', 'POST', `/api/admin/tasks/${tid}/pause`)).data.task.status, 'paused');
  const { localDate } = await import('../server/util/time.js');
  const after = (await api('admin', 'GET', `/api/admin/tracking?task_id=${tid}&from=${localDate()}&to=${localDate()}`)).data.rows;
  assert.equal(after.length, 0, 'لا استحقاق أثناء الإيقاف');
  assert.equal((await api('admin', 'POST', `/api/admin/tasks/${tid}/resume`)).data.task.status, 'active');
  assert.equal((await api('admin', 'POST', `/api/admin/tasks/${tid}/archive`)).data.task.status, 'archived');
});

test('لا تسجيل لاحق: الأيام الماضية إمّا سُجّلت في وقتها أو «لم تُسجَّل»', async () => {
  const { addDays, localDate } = await import('../server/util/time.js');
  const today = localDate();
  const { db } = await import('../server/db.js');
  db.prepare('UPDATE tasks SET start_date=? WHERE id=?').run(addDays(today, -40), wird.id);
  db.prepare('UPDATE user_groups SET joined_at = 0').run();
  const send = (date, c) => api('u1', 'POST', '/api/my/submit', { task_id: wird.id, date, count: c });
  const r = await send(addDays(today, -1), 30);
  assert.equal(r.status, 400); assert.match(r.data.error, /انتهى وقت هذا اليوم/);
  assert.equal((await send(addDays(today, -20), 5)).status, 400);
  const h = (await api('u1', 'GET', '/api/my/history')).data.items;
  assert.ok(h.length > 0 && h.every((x) => ['on_time', 'missed'].includes(x.status)), 'حالتان فقط');
  assert.ok(h.filter((x) => x.date < today).every((x) => x.action === null), 'لا إجراء على الأيام الماضية');
  assert.equal((await api('u1', 'GET', '/api/my/today')).data.overdue, undefined);
  assert.equal((await api('admin', 'PUT', '/api/admin/settings', { late_submit_days: 7 })).status, 404, 'لا إعداد للتسجيل اللاحق');
  // التسجيلات القديمة المتأخرة تُعامل كأنها في وقتها
  db.prepare('UPDATE submissions SET is_late = 1 WHERE task_id = ?').run(wird.id);
  const { statusOf } = await import('../server/services/schedule.js');
  assert.equal(statusOf({ sub: { is_late: 1 }, nowMs: 0, occ: {} }), 'on_time');
});

test('المشرف يرى أعضاء حلقته فقط', async () => {
  const sup = (await api('admin', 'POST', '/api/admin/users', { name: 'مشرف', phone: '95555555', role: 'supervisor' })).data.user;
  const other = (await api('admin', 'POST', '/api/admin/users', { name: 'غريب', phone: '96666666' })).data.user;
  await api('admin', 'POST', '/api/admin/groups', { name: 'حلقة المشرف', supervisor_id: sup.id, user_ids: [U2.id] });
  const { db } = await import('../server/db.js');
  db.prepare('UPDATE user_groups SET joined_at = 0').run(); db.prepare('UPDATE users SET created_at = 0').run();
  await login('sup', '95555555');
  assert.deepEqual((await api('sup', 'GET', '/api/admin/users')).data.users.map((u) => u.id), [U2.id]);
  const tr = (await api('sup', 'GET', '/api/admin/tracking?from=2020-01-01&to=2020-01-07')).data;
  assert.ok(tr.rows.length > 0 && tr.rows.every((r) => r.user_id === U2.id), 'تتبّع الحلقة فقط');
  assert.equal((await api('sup', 'POST', '/api/admin/users', { name: 'x', phone: '97777777' })).status, 403);
  assert.equal((await api('sup', 'POST', '/api/admin/tasks', {})).status, 403);
  assert.equal((await api('sup', 'POST', '/api/admin/reminders', { task_id: wird.id, date: '2020-01-05', user_ids: [other.id] })).status, 200);
});

test('الإحصاءات: مخطط لكل ورد مع الأعداد والهدف والتتابع', async () => {
  const st = (await api('u1', 'GET', '/api/my/stats?days=14')).data;
  assert.equal(st.days, 14);
  const t = st.tasks.find((x) => x.task_id === wird.id);
  assert.ok(t && t.count_unit === 'مرة' && t.target_count === 100);
  assert.ok(t.points.some((p) => p.value === 150), 'قيمة اليوم المحفوظة');
  assert.ok(t.points.some((p) => p.value === 0 && p.status === 'missed'), 'الأيام غير المسجّلة صفر');
  assert.equal(t.summary.total, 150);
  assert.equal(t.summary.goal_days, 1, 'أيام بلوغ الهدف');
  assert.equal((await api('anon', 'GET', '/api/my/stats')).status, 401);
  assert.equal((await api('u1', 'GET', '/api/my/stats?days=99999')).data.days, 180);
});


test('PIN: تعيين ودخول وقفل بعد محاولات خاطئة', async () => {
  assert.equal((await api('u2', 'POST', '/api/auth/pin', { pin: '4321' })).status, 200);
  const ok = await api('pin', 'POST', '/api/auth/login-pin', { phone: '93333333', pin: '4321' });
  assert.equal(ok.status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await api('pin2', 'POST', '/api/auth/login-pin', { phone: '93333333', pin: 'bad!' })).status, 401);
  assert.equal((await api('pin2', 'POST', '/api/auth/login-pin', { phone: '93333333', pin: '4321' })).status, 429);
});

test('تسجيل الخروج من كل الأجهزة + تغيير الرقم بتحقق', async () => {
  await login('u1b', '92222222');
  assert.equal((await api('u1', 'POST', '/api/auth/logout-all')).status, 200);
  assert.equal((await api('u1b', 'GET', '/api/my/today')).status, 401);
  await login('u1', '92222222');
  const rq = await api('u1', 'POST', '/api/auth/change-phone/request', { phone: '94444444' });
  assert.equal(rq.status, 200);
  const cf = await api('u1', 'POST', '/api/auth/change-phone/confirm', { phone: '94444444', code: rq.data.dev_code });
  assert.equal(cf.status, 200);
  assert.equal((await api('u1', 'GET', '/api/auth/me')).data.user.phone, '+96894444444');
});

let U1, U2, G, wird;

// ======================= المجتمع — المرحلة الأولى =======================
let CU, CU2, post1;
const form = (o) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.append(k, v); return fd; };

test('المجتمع: كتابة موضوع تتطلب قبول القواعد ثم يصل للمراجعة دون أن يراه غير الكاتب', async () => {
  CU = (await api('admin', 'POST', '/api/admin/users', { name: 'كاتب', phone: '97010001' })).data.user;
  CU2 = (await api('admin', 'POST', '/api/admin/users', { name: 'قارئ', phone: '97010002' })).data.user;
  await login('cu', '97010001'); await login('cu2', '97010002');
  const cfg = (await api('cu', 'GET', '/api/community/config')).data;
  assert.equal(cfg.terms_accepted, false);
  assert.ok(cfg.categories.length >= 3);
  const cat = cfg.categories[0].id;
  const denied = await api('cu', 'POST', '/api/community/posts', form({ title: 'موضوع تجريبي', body: 'محتوى الموضوع كامل هنا', category_id: cat, submit: '1' }), true);
  assert.equal(denied.status, 403); assert.equal(denied.data.code, 'terms');
  await api('cu', 'POST', '/api/community/accept-terms', {});
  const bodyXss = 'نص <script>alert(1)</script> عادي <b>غامق</b> وبقية الكلام';
  const r1 = await api('cu', 'POST', '/api/community/posts', form({ title: '<img src=x onerror=alert(1)>عنوان', body: bodyXss, category_id: cat, submit: '1' }), true);
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  post1 = r1.data.post;
  assert.equal(post1.status, 'pending');
  assert.ok(!/[<>]/.test(post1.title + post1.body), 'تُنقّى الوسوم');
  assert.equal(post1.title, 'عنوان');
  // لا يراه غيره
  assert.equal((await api('cu2', 'GET', `/api/community/posts/${post1.id}`)).status, 404);
  assert.equal((await api('cu2', 'GET', '/api/community/posts')).data.total, 0);
  assert.equal((await api('cu', 'GET', '/api/community/mine')).data.posts.length, 1);
  assert.equal((await api('cu2', 'GET', '/api/community/admin/posts')).status, 403, 'غير مراجع');
});

test('المجتمع: إشعار للإدارة، ثم نشر يصل إشعاره للكاتب ويظهر للجميع', async () => {
  const sum = (await api('admin', 'GET', '/api/notifications/summary')).data;
  assert.ok(sum.unread >= 1 && sum.pending_review >= 1);
  const list = (await api('admin', 'GET', '/api/notifications')).data.notifications;
  assert.ok(list.some((n) => n.type === 'post_pending'));
  const pend = (await api('admin', 'GET', '/api/community/admin/posts?status=pending')).data;
  assert.equal(pend.total, 1);
  assert.equal(pend.posts[0].author.name, 'كاتب');
  assert.equal(pend.posts[0].author.phone, undefined, 'لا أرقام هواتف');
  const pub = await api('admin', 'POST', `/api/community/admin/posts/${post1.id}/publish`, {});
  assert.equal(pub.status, 200);
  assert.equal(pub.data.post.status, 'published');
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${post1.id}/publish`, {})).status, 409, 'انتقال غير صحيح');
  const mine = (await api('cu', 'GET', '/api/notifications')).data.notifications;
  assert.ok(mine.some((n) => n.type === 'post_published'));
  const feed = (await api('cu2', 'GET', '/api/community/posts')).data;
  assert.equal(feed.total, 1);
  assert.equal(feed.posts[0].author.phone, undefined);
  await api('cu', 'POST', '/api/notifications/read', { all: true });
  assert.equal((await api('cu', 'GET', '/api/notifications/summary')).data.unread, 0);
});

test('المجتمع: إعادة للتعديل برفض بلا ملاحظات، ثم تعديل وإرسال، ثم رفض', async () => {
  const cat = (await api('cu', 'GET', '/api/community/config')).data.categories[0].id;
  const c = (await api('cu', 'POST', '/api/community/posts', form({ title: 'موضوع ثانٍ', body: 'نص الموضوع الثاني الكافي', category_id: cat, submit: '1' }), true)).data.post;
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${c.id}/return`, { note: '' })).status, 400, 'الملاحظات مطلوبة');
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${c.id}/return`, { note: 'أضف مصدراً' })).status, 200);
  const mine = (await api('cu', 'GET', '/api/community/mine')).data.posts.find((p) => p.id === c.id);
  assert.equal(mine.status, 'needs_edit'); assert.equal(mine.decision_note, 'أضف مصدراً');
  const edit = await api('cu', 'PUT', `/api/community/posts/${c.id}`, form({ title: 'موضوع ثانٍ معدّل', body: 'نص معدّل مع المصدر المطلوب', category_id: cat, submit: '1' }), true);
  assert.equal(edit.status, 200); assert.equal(edit.data.post.status, 'pending');
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${c.id}/reject`, { note: 'غير مناسب' })).status, 200);
  assert.ok((await api('cu', 'GET', '/api/notifications')).data.notifications.some((n) => n.type === 'post_rejected' && n.body.includes('غير مناسب')));
  // المستخدم لا يستطيع نشر موضوعه بنفسه
  assert.equal((await api('cu', 'POST', `/api/community/admin/posts/${c.id}/publish`, {})).status, 403);
  // الحد اليومي
  const { db } = await import('../server/db.js');
  const { setCS } = await import('../server/services/community.js');
  setCS('daily_limit', 2);
  const over = await api('cu', 'POST', '/api/community/posts', form({ title: 'موضوع ثالث', body: 'نص الموضوع الثالث الكافي', category_id: cat, submit: '1' }), true);
  assert.equal(over.status, 429);
  assert.ok(over.data.saved_as_draft, 'يُحفظ مسودة عند بلوغ الحد');
  setCS('daily_limit', 3);
  void db;
});

// ======================= المجتمع — المرحلة الثانية =======================
test('المجتمع: تفاعل واحد لكل مستخدم يتغيّر ويُزال، وإيموجي غير متاح يُرفض', async () => {
  const react = (who, emoji) => api(who, 'PUT', `/api/community/posts/${post1.id}/reaction`, { emoji });
  const a = await react('cu2', '👍');
  assert.equal(a.status, 200); assert.deepEqual(a.data.reactions, { '👍': 1 }); assert.equal(a.data.my_reaction, '👍');
  const b = await react('cu2', '❤️');
  assert.deepEqual(b.data.reactions, { '❤️': 1 }, 'تغيير التفاعل لا يضاعفه');
  assert.deepEqual((await react('cu', '❤️')).data.reactions, { '❤️': 2 });
  assert.equal((await react('cu2', '🤖')).status, 400);
  const off = await react('cu2', '❤️'); // نفس الإيموجي = إزالة
  assert.deepEqual(off.data.reactions, { '❤️': 1 }); assert.equal(off.data.my_reaction, null);
  assert.equal((await api('cu2', 'PUT', `/api/community/posts/${post1.id}/reaction`, { emoji: null })).status, 200);
  const { db } = await import('../server/db.js');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM post_reactions WHERE post_id=? AND user_id=?').get(post1.id, CU2.id).c, 0);
  // موضوع غير منشور لا يُتفاعل معه
  const cat = (await api('cu', 'GET', '/api/community/config')).data.categories[0].id;
  const pend = (await api('cu', 'POST', '/api/community/posts', form({ title: 'قيد المراجعة', body: 'نص كافٍ للموضوع', category_id: cat, submit: '1' }), true)).data.post;
  assert.equal((await api('cu2', 'PUT', `/api/community/posts/${pend.id}/reaction`, { emoji: '👍' })).status, 404);
  // الإدارة ترى من تفاعل، والمستخدم لا
  const who = await api('admin', 'GET', `/api/community/admin/posts/${post1.id}/reactions`);
  assert.deepEqual(who.data.reactions['❤️'].map((u) => u.name), ['كاتب']);
  assert.equal((await api('cu2', 'GET', `/api/community/admin/posts/${post1.id}/reactions`)).status, 403);
  // الفيد يعرض العدّادات وتفاعل المستخدم
  const feed = (await api('cu', 'GET', '/api/community/posts')).data.posts[0];
  assert.equal(feed.my_reaction, '❤️'); assert.equal(feed.total_reactions, 1);
  await api('admin', 'POST', `/api/community/admin/posts/${pend.id}/reject`, { note: '' });
});

test('المجتمع: البحث والتصنيف والترقيم', async () => {
  const cats = (await api('cu', 'GET', '/api/community/config')).data.categories;
  const mk = async (t, cat) => { const p = (await api('cu', 'POST', '/api/community/posts', form({ title: t, body: 'محتوى كافٍ لهذا الموضوع التجريبي', category_id: cat, submit: '1' }), true)).data.post; await api('admin', 'POST', `/api/community/admin/posts/${p.id}/publish`, {}); };
  const { setCS } = await import('../server/services/community.js');
  setCS('daily_limit', 50);
  await mk('أسرار الصباح', cats[1].id); await mk('رحلة الأسبوع', cats[2].id); await mk('100% نجاح_ممتاز', cats[1].id);
  const all = (await api('cu2', 'GET', '/api/community/posts?limit=2')).data;
  assert.equal(all.total, 4); assert.equal(all.pages, 2); assert.equal(all.posts.length, 2);
  assert.equal((await api('cu2', 'GET', `/api/community/posts?category=${cats[1].id}`)).data.total, 2);
  assert.equal((await api('cu2', 'GET', '/api/community/posts?q=' + encodeURIComponent('الصباح'))).data.total, 1);
  assert.equal((await api('cu2', 'GET', '/api/community/posts?q=' + encodeURIComponent('%'))).data.total, 1, 'الرمز % يُعامل كنص عادي');
  assert.equal((await api('cu2', 'GET', '/api/community/posts?q=' + encodeURIComponent('_'))).data.total, 1);
  setCS('daily_limit', 3);
});

// ======================= المجتمع — المرحلة الثالثة =======================
test('المجتمع: البلاغات والتثبيت والأرشفة وطلب الحذف والتدقيق', async () => {
  const feed0 = (await api('cu2', 'GET', '/api/community/posts?limit=30')).data.posts;
  const target = feed0.find((p) => p.title === 'رحلة الأسبوع');
  assert.equal((await api('cu', 'POST', `/api/community/posts/${post1.id}/report`, { reason: 'x' })).status, 400, 'لا تبلغ عن موضوعك');
  assert.equal((await api('cu2', 'POST', `/api/community/posts/${target.id}/report`, { reason: 'محتوى مسيء' })).status, 201);
  assert.equal((await api('cu2', 'POST', `/api/community/posts/${target.id}/report`, {})).status, 409, 'بلاغ واحد لكل مستخدم');
  assert.ok((await api('admin', 'GET', '/api/notifications')).data.notifications.some((n) => n.type === 'post_report'));
  const reps = (await api('admin', 'GET', '/api/community/admin/reports')).data.posts;
  assert.equal(reps.length, 1); assert.equal(reps[0].reports[0].reason, 'محتوى مسيء'); assert.equal(reps[0].reports[0].reporter, 'قارئ');
  assert.equal((await api('admin', 'GET', '/api/community/admin/counts')).data.counts.reports, 1);
  assert.equal((await api('cu', 'GET', '/api/community/admin/reports')).status, 403);
  await api('admin', 'POST', `/api/community/admin/posts/${target.id}/reports/resolve`, { action: 'dismissed' });
  assert.equal((await api('admin', 'GET', '/api/community/admin/reports')).data.posts.length, 0);

  // تثبيت: يظهر أولاً، ويزول عند الأرشفة
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${target.id}/pin`, {})).status, 200);
  const f1 = (await api('cu2', 'GET', '/api/community/posts?limit=30')).data.posts;
  assert.equal(f1[0].id, target.id); assert.equal(f1[0].pinned, true);
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${target.id}/archive`, {})).status, 200);
  assert.ok(!(await api('cu2', 'GET', '/api/community/posts?limit=30')).data.posts.some((p) => p.id === target.id), 'المؤرشف يختفي');
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${target.id}/pin`, {})).status, 409, 'لا تثبيت لغير المنشور');
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${target.id}/restore`, {})).status, 200);
  assert.equal((await api('admin', 'GET', '/api/community/admin/posts?status=published')).data.posts.find((p) => p.id === target.id).pinned, false, 'التثبيت يُلغى بالأرشفة');

  // تعديل منشور يعيده للمراجعة، وطلب الحذف يصل للإدارة
  const cat = (await api('cu', 'GET', '/api/community/config')).data.categories[0].id;
  const ed = await api('cu', 'PUT', `/api/community/posts/${post1.id}`, form({ title: 'عنوان بعد التعديل', body: 'محتوى معدّل للموضوع المنشور سابقاً', category_id: cat }), true);
  assert.equal(ed.status, 200); assert.equal(ed.data.post.status, 'pending', 'تعديل المنشور يعيده للمراجعة');
  assert.ok(!(await api('cu2', 'GET', '/api/community/posts?limit=30')).data.posts.some((p) => p.id === post1.id));
  await api('admin', 'POST', `/api/community/admin/posts/${post1.id}/publish`, {});
  assert.equal((await api('cu', 'DELETE', `/api/community/posts/${post1.id}`)).status, 409, 'المنشور لا يُحذف من صاحبه');
  assert.equal((await api('cu', 'POST', `/api/community/posts/${post1.id}/request-delete`, {})).status, 200);
  assert.equal((await api('cu', 'POST', `/api/community/posts/${post1.id}/request-delete`, {})).status, 409);
  assert.ok((await api('admin', 'GET', '/api/notifications')).data.notifications.some((n) => n.type === 'delete_request'));
  assert.equal((await api('admin', 'GET', '/api/community/admin/posts?status=published')).data.posts.find((p) => p.id === post1.id).delete_requested, true);
  assert.equal((await api('admin', 'POST', `/api/community/admin/posts/${post1.id}/delete`, {})).status, 200);
  assert.equal((await api('cu', 'GET', `/api/community/posts/${post1.id}`)).status, 404);

  // سجل التدقيق يحوي القرارات
  const log = (await api('admin', 'GET', '/api/community/admin/audit')).data.entries.map((x) => x.action);
  for (const a of ['community.publish', 'community.reject', 'community.return', 'community.pin', 'community.archive', 'community.delete']) assert.ok(log.includes(a), `سجل ${a}`);
  assert.equal((await api('cu', 'GET', '/api/community/admin/audit')).status, 403);
  const st = (await api('admin', 'GET', '/api/community/admin/stats')).data;
  assert.ok(st.published >= 3 && st.top_authors[0].name === 'كاتب');
});

test('المجتمع: الحظر والإعدادات والنشر التلقائي والتصنيفات', async () => {
  (await import('../server/services/community.js')).setCS('daily_limit', 50);
  const cats = (await api('cu', 'GET', '/api/community/config')).data.categories;
  // حظر الكتابة مع بقاء التفاعل
  assert.equal((await api('admin', 'PUT', `/api/community/admin/bans/${CU.id}`, { post_banned: true, reason: 'مخالفة' })).status, 200);
  assert.equal((await api('cu', 'POST', '/api/community/posts', form({ title: 'ممنوع', body: 'محتوى كافٍ للتجربة هنا', category_id: cats[0].id }), true)).status, 403);
  assert.equal((await api('cu', 'GET', '/api/community/config')).data.can_post, false);
  assert.ok((await api('cu', 'GET', '/api/notifications')).data.notifications.some((n) => n.type === 'community_ban'));
  const feed = (await api('cu', 'GET', '/api/community/posts')).data.posts;
  assert.equal((await api('cu', 'PUT', `/api/community/posts/${feed[0].id}/reaction`, { emoji: '👍' })).status, 200, 'التفاعل مسموح');
  // حظر التفاعل أيضاً
  await api('admin', 'PUT', `/api/community/admin/bans/${CU.id}`, { post_banned: true, react_banned: true });
  assert.equal((await api('cu', 'PUT', `/api/community/posts/${feed[0].id}/reaction`, { emoji: '❤️' })).status, 403);
  assert.equal((await api('admin', 'GET', '/api/community/admin/bans')).data.bans.length, 1);
  await api('admin', 'DELETE', `/api/community/admin/bans/${CU.id}`);
  assert.equal((await api('admin', 'PUT', `/api/community/admin/bans/${(await api('admin', 'GET', '/api/auth/me')).data.user.id}`, { post_banned: true })).status, 400, 'لا حظر للمدير');

  // الإعدادات: التحقق من الإيموجي والحد
  assert.equal((await api('admin', 'PUT', '/api/community/admin/settings', { emojis: ['👍', '❤️'] })).status, 400, 'من 6 إلى 8');
  assert.equal((await api('admin', 'PUT', '/api/community/admin/settings', { emojis: ['👍', '❤️', '😂', '😮', '🤲', '🤖'] })).status, 400, 'من الكتالوج فقط');
  assert.equal((await api('admin', 'PUT', '/api/community/admin/settings', { daily_limit: 0 })).status, 400);
  assert.equal((await api('admin', 'PUT', '/api/community/admin/settings', { emojis: ['👍', '❤️', '😂', '😮', '🤲', '👏', '🎉', '💡'] })).status, 200);
  assert.equal((await api('cu', 'GET', '/api/community/config')).data.emojis.length, 8);
  assert.equal((await api('cu', 'PUT', '/api/community/admin/settings', {})).status, 403);

  // النشر التلقائي لموثوق فقط
  await api('admin', 'PUT', '/api/community/admin/settings', { auto_publish: { enabled: true, user_ids: [CU.id] } });
  const auto = await api('cu', 'POST', '/api/community/posts', form({ title: 'نشر تلقائي', body: 'محتوى موثوق يُنشر مباشرة', category_id: cats[0].id, submit: '1' }), true);
  assert.equal(auto.data.post.status, 'published');
  const other = await api('cu2', 'POST', '/api/community/posts', form({ title: 'غير موثوق', body: 'محتوى عادي ينتظر المراجعة', category_id: cats[0].id, submit: '1' }), true);
  assert.equal(other.status, 403, 'قبول القواعد أولاً'); await api('cu2', 'POST', '/api/community/accept-terms', {});
  const o2 = await api('cu2', 'POST', '/api/community/posts', form({ title: 'غير موثوق', body: 'محتوى عادي ينتظر المراجعة', category_id: cats[0].id, submit: '1' }), true);
  assert.equal(o2.data.post.status, 'pending');
  await api('admin', 'PUT', '/api/community/admin/settings', { auto_publish: { enabled: false, user_ids: [] } });

  // التصنيفات
  const nc = await api('admin', 'POST', '/api/community/admin/categories', { name: 'تصنيف جديد' });
  assert.equal(nc.status, 201);
  assert.equal((await api('admin', 'POST', '/api/community/admin/categories', { name: 'تصنيف جديد' })).status, 400);
  assert.equal((await api('admin', 'PATCH', `/api/community/admin/categories/${nc.data.id}`, { active: false })).status, 200);
  assert.ok(!(await api('cu', 'GET', '/api/community/config')).data.categories.some((c) => c.id === nc.data.id), 'المعطّل يختفي');
  assert.equal((await api('admin', 'DELETE', `/api/community/admin/categories/${nc.data.id}`)).status, 200);

  // إيقاف الميزة كلها
  await api('admin', 'PUT', '/api/community/admin/settings', { enabled: false });
  assert.equal((await api('cu2', 'GET', '/api/community/posts')).status, 403);
  assert.equal((await api('admin', 'GET', '/api/community/admin/posts')).status, 200, 'الإدارة تعمل');
  await api('admin', 'PUT', '/api/community/admin/settings', { enabled: true });
});

test('المجتمع: المشرف المفوَّض يراجع مجموعته فقط، وإشعارات واتساب والملخص اليومي', async () => {
  const sup = (await api('admin', 'POST', '/api/admin/users', { name: 'مشرف المجتمع', phone: '97010003', role: 'supervisor' })).data.user;
  const g = (await api('admin', 'POST', '/api/admin/groups', { name: 'فريق المجتمع', supervisor_id: sup.id, user_ids: [CU2.id] })).data.group;
  await login('csup', '97010003');
  assert.equal((await api('csup', 'GET', '/api/community/admin/posts')).status, 403, 'غير مفوّض افتراضياً');
  await api('admin', 'PUT', '/api/community/admin/settings', { supervisors_review: true });
  const q = (await api('csup', 'GET', '/api/community/admin/posts?status=pending')).data;
  assert.equal(q.total, 1); assert.equal(q.posts[0].author.name, 'قارئ');
  assert.equal((await api('csup', 'POST', `/api/community/admin/posts/${q.posts[0].id}/archive`, {})).status, 403, 'المدير فقط');
  assert.equal((await api('csup', 'GET', '/api/community/admin/settings')).status, 403);
  // واتساب: طابور يحترم الخيار وساعات الهدوء
  const { db } = await import('../server/db.js');
  const { flushWhatsapp, inQuietHours } = await import('../server/services/notify.js');
  assert.equal(inQuietHours({ quiet_start: '22:00', quiet_end: '07:00' }, Date.parse('2026-10-14T20:00:00Z')), true, '00:00 محلياً داخل الهدوء');
  assert.equal(inQuietHours({ quiet_start: '22:00', quiet_end: '07:00' }, Date.parse('2026-10-14T08:00:00Z')), false, '12:00 محلياً');
  assert.equal(inQuietHours({ quiet_start: null, quiet_end: null }), false);
  const wa = (u) => db.prepare("SELECT wa_status FROM notifications WHERE user_id=? AND type LIKE 'post_%' ORDER BY id DESC LIMIT 1").get(u)?.wa_status;
  const publishFor = async (who, title) => { const cat = (await api(who, 'GET', '/api/community/config')).data.categories[0].id; const p = (await api(who, 'POST', '/api/community/posts', form({ title, body: 'محتوى كافٍ لاختبار الواتساب', category_id: cat, submit: '1' }), true)).data.post; await api('admin', 'POST', `/api/community/admin/posts/${p.id}/publish`, {}); };
  db.prepare("UPDATE users SET quiet_start=NULL, quiet_end=NULL WHERE id=?").run(CU2.id);
  await publishFor('cu2', 'واتساب مفعّل'); await flushWhatsapp();
  assert.equal(wa(CU2.id), 'sent');
  assert.equal((await api('cu2', 'PATCH', '/api/auth/prefs', { wa_notify: false })).status, 200);
  await publishFor('cu2', 'واتساب مُوقَف');
  assert.equal(wa(CU2.id), 'none', 'لا واتساب لمن أوقفه');
  const rowsBefore = db.prepare("SELECT COUNT(*) c FROM notifications WHERE wa_key='review_digest'").get().c;
  db.prepare("DELETE FROM settings WHERE key='community_digest_last'").run();
  db.prepare("UPDATE users SET quiet_start=NULL, quiet_end=NULL WHERE role='admin'").run();
  const { runDigest } = await import('../server/services/notify.js');
  const { setCS } = await import('../server/services/community.js');
  setCS('digest', { enabled: true, time: '00:00' });
  await api('cu2', 'POST', '/api/community/posts', form({ title: 'بانتظار الملخص', body: 'محتوى كافٍ لاختبار الملخص', category_id: (await api('cu2', 'GET', '/api/community/config')).data.categories[0].id, submit: '1' }), true);
  runDigest(); runDigest();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE wa_key='review_digest'").get().c - rowsBefore >= 1, true, 'ملخص للمراجعين');
  const once = db.prepare("SELECT COUNT(*) c FROM notifications WHERE wa_key='review_digest'").get().c;
  runDigest();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE wa_key='review_digest'").get().c, once, 'مرة واحدة يومياً');
  void g;
});

// ======================= المكتبة: التنزيلات المجانية =======================
const pdf = (name = 'أذكار.pdf') => { const b = new Blob(['%PDF-1.4\n%اختبار\n'], { type: 'application/pdf' }); return [b, name]; };
const png = () => [new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], { type: 'image/png' }), 'p.png'];
let FILE_ID, P_DIGITAL, P_PHYSICAL, P_FREE;

test('المكتبة: الإدارة ترفع ملفاً مجانياً والعضو ينزّله، والعداد يزيد', async () => {
  const cats = (await api('admin', 'GET', '/api/library/admin/files')).data.categories;
  assert.ok(cats.length >= 3, 'تصنيفات افتراضية');
  const fd = new FormData();
  fd.append('title', 'أذكار الصباح'); fd.append('description', 'ملف PDF للطباعة'); fd.append('category_id', String(cats[0].id));
  fd.append('file', ...pdf());
  const up = await api('admin', 'POST', '/api/library/admin/files', fd, true);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  FILE_ID = up.data.id;
  // نوع غير مسموح يُرفض
  const bad1 = new FormData(); bad1.append('title', 'سكربت'); bad1.append('file', new Blob(['<script>'], { type: 'text/html' }), 'x.html');
  assert.equal((await api('admin', 'POST', '/api/library/admin/files', bad1, true)).status, 400);
  // امتداد سليم بمحتوى غير مطابق يُرفض
  const bad2 = new FormData(); bad2.append('title', 'مزيف'); bad2.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'f.pdf');
  assert.equal((await api('admin', 'POST', '/api/library/admin/files', bad2, true)).status, 400, 'يُتحقق من توقيع الملف');

  const list = (await api('u1', 'GET', '/api/library/files')).data;
  assert.equal(list.files.length, 1);
  assert.equal(list.files[0].title, 'أذكار الصباح');
  assert.equal(list.files[0].category.name, cats[0].name);
  const dl = await fetch(`${base}/api/library/files/${FILE_ID}/download`, { headers: { cookie: jars.u1 } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  await dl.arrayBuffer();
  assert.equal((await api('u1', 'GET', '/api/library/files')).data.files[0].downloads, 1, 'عدّاد التنزيل');
  assert.equal((await api('anon', 'GET', '/api/library/files')).status, 401, 'يلزم تسجيل الدخول');
  assert.equal((await api('u1', 'GET', '/api/library/admin/files')).status, 403, 'الإدارة للمدير فقط');
  // الإخفاء يمنع ظهوره
  const ed = new FormData(); ed.append('title', 'أذكار الصباح'); ed.append('active', '0');
  assert.equal((await api('admin', 'PUT', `/api/library/admin/files/${FILE_ID}`, ed, true)).status, 200);
  assert.equal((await api('u1', 'GET', '/api/library/files')).data.files.length, 0);
  const ed2 = new FormData(); ed2.append('title', 'أذكار الصباح'); ed2.append('active', '1');
  await api('admin', 'PUT', `/api/library/admin/files/${FILE_ID}`, ed2, true);
});

// ======================= المتجر: المنتجات والطلبات =======================
test('المتجر: إنشاء المنتجات مع التحقق', async () => {
  const mk = async (o, files = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.append(k, String(v));
    if (files.file) fd.append('file', ...files.file);
    if (files.image) fd.append('image', ...files.image);
    return api('admin', 'POST', '/api/library/admin/products', fd, true);
  };
  assert.equal((await mk({ kind: 'digital', title: 'كتاب', price_minor: 1000 })).status, 400, 'الرقمي يلزمه ملف');
  assert.equal((await mk({ kind: 'physical', title: 'سبحة', price_minor: -5 })).status, 400, 'سعر غير صالح');
  assert.equal((await mk({ kind: 'physical', title: 'س', price_minor: 'abc' })).status, 400);
  P_DIGITAL = (await mk({ kind: 'digital', title: 'كتاب الأذكار (PDF)', price_minor: 2500, description: 'نسخة رقمية' }, { file: pdf('كتاب.pdf') })).data.id;
  P_PHYSICAL = (await mk({ kind: 'physical', title: 'سبحة خشبية', price_minor: 3000, stock: 2 }, { image: png() })).data.id;
  P_FREE = (await mk({ kind: 'digital', title: 'بطاقة أدعية مجانية', price_minor: 0 }, { file: pdf('بطاقة.pdf') })).data.id;
  const st = (await api('u1', 'GET', '/api/library/store')).data;
  assert.equal(st.enabled, true);
  assert.equal(st.products.length, 3);
  const dig = st.products.find((p) => p.id === P_DIGITAL);
  assert.equal(dig.price, '2.500 ر.ع');
  assert.equal(st.products.find((p) => p.id === P_FREE).price, 'مجاناً');
  assert.equal(dig.file_name, undefined, 'لا يُكشف اسم ملف المنتج للعضو');
  assert.equal((await api('u1', 'POST', '/api/library/admin/products', new FormData(), true)).status, 403);
});

test('المتجر: طلب رقمي بتحويل بنكي — لا تنزيل قبل تأكيد الدفع', async () => {
  const r = await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_DIGITAL, qty: 3 }], payment_method: 'bank_transfer' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const o = r.data.order;
  assert.equal(o.status, 'new');
  assert.equal(o.items[0].qty, 1, 'المنتج الرقمي نسخة واحدة');
  assert.equal(o.shipping_minor, 0, 'لا شحن للرقمي');
  assert.equal(o.total, '2.500 ر.ع');
  assert.equal(o.items[0].downloadable, false);
  const itemId = o.items[0].id;
  assert.equal((await api('u1', 'GET', `/api/library/orders/${o.id}/items/${itemId}/download`)).status, 403, 'قبل الدفع');
  // الإدارة تُشعر وتؤكد
  assert.ok((await api('admin', 'GET', '/api/notifications')).data.notifications.some((n) => n.type === 'order_new'));
  assert.equal((await api('admin', 'POST', `/api/library/admin/orders/${o.id}/status`, { status: 'shipped' })).status, 409, 'انتقال غير صحيح');
  assert.equal((await api('admin', 'POST', `/api/library/admin/orders/${o.id}/status`, { status: 'paid' })).status, 200);
  const dl = await fetch(`${base}/api/library/orders/${o.id}/items/${itemId}/download`, { headers: { cookie: jars.u1 } });
  assert.equal(dl.status, 200);
  await dl.arrayBuffer();
  assert.ok((await api('u1', 'GET', '/api/notifications')).data.notifications.some((n) => n.type === 'order_paid'));
  // عضو آخر لا يصل لطلب غيره
  assert.equal((await api('u2', 'GET', `/api/library/orders/${o.id}/items/${itemId}/download`)).status, 404);
  assert.equal((await api('u2', 'GET', '/api/library/orders')).data.orders.length, 0);
  // مرجع التحويل لا يُعدَّل بعد التأكيد
  assert.equal((await api('u1', 'POST', `/api/library/orders/${o.id}/payment-ref`, { payment_ref: 'TRX-9' })).status, 409);
  assert.equal((await api('u1', 'POST', `/api/library/orders/${o.id}/cancel`)).status, 409, 'لا إلغاء بعد التأكيد');
});

test('المتجر: طلب مادي — الشحن والمخزون والإلغاء يعيد الكمية', async () => {
  const noAddr = await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_PHYSICAL, qty: 1 }], payment_method: 'cod', ship: { name: 'أحمد', phone: '9222', city: '', address: '' } });
  assert.equal(noAddr.status, 400, 'العنوان مطلوب');
  const ship = { name: 'أحمد', phone: '92222222', city: 'مسقط', address: 'الخوض، سكة 12' };
  const over = await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_PHYSICAL, qty: 5 }], payment_method: 'cod', ship });
  assert.equal(over.status, 400); assert.match(over.data.error, /الكمية المتوفرة/);
  const r = await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_PHYSICAL, qty: 2 }], payment_method: 'cod', ship });
  assert.equal(r.status, 201);
  const o = r.data.order;
  assert.equal(o.subtotal, '6.000 ر.ع'); assert.equal(o.shipping, '1.000 ر.ع'); assert.equal(o.total, '7.000 ر.ع');
  assert.equal(o.ship.city, 'مسقط');
  assert.equal((await api('admin', 'GET', '/api/library/admin/products')).data.products.find((p) => p.id === P_PHYSICAL).stock, 0, 'خُصم من المخزون');
  assert.equal((await api('u1', 'GET', '/api/library/store')).data.products.find((p) => p.id === P_PHYSICAL).in_stock, false);
  assert.equal((await api('u1', 'POST', '/api/library/orders/' + o.id + '/cancel')).status, 200);
  assert.equal((await api('admin', 'GET', '/api/library/admin/products')).data.products.find((p) => p.id === P_PHYSICAL).stock, 2, 'أُعيدت الكمية');
  // الدفع عند الاستلام لا يصلح للرقمي وحده
  assert.equal((await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_DIGITAL, qty: 1 }], payment_method: 'cod' })).status, 400);
});

test('المتجر: المنتج المجاني يُسلَّم فوراً، والمتجر يُغلق من الإعدادات', async () => {
  const r = await api('u2', 'POST', '/api/library/orders', { items: [{ product_id: P_FREE, qty: 1 }], payment_method: 'bank_transfer' });
  assert.equal(r.status, 201);
  assert.equal(r.data.order.status, 'delivered');
  assert.equal(r.data.order.payment_method, 'free');
  assert.equal(r.data.order.items[0].downloadable, true);
  assert.equal((await api('u2', 'GET', `/api/library/orders/${r.data.order.id}/items/${r.data.order.items[0].id}/download`)).status, 200);
  // منتج معطّل لا يُطلب
  const fd = new FormData(); fd.append('kind', 'digital'); fd.append('title', 'كتاب الأذكار (PDF)'); fd.append('price_minor', '2500'); fd.append('active', '0');
  await api('admin', 'PUT', `/api/library/admin/products/${P_DIGITAL}`, fd, true);
  assert.equal((await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_DIGITAL, qty: 1 }], payment_method: 'bank_transfer' })).status, 400);
  const fd2 = new FormData(); fd2.append('kind', 'digital'); fd2.append('title', 'كتاب الأذكار (PDF)'); fd2.append('price_minor', '2500'); fd2.append('active', '1');
  await api('admin', 'PUT', `/api/library/admin/products/${P_DIGITAL}`, fd2, true);
  // إغلاق المتجر
  assert.equal((await api('admin', 'PUT', '/api/library/admin/settings', { enabled: false })).status, 200);
  assert.equal((await api('u1', 'GET', '/api/library/store')).data.enabled, false);
  assert.equal((await api('u1', 'POST', '/api/library/orders', { items: [{ product_id: P_FREE, qty: 1 }], payment_method: 'free' })).status, 403);
  assert.equal((await api('u1', 'GET', '/api/library/files')).status, 200, 'التنزيلات تبقى متاحة');
  await api('admin', 'PUT', '/api/library/admin/settings', { enabled: true });
  // إحصاءات ومنتج مرتبط بطلب لا يُحذف
  const stats = (await api('admin', 'GET', '/api/library/admin/stats')).data;
  assert.ok(stats.revenue_minor >= 2500 && stats.downloads >= 1);
  assert.equal((await api('admin', 'DELETE', `/api/library/admin/products/${P_DIGITAL}`)).status, 409);
});

test('إدارة المكتبة: تعديل سريع للسعر والمخزون والإظهار، وحذف الملفات', async () => {
  // السعر
  const up = await api('admin', 'PATCH', `/api/library/admin/products/${P_PHYSICAL}`, { price_minor: 4500 });
  assert.equal(up.status, 200); assert.equal(up.data.product.price, '4.500 ر.ع');
  assert.equal((await api('u1', 'GET', '/api/library/store')).data.products.find((p) => p.id === P_PHYSICAL).price, '4.500 ر.ع', 'يظهر للعضو فوراً');
  for (const v of [-1, 1.5, 'abc']) assert.equal((await api('admin', 'PATCH', `/api/library/admin/products/${P_PHYSICAL}`, { price_minor: v })).status, 400);
  // المخزون
  assert.equal((await api('admin', 'PATCH', `/api/library/admin/products/${P_PHYSICAL}`, { stock: 7 })).data.product.stock, 7);
  assert.equal((await api('admin', 'PATCH', `/api/library/admin/products/${P_PHYSICAL}`, { stock: null })).data.product.stock, null, 'كمية غير محدودة');
  assert.equal((await api('admin', 'PATCH', `/api/library/admin/products/${P_DIGITAL}`, { stock: 5 })).status, 400, 'لا مخزون للرقمي');
  // الإظهار
  await api('admin', 'PATCH', `/api/library/admin/products/${P_PHYSICAL}`, { active: false });
  assert.ok(!(await api('u1', 'GET', '/api/library/store')).data.products.some((p) => p.id === P_PHYSICAL), 'اختفى من المتجر');
  await api('admin', 'PATCH', `/api/library/admin/products/${P_PHYSICAL}`, { active: true });
  // الملفات: إظهار وإخفاء ثم حذف
  assert.equal((await api('admin', 'PATCH', `/api/library/admin/files/${FILE_ID}`, { active: false })).status, 200);
  assert.equal((await api('u1', 'GET', '/api/library/files')).data.files.length, 0);
  await api('admin', 'PATCH', `/api/library/admin/files/${FILE_ID}`, { active: true, title: 'أذكار الصباح والمساء' });
  assert.equal((await api('u1', 'GET', '/api/library/files')).data.files[0].title, 'أذكار الصباح والمساء');
  assert.equal((await api('u1', 'PATCH', `/api/library/admin/files/${FILE_ID}`, { active: false })).status, 403, 'للمدير فقط');
  assert.equal((await api('admin', 'DELETE', `/api/library/admin/files/${FILE_ID}`)).status, 200);
  assert.equal((await api('u1', 'GET', '/api/library/files')).data.files.length, 0, 'حُذف من المكتبة');
  assert.equal((await api('u1', 'GET', `/api/library/files/${FILE_ID}/download`)).status, 404);
});

// ======================= لوحة العضو: الرسالة والسلسلة والتقدّم =======================
test('لوحة العضو: رسالة اليوم من الإدارة، وأنواع البطاقات، والتقدّم', async () => {
  const { localDate } = await import('../server/util/time.js');
  const today = localDate();
  // ورد بزر إتمام (الهدف 1) وآخر بالصفحات
  const mk = (o) => api('admin', 'POST', '/api/admin/tasks', { count_unit: 'مرة', start_date: '2020-01-01', assign: { all: true }, ...o });
  const check = (await mk({ title: 'أذكار الصباح', target_count: 1, sort: 1, link_url: 'https://example.com/adhkar' })).data.task;
  const pages = (await mk({ title: 'ورد القرآن', count_unit: 'صفحة', target_count: 5, sort: 2 })).data.task;
  assert.equal((await mk({ title: 'رابط خاطئ', target_count: 1, link_url: 'javascript:alert(1)' })).status, 400, 'يُرفض الرابط غير الآمن');

  const t1 = (await api('u2', 'GET', '/api/my/today')).data;
  assert.equal(t1.user.name, 'سالم');
  assert.ok(t1.message && t1.message.text.length > 5, 'رسالة اليوم تظهر');
  const c = t1.today_tasks.find((x) => x.task_id === check.id);
  const pg = t1.today_tasks.find((x) => x.task_id === pages.id);
  assert.equal(c.ui, 'check'); assert.equal(c.link_url, 'https://example.com/adhkar');
  assert.equal(pg.ui, 'pages'); assert.equal(pg.mushaf.next_page, 1); assert.equal(pg.mushaf.khatmat, 0);
  assert.ok(t1.today_tasks[0].sort <= t1.today_tasks[1].sort, 'الترتيب بحسب sort');

  // التقدّم بوزن متساوٍ: إتمام ورد من أصل العدد
  const before = t1.progress.percent;
  await api('u2', 'POST', '/api/my/submit', { task_id: check.id, date: today, count: 1 });
  const t2 = (await api('u2', 'GET', '/api/my/today')).data;
  assert.ok(t2.progress.percent > before, 'النسبة ترتفع');
  assert.equal(t2.progress.done, t1.progress.done + 1);
  // صفحات القرآن تُراكم وتُحدِّث الموضع
  await api('u2', 'POST', '/api/my/submit', { task_id: pages.id, date: today, count: 10 });
  const pg2 = (await api('u2', 'GET', '/api/my/today')).data.today_tasks.find((x) => x.task_id === pages.id);
  assert.equal(pg2.mushaf.next_page, 11);
  assert.equal(pg2.mushaf.juz, 1);
  assert.equal(pg2.mushaf.to_next_khatmah, 594);
  // الإحصاءات: خريطة ومجاميع
  const st = (await api('u2', 'GET', '/api/my/stats?days=30')).data;
  assert.ok(Array.isArray(st.heatmap) && st.heatmap.length > 0);
  assert.ok(st.heatmap.every((d) => d.percent >= 0 && d.percent <= 100));
  assert.ok(st.cumulative.some((x) => x.title === 'ورد القرآن' && x.total === 10 && x.mushaf.next_page === 11));
  assert.equal(typeof st.streak, 'number');
});

test('رسالة اليوم: تدوير يومي، ورسالة ليوم محدد لها الأولوية، وللمدير وحده التعديل', async () => {
  const { localDate, addDays } = await import('../server/util/time.js');
  const today = localDate();
  const rotating = (await api('u2', 'GET', '/api/my/today')).data.message;
  const add = await api('admin', 'POST', '/api/admin/messages', { text: 'رسالة اليوم المخصصة لهذا التاريخ', source: 'الإدارة', show_date: today });
  assert.equal(add.status, 201);
  const now2 = (await api('u2', 'GET', '/api/my/today')).data.message;
  assert.equal(now2.text, 'رسالة اليوم المخصصة لهذا التاريخ', 'رسالة التاريخ لها الأولوية');
  assert.notEqual(now2.text, rotating.text);
  // لا رسالتان فعّالتان لنفس اليوم
  assert.equal((await api('admin', 'POST', '/api/admin/messages', { text: 'رسالة أخرى لنفس اليوم', show_date: today })).status, 400);
  assert.equal((await api('admin', 'POST', '/api/admin/messages', { text: 'آية' })).status, 400, 'نص قصير');
  assert.equal((await api('admin', 'POST', '/api/admin/messages', { text: 'رسالة الغد الطيبة', show_date: addDays(today, 1) })).status, 201);
  // تعطيلها يعيد التدوير
  assert.equal((await api('admin', 'PATCH', `/api/admin/messages/${add.data.id}`, { active: false })).status, 200);
  assert.equal((await api('u2', 'GET', '/api/my/today')).data.message.text, rotating.text, 'عاد التدوير');
  // الصلاحيات
  assert.equal((await api('u2', 'GET', '/api/admin/messages')).status, 403);
  assert.equal((await api('sup', 'GET', '/api/admin/messages')).status, 200, 'المشرف يطّلع');
  assert.equal((await api('sup', 'POST', '/api/admin/messages', { text: 'محاولة من مشرف' })).status, 403, 'لا يعدّل');
  assert.equal((await api('admin', 'DELETE', `/api/admin/messages/${add.data.id}`)).status, 200);
});

test('السلسلة ووقت التذكير المفضل', async () => {
  const { db } = await import('../server/db.js');
  const { streakOf } = await import('../server/services/progress.js');
  const { localDate, addDays, localToMs } = await import('../server/util/time.js');
  const today = localDate();
  // عضو جديد بورد واحد، نسجّل له 3 أيام متتالية سابقة
  const u = (await api('admin', 'POST', '/api/admin/users', { name: 'مواظب', phone: '98010001' })).data.user;
  const t = (await api('admin', 'POST', '/api/admin/tasks', { title: 'ورد السلسلة', count_unit: 'مرة', target_count: 1, start_date: addDays(today, -10), assign: { user_ids: [u.id] } })).data.task;
  db.prepare('UPDATE users SET created_at = 0 WHERE id = ?').run(u.id);
  db.prepare('UPDATE task_assignees SET created_at = 0 WHERE task_id = ?').run(t.id);
  // السلسلة تعني إتمام كل أوراد اليوم، فنُسجّل كل ما هو مسند إليه
  const { computeRows } = await import('../server/services/schedule.js');
  const fill = (date) => {
    for (const row of computeRows({ from: date, to: date, userIds: [u.id] })) {
      db.prepare('INSERT OR IGNORE INTO submissions(task_id,user_id,occ_date,count,submitted_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(row.task_id, u.id, date, row.target_count || 1, localToMs(date, '10:00'), localToMs(date, '10:00'));
    }
  };
  for (const d of [3, 2, 1]) fill(addDays(today, -d));
  assert.equal(streakOf(u.id, today), 3, 'ثلاثة أيام متتالية حتى أمس');
  fill(today);
  assert.equal(streakOf(u.id, today), 4, 'يُضاف اليوم عند إتمامه');
  db.prepare('DELETE FROM submissions WHERE user_id=? AND occ_date=?').run(u.id, addDays(today, -2));
  assert.equal(streakOf(u.id, today), 2, 'ينقطع عند يوم فائت');
  void t;
  // وقت التذكير المفضل
  await login('streak', '98010001');
  assert.equal((await api('streak', 'PATCH', '/api/auth/prefs', { reminder_time: '20:30' })).data.prefs.reminder_time, '20:30');
  assert.equal((await api('streak', 'PATCH', '/api/auth/prefs', { reminder_time: 'لاحقاً' })).status, 400);
  assert.equal((await api('streak', 'GET', '/api/auth/me')).data.user.prefs.reminder_time, '20:30');
  assert.equal((await api('streak', 'PATCH', '/api/auth/prefs', { reminder_time: null })).data.prefs.reminder_time, null);
});

// ======================= المكتبة الرقمية: الأغلفة والمعاينة والتمييز =======================
test('المكتبة: غلاف وشارة مميّز ومعاينة لا تُحتسب تنزيلاً', async () => {
  const cats = (await api('admin', 'GET', '/api/library/admin/files')).data.categories;
  const mk = (o, files) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.append(k, String(v));
    for (const [k, v] of Object.entries(files || {})) fd.append(k, ...v);
    return api('admin', 'POST', '/api/library/admin/files', fd, true);
  };
  const a = await mk({ title: 'كتيب التدبر', description: 'كتيب مختصر', category_id: cats[1].id, meta_label: '32 صفحة', featured: '1' },
    { file: pdf('كتيب.pdf'), cover: png() });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const audio = await mk({ title: 'تسجيل الأذكار', category_id: cats[3].id, meta_label: '14 دقيقة' },
    { file: [new Blob([new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0])], { type: 'audio/mpeg' }), 'a.mp3'] });
  assert.equal(audio.status, 201);
  // غلاف بغير صورة يُرفض
  const badCover = await mk({ title: 'غلاف خاطئ' }, { file: pdf('x.pdf'), cover: [new Blob(['%PDF-1.4\n'], { type: 'application/pdf' }), 'c.pdf'] });
  assert.equal(badCover.status, 400);

  const d = (await api('u1', 'GET', '/api/library/files')).data;
  const book = d.files.find((f) => f.id === a.data.id);
  const snd = d.files.find((f) => f.id === audio.data.id);
  assert.equal(book.kind, 'pdf'); assert.equal(book.type_label, 'PDF'); assert.equal(book.has_cover, true);
  assert.equal(book.featured, true); assert.equal(book.meta_label, '32 صفحة'); assert.equal(book.previewable, true);
  assert.equal(snd.kind, 'audio'); assert.equal(snd.type_label, 'MP3'); assert.equal(snd.has_cover, false);
  assert.ok(d.top.some((f) => f.id === a.data.id), 'المميّز يظهر في الأكثر تحميلاً');
  assert.equal(typeof d.total_downloads, 'number');

  // الغلاف يُقدَّم كصورة
  const cov = await fetch(`${base}/api/library/files/${a.data.id}/cover`, { headers: { cookie: jars.u1 } });
  assert.equal(cov.status, 200); assert.equal(cov.headers.get('content-type'), 'image/png');
  assert.match(cov.headers.get('content-disposition'), /inline/);
  await cov.arrayBuffer();

  // المعاينة inline لا ترفع العدّاد، والتنزيل يرفعه
  const count = () => api('u1', 'GET', '/api/library/files').then((r) => r.data.files.find((f) => f.id === a.data.id).downloads);
  const before = await count();
  const prev = await fetch(`${base}/api/library/files/${a.data.id}/download?inline=1`, { headers: { cookie: jars.u1 } });
  assert.equal(prev.status, 200); assert.match(prev.headers.get('content-disposition'), /inline/);
  await prev.arrayBuffer();
  assert.equal(await count(), before, 'المعاينة لا تُحتسب');
  const dl = await fetch(`${base}/api/library/files/${a.data.id}/download`, { headers: { cookie: jars.u1 } });
  await dl.arrayBuffer();
  assert.equal(await count(), before + 1, 'التنزيل يُحتسب');

  // إلغاء التمييز بتعديل سريع
  assert.equal((await api('admin', 'PATCH', `/api/library/admin/files/${a.data.id}`, { featured: false })).status, 200);
  assert.equal((await api('u1', 'GET', '/api/library/files')).data.files.find((f) => f.id === a.data.id).featured, false);
  assert.equal((await api('u1', 'GET', `/api/library/files/${a.data.id}/cover`)).status, 200);
  assert.equal((await api('u1', 'POST', '/api/library/admin/files', new FormData(), true)).status, 403);
});

// ======================= الموقع العام: الدورات والتسجيل =======================
let C_OPEN, C_FULL;
test('الموقع: الدورات تُقرأ من قاعدة البيانات، والمسودة لا تظهر للزائر', async () => {
  const mk = (o) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.append(k, String(v)); return api('admin', 'POST', '/api/admin/courses', fd, true); };
  const a = await mk({ kind: 'remote', title: 'دورة الاختبار', status: 'open', price_minor: 15000, seats: 2, instructor: 'مدرّب',
    summary: 'ملخص', description: 'وصف كامل', time_label: 'كل ثلاثاء', duration_label: '٦ لقاءات', start_date: '2026-12-01', end_date: '2026-12-20',
    goals: JSON.stringify(['هدف أول', 'هدف ثانٍ']), topics: JSON.stringify(['محور أول']), faq: JSON.stringify([{ q: 'سؤال؟', a: 'جواب.' }]) });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  C_OPEN = a.data.id;
  const draft = await mk({ kind: 'remote', title: 'مسودة لا تظهر', status: 'draft', price_minor: 0 });
  assert.equal(draft.status, 201);
  assert.equal((await mk({ kind: 'remote', title: 'س', status: 'open', price_minor: 0 })).status, 400, 'عنوان قصير');
  assert.equal((await mk({ kind: 'remote', title: 'سعر خاطئ', status: 'open', price_minor: -5 })).status, 400);
  assert.equal((await mk({ kind: 'remote', title: 'رابط خاطئ', status: 'open', price_minor: 0, attend_link: 'javascript:1' })).status, 400);

  const pub = (await api('anon', 'GET', '/api/site/courses')).data;
  assert.ok(pub.courses.some((c) => c.id === C_OPEN), 'المنشورة تظهر للزائر بلا تسجيل دخول');
  assert.ok(!pub.courses.some((c) => c.id === draft.data.id), 'المسودة لا تظهر');
  const detail = (await api('anon', 'GET', `/api/site/courses/${C_OPEN}`)).data.course;
  assert.equal(detail.instructor, 'مدرّب'); assert.deepEqual(detail.goals, ['هدف أول', 'هدف ثانٍ']);
  assert.equal(detail.faq[0].q, 'سؤال؟'); assert.equal(detail.price, '15.000 ر.ع');
  assert.equal((await api('anon', 'GET', `/api/site/courses/${draft.data.id}`)).status, 404, 'تفاصيل المسودة محجوبة');
  assert.equal((await api('cu', 'GET', '/api/admin/courses')).status, 403, 'الإدارة للمدير فقط');
  await api('admin', 'DELETE', `/api/admin/courses/${draft.data.id}`);
});

test('الموقع: التسجيل ينقص المقاعد، ويمنع التكرار والامتلاء، والإلغاء يعيد المقعد', async () => {
  const reg = (phone, extra = {}) => api('anon', 'POST', '/api/site/register', withReceipt({ course_id: C_OPEN, name: 'عبدالله السالمي', phone, ...extra }), true);
  assert.equal((await reg('123')).status, 400, 'رقم غير صحيح');
  assert.equal((await api('anon', 'POST', '/api/site/register', { course_id: C_OPEN, name: 'ا', phone: '91000011' })).status, 400, 'اسم قصير');
  const r1 = await reg('91000011');
  assert.equal(r1.status, 201); assert.equal(r1.data.course.title, 'دورة الاختبار');
  assert.equal((await reg('91000011')).status, 409, 'لا تكرار لنفس الرقم');
  assert.equal((await api('anon', 'GET', '/api/site/courses')).data.courses.find((c) => c.id === C_OPEN).seats_left, 1);
  const r2 = await reg('91000012', { kind: 'gift', gift_from: 'محسن' });
  assert.equal(r2.status, 201);
  const full = (await api('anon', 'GET', '/api/site/courses')).data.courses.find((c) => c.id === C_OPEN);
  assert.equal(full.seats_left, 0); assert.equal(full.seat_state, 'full'); assert.equal(full.can_register, false);
  assert.equal((await reg('91000013')).status, 409, 'اكتمل العدد');
  // الإدارة: القائمة والتصدير والإلغاء
  const regs = (await api('admin', 'GET', `/api/admin/courses/${C_OPEN}/registrations`)).data;
  assert.equal(regs.registrations.length, 2);
  assert.ok(regs.registrations.some((x) => x.kind === 'gift' && x.gift_from === 'محسن'));
  const csv = await fetch(`${base}/api/admin/courses/${C_OPEN}/registrations.csv`, { headers: { cookie: jars.admin } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /csv/);
  assert.match(await csv.text(), /عبدالله السالمي/);
  const one = regs.registrations[0];
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${one.id}`, { status: 'cancelled' })).status, 200);
  assert.equal((await api('anon', 'GET', '/api/site/courses')).data.courses.find((c) => c.id === C_OPEN).seats_left, 1, 'عاد المقعد');
  assert.equal((await api('admin', 'DELETE', `/api/admin/courses/${C_OPEN}`)).status, 409, 'لا حذف لدورة لها مسجّلون');
});

test('الموقع: النسخ والحالات وإخفاء المكتملة', async () => {
  const dup = await api('admin', 'POST', `/api/admin/courses/${C_OPEN}/duplicate`);
  assert.equal(dup.status, 201);
  const copy = (await api('admin', 'GET', `/api/admin/courses/${dup.data.id}`)).data.course;
  assert.equal(copy.status, 'draft', 'النسخة مسودة');
  assert.match(copy.title, /نسخة/);
  assert.equal(copy.seats_taken, 0, 'النسخة بلا مسجّلين');
  C_FULL = dup.data.id;
  assert.equal((await api('admin', 'PATCH', `/api/admin/courses/${C_FULL}`, { status: 'closed' })).status, 200);
  const shown = (await api('anon', 'GET', '/api/site/courses')).data.courses;
  assert.ok(shown.some((c) => c.id === C_FULL && !c.can_register), 'المكتملة تظهر باهتة افتراضياً');
  assert.equal((await api('admin', 'PUT', '/api/admin/courses-settings', { hide_full_courses: true })).status, 200);
  assert.ok(!(await api('anon', 'GET', '/api/site/courses')).data.courses.some((c) => c.id === C_FULL), 'تُخفى حسب الإعداد');
  await api('admin', 'PUT', '/api/admin/courses-settings', { hide_full_courses: false });
  assert.equal((await api('admin', 'DELETE', `/api/admin/courses/${C_FULL}`)).status, 200);
  // الصفحة الرئيسية للزائر
  const home = (await api('anon', 'GET', '/api/site/home')).data;
  assert.ok(home.hero.title && home.about.length === 3 && home.paths.length === 4);
  assert.equal(home.signed_in, false);
});

// ======================= خطة العام =======================
test('خطة العام: الترتيب والدورة القادمة والمنتهية', async () => {
  const { db } = await import('../server/db.js');
  const { ordinalFem, yearPlan } = await import('../server/services/site.js');
  assert.equal(ordinalFem(10), 'العاشرة');
  assert.equal(ordinalFem(11), 'الحادية عشرة');
  assert.equal(ordinalFem(20), 'العشرون');
  assert.equal(ordinalFem(21), 'الحادية والعشرون');

  const t = Date.now();
  const add = (no, start, end, status = 'open') => db.prepare(
    `INSERT INTO courses(kind,title,summary,description,goals,topics,faq,schedule,instructor,month,start_date,end_date,time_label,duration_label,place,attend_link,attend_note,price_minor,seats,seats_taken,status,sort,course_no,created_at,updated_at)
     VALUES('year_month',?,'','','[]','[]','[]','[]','',?,?,?,'بعد العشاء','','','','',5000,40,0,?,?,?,?,?)`,
  ).run(`دورة الاستشفاء — الدورة ${ordinalFem(no)}`, Number(start.slice(5, 7)), start, end, status, no, no, t, t).lastInsertRowid;
  const past = add(10, '2020-01-15', '2020-01-27');
  const next = add(11, '2099-01-15', '2099-01-27');
  const later = add(12, '2099-02-15', '2099-02-27');
  const draft = add(13, '2099-03-15', '2099-03-27', 'draft');
  const third = add(14, '2099-04-15', '2099-04-27');
  void third;

  const pub = (await api('anon', 'GET', '/api/site/year-plan')).data;
  const ids = pub.courses.map((c) => c.id);
  assert.ok(ids.indexOf(past) < ids.indexOf(next), 'الترتيب زمني');
  assert.equal(pub.next_id, next, 'الدورة القادمة تُحدَّد تلقائياً');
  assert.equal(pub.courses.find((c) => c.id === past).is_past, true);
  assert.equal(pub.courses.find((c) => c.id === past).can_register, false, 'المنتهية لا تُسجَّل');
  assert.equal(pub.courses.find((c) => c.id === next).ordinal, 'الحادية عشرة');
  assert.ok(!ids.includes(draft), 'المسودة لا تظهر للزائر');
  assert.ok(yearPlan({ admin: true }).some((c) => c.id === draft), 'وتظهر للإدارة');
  void later;
});

test('خطة العام: التسجيل في أكثر من دورة، والملخص، ومنع المكرر والممتلئ', async () => {
  const pub = (await api('anon', 'GET', '/api/site/year-plan')).data.courses.filter((c) => c.can_register);
  const [a, b2] = pub;
  const r = await api('anon', 'POST', '/api/site/register-many', withReceipt({ course_ids: [a.id, b2.id], name: 'سالم بن ناصر', phone: '96500011' }), true);
  assert.equal(r.status, 201);
  assert.equal(r.data.done.length, 2);
  assert.equal(r.data.total_minor, a.price_minor + b2.price_minor, 'الإجمالي صحيح');
  // التكرار يُتخطّى لا يُفشل الطلب كله
  const again = await api('anon', 'POST', '/api/site/register-many', withReceipt({ course_ids: [a.id], name: 'سالم بن ناصر', phone: '96500011' }), true);
  assert.equal(again.status, 409);
  const mixed = await api('anon', 'POST', '/api/site/register-many', withReceipt({ course_ids: [a.id, pub[2].id], name: 'سالم بن ناصر', phone: '96500011' }), true);
  assert.equal(mixed.status, 201);
  assert.equal(mixed.data.done.length, 1);
  assert.equal(mixed.data.skipped[0].reason, 'مسجَّل مسبقاً');
  assert.equal((await api('anon', 'POST', '/api/site/register-many', { course_ids: [], name: 'س س س', phone: '96500012' })).status, 400);
  assert.equal((await api('anon', 'POST', '/api/site/register-many', { course_ids: [a.id], name: 'س', phone: '96500012' })).status, 400);
  // المقاعد نقصت
  const after = (await api('anon', 'GET', '/api/site/year-plan')).data.courses.find((c) => c.id === a.id);
  assert.equal(after.seats_left, a.seats_left - 1);
});

test('خطة العام: الإدارة تعدّل الصف، وتُنبَّه عند تغيير موعد فيه مسجّلون، وتمدّد الخطة', async () => {
  const plan = (await api('admin', 'GET', '/api/admin/year-plan')).data;
  assert.ok(plan.courses.length >= 4);
  assert.equal(plan.statuses.closed, 'منتهية');
  const withRegs = plan.courses.find((c) => c.registrations > 0);
  assert.ok(withRegs, 'دورة فيها مسجّلون');
  const ok = await api('admin', 'PATCH', `/api/admin/year-plan/${withRegs.id}`, { price_minor: 6000 });
  assert.equal(ok.status, 200); assert.equal(ok.data.warn, false);
  const warn = await api('admin', 'PATCH', `/api/admin/year-plan/${withRegs.id}`, { start_date: '2099-06-01', end_date: '2099-06-13' });
  assert.equal(warn.data.warn, true, 'تنبيه عند تغيير الموعد');
  assert.match(warn.data.message, /أبلغهم/);
  assert.equal((await api('admin', 'PATCH', `/api/admin/year-plan/${withRegs.id}`, { end_date: '2099-05-01' })).status, 400, 'نهاية قبل البداية');
  assert.equal((await api('admin', 'PATCH', `/api/admin/year-plan/${withRegs.id}`, { seats: 0 })).status, 400, 'مقاعد أقل من المسجّلين');
  assert.equal((await api('cu', 'PATCH', `/api/admin/year-plan/${withRegs.id}`, { price_minor: 1 })).status, 403);
  // التمديد
  const before = plan.courses.length;
  const ext = await api('admin', 'POST', '/api/admin/year-plan/extend', { count: 3 });
  assert.equal(ext.status, 201); assert.equal(ext.data.added.length, 3);
  const after = (await api('admin', 'GET', '/api/admin/year-plan')).data.courses;
  assert.equal(after.length, before + 3);
  const nos = after.map((c) => c.course_no).filter(Boolean);
  assert.equal(new Set(nos).size, nos.length, 'أرقام الدورات متسلسلة بلا تكرار');
  assert.ok(after.slice(-3).every((c) => c.status === 'draft'), 'المضاف مسودات');
  assert.ok(!(await api('anon', 'GET', '/api/site/year-plan')).data.courses.some((c) => c.status === 'draft'));
});

test('التسجيل: تحقق الحقول، إنشاء الحساب، ثم الدخول بكلمة السر', async () => {
  const { db } = await import('../server/db.js');
  const form = { name: 'أحمد محمد العلوي', phone: '91234567', gender: 'male', email: 'Ahmed@Example.com', password: 'secret-pass-1' };
  const reg = (b) => api('reg', 'POST', '/api/auth/register', { ...form, ...b });
  assert.equal((await reg({ name: 'أحمد محمد' })).status, 400, 'اسم غير ثلاثي');
  assert.equal((await reg({ email: 'bad' })).status, 400);
  assert.equal((await reg({ gender: 'x' })).status, 400);
  assert.equal((await reg({ password: '123' })).status, 400);
  assert.equal((await reg({ phone: '90000000' })).status, 409, 'رقم مسجل (المدير)');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE phone=?').get('+96891234567').c, 0, 'الطلبات المرفوضة لا تنشئ حساباً');

  const ok = await reg({});
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.user.role, 'user');
  const row = db.prepare('SELECT * FROM users WHERE phone=?').get('+96891234567');
  assert.equal(row.email, 'ahmed@example.com'); assert.equal(row.gender, 'male');
  assert.ok(row.pin_hash && !row.pin_hash.includes('secret-pass-1'));
  assert.equal((await api('reg', 'GET', '/api/auth/me')).data.user.name, 'أحمد محمد العلوي');

  const pin = await api('again', 'POST', '/api/auth/login-pin', { phone: '91234567', pin: 'secret-pass-1' });
  assert.equal(pin.status, 200, 'الدخول بكلمة السر');
  assert.equal((await reg({ phone: '92222222' })).status, 409, 'بريد مكرر');
  assert.equal((await reg({ email: 'other@example.com' })).status, 409, 'رقم مكرر');
});

const PNG = () => new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])], { type: 'image/png' });

test('الاشتراك في دورة: إيصال التحويل، ثم مراجعة الإدارة وفتح لوحة المتابعة', async () => {
  const fs = await import('node:fs');
  const { db } = await import('../server/db.js');
  const { config } = await import('../server/config.js');
  const { purgeReceipts } = await import('../server/services/registrations.js');
  const paid = db.prepare("SELECT id FROM courses WHERE status='open' AND price_minor > 0 AND (seats IS NULL OR seats - seats_taken >= 4) ORDER BY id").get();
  const free = db.prepare("SELECT id FROM courses WHERE status='open' AND price_minor > 0 AND (seats IS NULL OR seats - seats_taken >= 4) AND id <> ? ORDER BY id").get(paid.id);
  assert.ok(paid && free, 'دورتان مفتوحتان بمقاعد كافية');
  db.prepare('UPDATE courses SET price_minor = 0 WHERE id = ?').run(free.id);
  const seats = () => db.prepare('SELECT seats_taken FROM courses WHERE id=?').get(paid.id).seats_taken;

  // إعدادات الدورة: رقم التحويل ورابط المجتمع ونص الشكر (والرابط يُتحقق منه)
  const cur = (await api('admin', 'GET', `/api/admin/courses/${paid.id}`)).data.course;
  const put = (extra) => api('admin', 'PUT', `/api/admin/courses/${paid.id}`, { ...cur, ...extra });
  assert.equal((await put({ whatsapp_link: 'javascript:alert(1)' })).status, 400, 'رابط غير صالح');
  assert.equal((await put({ whatsapp_link: 'https://example.com/x' })).status, 400, 'ليس رابط واتساب');
  assert.equal((await put({ whatsapp_link: 'https://chat.whatsapp.com/ABC123', pay_phone: '90000000', thanks_text: 'اللهم بارك لهم' })).status, 200);
  assert.equal((await api('admin', 'PUT', '/api/admin/courses-settings', { payment_phone: '99887766', payment_holder: 'مؤسسة مثاني' })).status, 200);
  const page = (await api('guest', 'GET', `/api/site/courses/${paid.id}`)).data;
  assert.equal(page.payment.phone, '90000000', 'رقم الدورة يتقدّم على الرقم العام');
  assert.equal(JSON.stringify(page).includes('chat.whatsapp.com'), false, 'رابط المجتمع لا يظهر للزائر');
  assert.equal((await api('guest', 'GET', `/api/site/courses/${free.id}`)).data.payment.phone, '99887766');

  // الزائر لا بدّ أن يكتب بياناته
  assert.equal((await api('guest', 'POST', '/api/site/register', { course_id: paid.id })).status, 400);
  const guestNoRcpt = await api('guest', 'POST', '/api/site/register', { course_id: paid.id, name: 'زائر كريم الأحمد', phone: '93334444' });
  assert.equal(guestNoRcpt.status, 400); assert.match(guestNoRcpt.data.error, /إيصال/, 'الزائر أيضاً يرفع إيصالاً للدورة المدفوعة');

  // الحساب الجديد: لوحة المتابعة مقفلة حتى تقبل الإدارة
  const me0 = (await api('reg', 'GET', '/api/auth/me')).data.user;
  assert.equal(me0.access, false);
  assert.equal((await api('reg', 'GET', '/api/my/today')).data.locked, true);
  assert.equal((await api('reg', 'GET', '/api/my/history')).status, 403);

  // بلا إيصال → رفض، ولا يُحجز مقعد؛ ونوع الملف يُفحص
  const before = seats();
  const noRcpt = await api('reg', 'POST', '/api/site/register', { course_id: paid.id });
  assert.equal(noRcpt.status, 400); assert.match(noRcpt.data.error, /إيصال/);
  assert.equal(seats(), before);
  const fd = (blob, name, extra = {}) => { const f = new FormData(); f.append('course_id', String(paid.id)); for (const [k, v] of Object.entries(extra)) f.append(k, v); f.append('receipt', blob, name); return f; };
  assert.equal((await api('reg', 'POST', '/api/site/register', fd(new Blob(['x']), 'a.exe'), true)).status, 400);
  assert.equal((await api('reg', 'POST', '/api/site/register', fd(new Blob(['not a png at all']), 'a.png'), true)).status, 400);
  // الإهداء من عضو يتطلب إيصالاً أيضاً
  assert.equal((await api('reg', 'POST', '/api/site/register', { course_id: paid.id, kind: 'gift', name: 'فاطمة أحمد', phone: '92223333' })).status, 400);

  // مع الإيصال: يُسجَّل باسم الحساب، وتصله صفحة الشكر ورابط المجتمع
  const ok = await api('reg', 'POST', '/api/site/register', fd(PNG(), 'receipt.png', { note: 'ملاحظة' }), true);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.thanks_text, 'اللهم بارك لهم'); assert.equal(ok.data.whatsapp_link, 'https://chat.whatsapp.com/ABC123');
  const row = db.prepare('SELECT * FROM course_registrations WHERE id=?').get(ok.data.id);
  assert.equal(row.name, 'أحمد محمد العلوي'); assert.equal(row.phone, '+96891234567'); assert.equal(row.status, 'pending');
  assert.match(row.receipt_name, /^rcpt-[\w-]+\.png$/);
  assert.equal(seats(), before + 1);
  let mine = (await api('reg', 'GET', '/api/my/registrations')).data;
  assert.equal(mine.locked, true); assert.equal(mine.registrations[0].status, 'pending'); assert.equal(mine.registrations[0].status_label, 'بانتظار المراجعة');
  assert.equal(mine.registrations[0].whatsapp_link, 'https://chat.whatsapp.com/ABC123');
  assert.equal((await api('reg', 'POST', '/api/site/register', fd(PNG(), 'again.png'), true)).status, 409, 'لا يُسجَّل مرتين');

  // الإدارة: الإيصال لها وحدها، واللوحة تعرض إحصاءات عامة فقط
  const view = await fetch(`${base}/api/admin/registrations/${ok.data.id}/receipt`, { headers: { cookie: jars.admin } });
  assert.equal(view.status, 200); assert.equal(view.headers.get('content-type'), 'image/png');
  assert.equal((await api('reg', 'GET', `/api/admin/registrations/${ok.data.id}/receipt`)).status, 403);
  assert.equal((await api('reg', 'GET', '/api/admin/registrations-board')).status, 403);
  const board = (await api('admin', 'GET', `/api/admin/registrations-board?course_id=${paid.id}&status=pending`)).data;
  assert.ok(board.stats.pending >= 1 && board.items[0].id === ok.data.id && board.items[0].has_receipt);
  assert.equal(JSON.stringify(board).includes('submission'), false);
  assert.ok((await api('admin', 'GET', '/api/notifications/summary')).data.pending_regs >= 1);

  // الرفض يحتاج سبباً، ويُرجع المقعد، ويصل المشترك سبب الرفض
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${ok.data.id}`, { status: 'rejected' })).status, 400);
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${ok.data.id}`, { status: 'rejected', reason: 'الإيصال غير واضح' })).status, 200);
  assert.equal(seats(), before);
  mine = (await api('reg', 'GET', '/api/my/registrations')).data;
  assert.equal(mine.registrations[0].status, 'rejected'); assert.equal(mine.registrations[0].reject_reason, 'الإيصال غير واضح'); assert.equal(mine.registrations[0].whatsapp_link, '');
  const note = db.prepare("SELECT * FROM notifications WHERE type='registration_rejected' ORDER BY id DESC").get();
  assert.match(note.body, /الإيصال غير واضح/);

  // رفع إيصال جديد بعد الرفض
  const again = await api('reg', 'POST', '/api/site/register', fd(PNG(), 'new.png'), true);
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.equal(again.data.id, ok.data.id); assert.equal(seats(), before + 1);
  assert.equal(db.prepare('SELECT status, reject_reason FROM course_registrations WHERE id=?').get(ok.data.id).reject_reason, '');

  // القبول الجماعي يفتح المنصة ويرسل إشعاراً
  const bulk = await api('admin', 'POST', '/api/admin/registrations/bulk-confirm', { ids: [ok.data.id] });
  assert.equal(bulk.data.confirmed, 1);
  assert.equal((await api('reg', 'GET', '/api/auth/me')).data.user.access, true);
  assert.equal((await api('reg', 'GET', '/api/my/today')).data.locked, undefined);
  assert.equal((await api('reg', 'GET', '/api/my/history')).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE type='registration_confirmed' AND title LIKE '%تفعيل%'").get());

  // قفل الوصول وفتحه يدوياً
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${ok.data.id}/access`, { open: false })).status, 200);
  assert.equal((await api('reg', 'GET', '/api/my/history')).status, 403);
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${ok.data.id}/access`, { open: true })).status, 200);
  assert.equal((await api('reg', 'GET', '/api/my/history')).status, 200);

  // حذف الإيصال بعد مدة من التفعيل (اختياري)
  const file = path.join(config.uploadDir, db.prepare('SELECT receipt_name FROM course_registrations WHERE id=?').get(ok.data.id).receipt_name);
  assert.ok(fs.existsSync(file));
  assert.equal(purgeReceipts(), 0, 'معطّل افتراضياً');
  assert.equal((await api('admin', 'PUT', '/api/admin/courses-settings', { receipt_retention_days: 7 })).status, 200);
  assert.equal(purgeReceipts(), 0, 'لم تمضِ المدة');
  db.prepare('UPDATE course_registrations SET confirmed_at = ? WHERE id = ?').run(Date.now() - 8 * 86_400_000, ok.data.id);
  assert.equal(purgeReceipts(), 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(db.prepare('SELECT receipt_name FROM course_registrations WHERE id=?').get(ok.data.id).receipt_name, null);
  await api('admin', 'PUT', '/api/admin/courses-settings', { receipt_retention_days: 0 });

  // الدورة المجانية: بلا إيصال
  // الرابط العام لمجتمع واتساب يُستعمل للدورة التي لا رابط خاصاً لها
  assert.equal((await api('admin', 'PUT', '/api/admin/courses-settings', { whatsapp_link: 'http://evil.example/x' })).status, 400);
  assert.equal((await api('admin', 'PUT', '/api/admin/courses-settings', { whatsapp_link: 'https://chat.whatsapp.com/GLOBAL1' })).status, 200);
  const freeReg = await api('reg', 'POST', '/api/site/register', { course_id: free.id });
  assert.equal(freeReg.status, 201);
  assert.equal(freeReg.data.whatsapp_link, 'https://chat.whatsapp.com/GLOBAL1');
  const links = (await api('reg', 'GET', '/api/my/registrations')).data.registrations;
  assert.equal(links.find((x) => x.course_id === free.id).whatsapp_link, 'https://chat.whatsapp.com/GLOBAL1');
  assert.equal(links.find((x) => x.course_id === paid.id).whatsapp_link, 'https://chat.whatsapp.com/ABC123', 'رابط الدورة يتقدّم على العام');
});

test('الإهداء: طلب المُهدي، مراجعة الإدارة، بطاقة الاستلام، الاعتذار والتحويل، والتذكير', async () => {
  const { db } = await import('../server/db.js');
  const { runGiftChecks } = await import('../server/services/gifts.js');
  const { localDate, addDays } = await import('../server/util/time.js');
  const course = db.prepare("SELECT * FROM courses WHERE status='open' AND kind IN ('remote','year_month') AND price_minor > 0 AND (seats IS NULL OR seats - seats_taken >= 6) ORDER BY id").get();
  assert.ok(course, 'دورة مفتوحة بمقاعد كافية');
  const origStart = course.start_date;
  db.prepare('UPDATE courses SET start_date = ? WHERE id = ?').run(addDays(localDate(), 30), course.id); // رابط الهدية صالح حتى بداية الدورة
  const seats = () => db.prepare('SELECT seats_taken FROM courses WHERE id=?').get(course.id).seats_taken;
  const seats0 = seats();
  const give = (who, extra = {}, withRcpt = true) => {
    const fields = { course_id: course.id, recipient_name: 'نورة سعيد الحارثي', recipient_contact: '92225555', message: 'أهديك هذا المقعد', anonymous: '1', ...extra };
    return api(who, 'POST', '/api/gifts', withRcpt ? withReceipt(fields) : fields, withRcpt);
  };
  const patchGift = (id, body) => api('admin', 'PATCH', `/api/admin/gifts/${id}`, body);

  // الخيارات عامة، والإهداء يتطلب حساباً
  const opts = (await api('guest', 'GET', '/api/gifts/options')).data;
  assert.ok(opts.courses.some((c) => c.id === course.id && c.payment) && opts.defaults.message);
  assert.equal((await give('guest')).status, 401);

  // تحقق المدخلات
  assert.equal((await give('reg', {}, false)).status, 400, 'الإيصال مطلوب');
  assert.equal((await give('reg', { recipient_name: 'نو' })).status, 400, 'اسم قصير');
  assert.equal((await give('reg', { recipient_contact: '12' })).status, 400, 'رقم غير صحيح');
  assert.equal((await give('reg', { recipient_contact: 'bad@x' })).status, 400, 'بريد غير صحيح');
  assert.equal((await give('reg', { recipient_contact: '91234567' })).status, 400, 'رقم المُهدي نفسه');
  assert.equal((await give('reg', { course_id: 999999 })).status, 400, 'دورة غير موجودة');

  // الطلب: بانتظار المراجعة، ولا مقعد محجوز قبل القبول
  const created = await give('reg');
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const gid = created.data.id;
  assert.equal(seats(), seats0);
  let mine = (await api('reg', 'GET', '/api/gifts/mine')).data.gifts;
  assert.equal(mine[0].status, 'pending'); assert.equal(mine[0].status_label, 'بانتظار المراجعة'); assert.equal(mine[0].link, null);

  // الإدارة وحدها: اللوحة والإيصال
  assert.equal((await api('reg', 'GET', '/api/admin/gifts-board')).status, 403);
  assert.equal((await api('reg', 'GET', `/api/admin/gifts/${gid}/receipt`)).status, 403);
  const board = (await api('admin', 'GET', `/api/admin/gifts-board?course_id=${course.id}&status=pending`)).data;
  assert.equal(board.items[0].id, gid); assert.equal(board.items[0].giver_name, 'أحمد محمد العلوي'); assert.equal(board.items[0].has_receipt, true);
  assert.equal((await fetch(`${base}/api/admin/gifts/${gid}/receipt`, { headers: { cookie: jars.admin } })).status, 200);
  assert.ok((await api('admin', 'GET', '/api/notifications/summary')).data.pending_regs >= 1);

  // الرفض بسبب، ثم إيصال جديد من المُهدي
  assert.equal((await patchGift(gid, { action: 'reject' })).status, 400, 'السبب مطلوب');
  assert.equal((await patchGift(gid, { action: 'reject', reason: 'المبلغ ناقص' })).status, 200);
  mine = (await api('reg', 'GET', '/api/gifts/mine')).data.gifts;
  assert.equal(mine[0].status, 'rejected'); assert.equal(mine[0].reject_reason, 'المبلغ ناقص');
  assert.match(db.prepare("SELECT body FROM notifications WHERE type='gift_rejected' ORDER BY id DESC").get().body, /المبلغ ناقص/);
  const re = new FormData(); re.append('receipt', new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])], { type: 'image/png' }), 'again.png');
  assert.equal((await api('reg', 'POST', `/api/gifts/${gid}/resubmit`, re, true)).status, 200);
  assert.equal((await api('reg', 'GET', '/api/gifts/mine')).data.gifts[0].status, 'pending');

  // القبول: يُحجز مقعد، ويُولَّد رابط، وتُرسل البطاقة
  assert.equal((await patchGift(gid, { action: 'approve' })).status, 200);
  assert.equal(seats(), seats0 + 1);
  const sent = db.prepare('SELECT * FROM gifts WHERE id=?').get(gid);
  assert.equal(sent.status, 'sent'); assert.ok(sent.token && sent.token.length >= 24); assert.equal(sent.delivery, 'whatsapp_sent');
  assert.equal((await patchGift(gid, { action: 'approve' })).status, 400, 'لا يُقبل مرتين');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE type='gift_sent'").get());
  mine = (await api('reg', 'GET', '/api/gifts/mine')).data.gifts;
  assert.equal(mine[0].status_label, 'تم الإرسال'); assert.match(mine[0].link, new RegExp(`#/gift/${sent.token}$`));

  // بطاقة الاستلام: عامة بالرابط، ولا بيانات دفع ولا اسم مُهدٍ ("من محب")
  const info = (await api('guest', 'GET', `/api/gifts/claim/${sent.token}`)).data;
  assert.equal(info.state, 'ok'); assert.equal(info.card.from, 'محب'); assert.equal(info.card.to, 'نورة سعيد الحارثي'); assert.equal(info.card.course.remote, true);
  const raw = JSON.stringify(info);
  for (const secret of ['أحمد محمد', '91234567', 'receipt', 'price', 'payment', 'phone']) assert.equal(raw.includes(secret), false, `لا يظهر ${secret}`);
  assert.equal((await api('guest', 'GET', '/api/gifts/claim/not-a-real-token-123456')).status, 404);
  assert.equal((await api('guest', 'POST', `/api/gifts/claim/${sent.token}/claim`)).status, 401, 'الاستلام يتطلب حساباً');

  // المُهدى إليه ينشئ حسابه ويستلم: الدورة في حسابه والمنصة مفتوحة، بلا مقعد إضافي
  const rcp = await api('rcp', 'POST', '/api/auth/register', { name: 'نورة سعيد الحارثي', phone: '92225555', gender: 'female', email: 'noura@example.com', password: 'secret-pass-2' });
  assert.equal(rcp.status, 201); assert.equal(rcp.data.user.access, false);
  const got = await api('rcp', 'POST', `/api/gifts/claim/${sent.token}/claim`);
  assert.equal(got.status, 200, JSON.stringify(got.data)); assert.equal(got.data.course.id, course.id);
  assert.equal(seats(), seats0 + 1, 'المقعد حُجز عند القبول فقط');
  const reg = db.prepare("SELECT * FROM course_registrations WHERE course_id=? AND phone='+96892225555'").get(course.id);
  assert.equal(reg.status, 'confirmed'); assert.equal(reg.kind, 'gift'); assert.equal(reg.gift_from, '', 'مُهدٍ مجهول');
  assert.equal((await api('rcp', 'GET', '/api/auth/me')).data.user.access, true);
  assert.equal((await api('rcp', 'GET', '/api/my/history')).status, 200);
  assert.equal(db.prepare('SELECT status FROM gifts WHERE id=?').get(gid).status, 'received');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE type='gift_received'").get());
  assert.equal((await api('rcp', 'POST', `/api/gifts/claim/${sent.token}/claim`)).status, 410, 'مرة واحدة فقط');
  assert.equal((await api('guest', 'GET', `/api/gifts/claim/${sent.token}`)).data.state, 'used');

  // الاعتذار: يعود المقعد، والإدارة تحوّلها لشخص آخر برابط جديد
  const g2 = (await give('reg', { anonymous: '0', recipient_name: 'سالم ناصر الريامي', recipient_contact: '93335555' })).data.id;
  await patchGift(g2, { action: 'approve' });
  const t2 = db.prepare('SELECT token FROM gifts WHERE id=?').get(g2).token;
  assert.equal((await api('guest', 'GET', `/api/gifts/claim/${t2}`)).data.card.from, 'أحمد محمد العلوي', 'باسم المُهدي');
  const seatsBeforeDecline = seats();
  assert.equal((await api('guest', 'POST', `/api/gifts/claim/${t2}/decline`)).status, 200);
  assert.equal(seats(), seatsBeforeDecline - 1);
  assert.equal((await api('guest', 'GET', `/api/gifts/claim/${t2}`)).data.state, 'declined');
  assert.equal((await api('admin', 'POST', `/api/admin/gifts/${g2}/reassign`, { name: 'خ', contact: '94445555' })).status, 400);
  assert.equal((await api('admin', 'POST', `/api/admin/gifts/${g2}/reassign`, { name: 'خالد علي المعمري', contact: 'khalid@example.com' })).status, 200);
  const re2 = db.prepare('SELECT * FROM gifts WHERE id=?').get(g2);
  assert.equal(re2.status, 'sent'); assert.notEqual(re2.token, t2); assert.equal(re2.recipient_channel, 'email'); assert.equal(re2.delivery, 'manual');
  assert.equal(seats(), seatsBeforeDecline);
  assert.equal((await api('guest', 'GET', `/api/gifts/claim/${t2}`)).status, 404, 'الرابط القديم لا يعمل');

  // طلب التحويل لشخص آخر بموافقة الإدارة
  const t3 = db.prepare('SELECT token FROM gifts WHERE id=?').get(g2).token;
  assert.equal((await api('guest', 'POST', `/api/gifts/claim/${t3}/transfer`, { name: 'ز', contact: '95556666' })).status, 400);
  assert.equal((await api('guest', 'POST', `/api/gifts/claim/${t3}/transfer`, { name: 'منى خالد الفارسي', contact: '95556666' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM gifts WHERE id=?').get(g2).status, 'transfer_requested');
  assert.equal((await api('admin', 'PATCH', `/api/admin/gifts/${g2}/transfer`, { approve: false })).status, 200);
  assert.equal(db.prepare('SELECT status FROM gifts WHERE id=?').get(g2).status, 'sent');
  await api('guest', 'POST', `/api/gifts/claim/${t3}/transfer`, { name: 'منى خالد الفارسي', contact: '95556666' });
  assert.equal((await api('admin', 'PATCH', `/api/admin/gifts/${g2}/transfer`, { approve: true })).status, 200);
  const re3 = db.prepare('SELECT * FROM gifts WHERE id=?').get(g2);
  assert.equal(re3.status, 'sent'); assert.equal(re3.recipient_name, 'منى خالد الفارسي'); assert.equal(re3.recipient_contact, '+96895556666'); assert.notEqual(re3.token, t3);

  // التذكير بعد 3 أيام (مرة واحدة)، وتنبيه الإدارة قبل بداية الدورة
  assert.deepEqual(await runGiftChecks(), { reminded: 0, alerted: 0 });
  db.prepare('UPDATE gifts SET sent_at = ? WHERE id = ?').run(Date.now() - 4 * 86_400_000, g2);
  assert.equal((await runGiftChecks()).reminded, 1);
  assert.equal((await runGiftChecks()).reminded, 0);
  db.prepare('UPDATE courses SET start_date = ? WHERE id = ?').run(addDays(localDate(), 1), course.id);
  assert.equal((await runGiftChecks()).alerted, 1);
  assert.equal((await runGiftChecks()).alerted, 0);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE type='gift_unclaimed'").get());

  // انتهاء الصلاحية بعد بداية الدورة
  db.prepare('UPDATE courses SET start_date = ? WHERE id = ?').run(addDays(localDate(), -1), course.id);
  const t4 = db.prepare('SELECT token FROM gifts WHERE id=?').get(g2).token;
  assert.equal((await api('guest', 'GET', `/api/gifts/claim/${t4}`)).data.state, 'expired');
  db.prepare('UPDATE courses SET start_date = ? WHERE id = ?').run(origStart, course.id);

  // إعدادات الإهداء
  assert.equal((await api('admin', 'PUT', '/api/admin/gift-settings', { theme: 'neon' })).status, 400);
  assert.equal((await api('admin', 'PUT', '/api/admin/gift-settings', { theme: 'peach', message: 'رسالة جديدة', dua: 'دعاء جديد' })).status, 200);
  const o2 = (await api('guest', 'GET', '/api/gifts/options')).data.defaults;
  assert.deepEqual([o2.theme, o2.message, o2.dua], ['peach', 'رسالة جديدة', 'دعاء جديد']);
  assert.equal(((await api('admin', 'GET', '/api/admin/gifts-board')).data.stats.received), 1);
});

// ---------------------------------------------------------------- خطتي: الأوراد الشخصية
test('خطتي: العضو يضيف وردًا بهدفه ووقته، ويظهر في لوحته ويقبل التسجيل', async () => {
  const mk = (o, who = 'u1') => api(who, 'POST', '/api/my/plan', { title: 'استغفار بعد العصر', count_unit: 'مرة', target_count: 50, start_time: '00:00', deadline_time: '23:59', ...o });
  const ok = await mk({ description: 'ملاحظة <b>خاصة</b>' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const p = ok.data.task;
  assert.equal(p.target_count, 50); assert.equal(p.count_unit, 'مرة'); assert.equal(p.description, 'ملاحظة خاصة', 'تنقية الوسوم');
  assert.equal(ok.data.starts_tomorrow, false);

  // التحقق من المدخلات
  assert.equal((await mk({ title: '' })).status, 400, 'الاسم مطلوب');
  assert.equal((await mk({ target_count: 0 })).status, 400, 'الهدف موجب');
  assert.equal((await mk({ days_of_week: [] })).status, 400, 'يوم واحد على الأقل');
  assert.equal((await mk({ start_time: '16:00', deadline_time: '15:00' })).status, 400, 'النهاية بعد البداية');
  assert.equal((await mk({ start_time: '25:00' })).status, 400, 'صيغة الوقت');

  // يظهر في لوحة صاحبه بعد أوراد المنصة، ومعلَّماً شخصياً
  const t1 = (await api('u1', 'GET', '/api/my/today')).data;
  const mine = t1.today_tasks.find((t) => t.task_id === p.id);
  assert.ok(mine, 'يظهر الورد الشخصي في وردي اليوم');
  assert.equal(mine.personal, true); assert.equal(mine.target_count, 50); assert.equal(mine.ui, 'count');
  assert.ok(t1.today_tasks.findIndex((t) => t.task_id === wird.id) < t1.today_tasks.findIndex((t) => t.task_id === p.id), 'أوراد المنصة أولاً');

  // ورد «إتمام» بهدف 1
  const chk = (await mk({ title: 'أذكار العصر', target_count: 1 })).data.task;
  assert.equal((await api('u1', 'GET', '/api/my/today')).data.today_tasks.find((t) => t.task_id === chk.id).ui, 'check');

  // التسجيل والتعديل بنفس مسار الأوراد
  const send = (id, c) => api('u1', 'POST', '/api/my/submit', { task_id: id, date: t1.today, count: c });
  assert.equal((await send(p.id, 50)).status, 201);
  assert.equal((await send(p.id, 70)).status, 200);
  const done = (await api('u1', 'GET', '/api/my/today')).data.today_tasks.find((t) => t.task_id === p.id);
  assert.equal(done.submission.count, 70); assert.equal(done.status, 'on_time');
  assert.equal((await api('u1', 'GET', '/api/my/plan')).data.tasks.length, 2);
});

test('خطتي: الورد الشخصي خاص بصاحبه — لا يراه عضو آخر ولا الإدارة ولا تقاريرها', async () => {
  const p = (await api('u1', 'GET', '/api/my/plan')).data.tasks.find((t) => t.title === 'استغفار بعد العصر');
  assert.equal((await api('u2', 'GET', '/api/my/plan')).data.tasks.length, 0);
  assert.ok(!(await api('u2', 'GET', '/api/my/today')).data.today_tasks.some((t) => t.task_id === p.id));
  assert.equal((await api('u2', 'POST', '/api/my/submit', { task_id: p.id, date: (await api('u2', 'GET', '/api/my/today')).data.today, count: 5 })).status, 403);
  for (const [m, url, body] of [['PUT', `/api/my/plan/${p.id}`, { title: 'اختراق' }], ['DELETE', `/api/my/plan/${p.id}`], ['POST', `/api/my/plan/${p.id}/pause`]]) {
    assert.equal((await api('u2', m, url, body)).status, 404, `${m} ${url}`);
  }
  assert.equal((await api('anon', 'GET', '/api/my/plan')).status, 401);

  // الإدارة: لا قائمة ولا تفصيل ولا تعديل ولا لوحة ولا متابعة ولا تذكير
  assert.ok(!(await api('admin', 'GET', '/api/admin/tasks')).data.tasks.some((t) => t.id === p.id));
  assert.equal((await api('admin', 'GET', `/api/admin/tasks/${p.id}`)).status, 404);
  assert.equal((await api('admin', 'PUT', `/api/admin/tasks/${p.id}`, { title: 'x', assign: { all: true } })).status, 404);
  assert.equal((await api('admin', 'DELETE', `/api/admin/tasks/${p.id}`)).status, 404);
  assert.equal((await api('admin', 'POST', `/api/admin/tasks/${p.id}/archive`)).status, 404);
  assert.ok(!(await api('admin', 'GET', '/api/admin/dashboard')).data.tasks.some((t) => t.task_id === p.id));
  assert.equal((await api('admin', 'GET', `/api/admin/tracking?task_id=${p.id}`)).data.rows.length, 0);
  assert.equal((await api('admin', 'POST', '/api/admin/reminders', { task_id: p.id, date: (await api('u1', 'GET', '/api/my/today')).data.today })).status, 404);
  const rep = (await api('admin', 'GET', '/api/admin/reports/summary')).data;
  assert.ok(!rep.tasks.some((t) => t.task_id === p.id || t.id === p.id));
});

test('خطتي: تعديل وإيقاف مؤقت واستئناف، والحذف يؤرشف إن كان له سجل', async () => {
  const list = (await api('u1', 'GET', '/api/my/plan')).data.tasks;
  const p = list.find((t) => t.title === 'استغفار بعد العصر');
  const today = (await api('u1', 'GET', '/api/my/today')).data.today;
  const ed = await api('u1', 'PUT', `/api/my/plan/${p.id}`, { title: 'الصلاة على النبي', count_unit: 'مرة', target_count: 100, start_time: '00:00', deadline_time: '23:59', days_of_week: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  assert.equal(ed.data.task.title, 'الصلاة على النبي'); assert.equal(ed.data.task.target_count, 100); assert.equal(ed.data.task.start_date, p.start_date, 'تاريخ البدء لا يتغير');
  assert.equal((await api('u1', 'PUT', `/api/my/plan/${p.id}`, { title: '' })).status, 400);

  // إيقاف مؤقت: يختفي من اليوم، والاستئناف يعيده
  assert.equal((await api('u1', 'POST', `/api/my/plan/${p.id}/pause`)).data.task.status, 'paused');
  assert.ok(!(await api('u1', 'GET', '/api/my/today')).data.today_tasks.some((t) => t.task_id === p.id));
  assert.equal((await api('u1', 'POST', `/api/my/plan/${p.id}/resume`)).data.task.status, 'active');
  assert.ok((await api('u1', 'GET', '/api/my/today')).data.today_tasks.some((t) => t.task_id === p.id));

  // له تسجيل ← أرشفة: يخرج من الخطة ويبقى في الإحصاءات التراكمية
  const del = await api('u1', 'DELETE', `/api/my/plan/${p.id}`);
  assert.deepEqual(del.data, { ok: true, archived: true });
  assert.ok(!(await api('u1', 'GET', '/api/my/plan')).data.tasks.some((t) => t.id === p.id));
  assert.ok(!(await api('u1', 'GET', '/api/my/today')).data.today_tasks.some((t) => t.task_id === p.id));
  assert.ok((await api('u1', 'GET', '/api/my/stats')).data.cumulative.some((c) => c.task_id === p.id && c.total === 70), 'السجل محفوظ');
  assert.equal((await api('u1', 'DELETE', `/api/my/plan/${p.id}`)).status, 404, 'المؤرشف لا يُحذف ثانية');

  // بلا تسجيل ← حذف نهائي
  const chk = list.find((t) => t.title === 'أذكار العصر');
  assert.deepEqual((await api('u1', 'DELETE', `/api/my/plan/${chk.id}`)).data, { ok: true, archived: false });
  const { db } = await import('../server/db.js');
  assert.equal(db.prepare('SELECT 1 FROM tasks WHERE id=?').get(chk.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM task_assignees WHERE task_id=?').get(chk.id), undefined, 'الإسناد يُحذف معه');
});

test('خطتي: وقت الورد انتهى اليوم فيبدأ غداً، والحد الأقصى للأوراد', async () => {
  const { addDays } = await import('../server/util/time.js');
  const localMin = () => { const d = new Date(Date.now() + 240 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const today = (await api('u2', 'GET', '/api/my/today')).data.today;
  if (localMin() >= 5) {
    const r = await api('u2', 'POST', '/api/my/plan', { title: 'ورد فات وقته', target_count: 3, start_time: '00:00', deadline_time: hhmm(localMin() - 2) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.starts_tomorrow, true);
    assert.equal(r.data.task.start_date, addDays(today, 1));
    assert.ok(!(await api('u2', 'GET', '/api/my/today')).data.today_tasks.some((t) => t.task_id === r.data.task.id), 'لا يُحسب اليوم لم يُسجَّل');
    assert.equal((await api('u2', 'DELETE', `/api/my/plan/${r.data.task.id}`)).status, 200);
  }
  for (let i = 0; i < 20; i++) assert.equal((await api('u2', 'POST', '/api/my/plan', { title: `ورد ${i}`, target_count: 1 })).status, 201);
  const over = await api('u2', 'POST', '/api/my/plan', { title: 'الحادي والعشرون', target_count: 1 });
  assert.equal(over.status, 400); assert.match(over.data.error, /الحد الأقصى/);
  // الإيقاف لا يحرّر مكاناً، والحذف يحرّره
  const first = (await api('u2', 'GET', '/api/my/plan')).data.tasks[0];
  assert.equal((await api('u2', 'DELETE', `/api/my/plan/${first.id}`)).status, 200);
  assert.equal((await api('u2', 'POST', '/api/my/plan', { title: 'بعد الحذف', target_count: 1 })).status, 201);
});

test('خطتي: العضو المقفل (قبل قبول الإدارة لإيصاله) لا يصل إلى خطته', async () => {
  const { db } = await import('../server/db.js');
  assert.equal((await api('admin', 'POST', '/api/admin/users', { name: 'مقفل', phone: '97777770' })).status, 201);
  await login('lock', '97777770');
  assert.equal((await api('lock', 'GET', '/api/my/plan')).status, 200, 'قبل التقييد');
  db.prepare("UPDATE users SET tracking_access=0 WHERE phone='+96897777770'").run();
  assert.equal((await api('lock', 'GET', '/api/my/plan')).status, 403);
  assert.equal((await api('lock', 'POST', '/api/my/plan', { title: 'ورد', target_count: 1 })).status, 403);
});

test('نص القراءة: تحفظه الإدارة منقّى ويصل العضو مع الورد، ويبقى الرابط الخارجي اختيارياً', async () => {
  const body = (o) => ({ title: 'ورد بنص', count_unit: 'مرة', target_count: 1, start_date: '2020-01-01', assign: { user_ids: [U1.id] }, ...o });
  const txt = '١. الْفَاتِحَةُ: ٧ مَرَّاتٍ.\n<script>x()</script>\n\n\n\n💡 خاتمة 🌿';
  const ok = await api('admin', 'POST', '/api/admin/tasks', body({ read_text: txt, link_url: '' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const t = ok.data.task;
  assert.equal(t.read_text, '١. الْفَاتِحَةُ: ٧ مَرَّاتٍ.\nx()\n\n💡 خاتمة 🌿', 'تنقية الوسوم مع حفظ التشكيل والرموز وتقليص الأسطر الفارغة');

  const mine = (await api('u1', 'GET', '/api/my/today')).data.today_tasks.find((x) => x.task_id === t.id);
  assert.equal(mine.read_text, t.read_text); assert.equal(mine.link_url, '');
  assert.equal((await api('u2', 'GET', '/api/my/today')).data.today_tasks.some((x) => x.task_id === t.id), false);

  // حد 20 ألف حرف، والتعديل يمسح النص
  const long = await api('admin', 'PUT', `/api/admin/tasks/${t.id}`, body({ read_text: 'أ'.repeat(25_000) }));
  assert.equal(long.data.task.read_text.length, 20_000);
  const none = await api('admin', 'PUT', `/api/admin/tasks/${t.id}`, body({ read_text: '', link_url: 'https://example.com/x' }));
  assert.equal(none.data.task.read_text, ''); assert.equal(none.data.task.link_url, 'https://example.com/x');
  assert.equal((await api('admin', 'DELETE', `/api/admin/tasks/${t.id}`)).status, 200);
});

test('المسجلون الجدد: حذف اسم يعيد المقعد ويحذف الإيصال، ويتيح التسجيل من جديد', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { db } = await import('../server/db.js');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ kind: 'remote', title: 'دورة الحذف', status: 'open', price_minor: 5000, seats: 3, start_date: '2027-03-01', end_date: '2027-03-10' })) fd.append(k, String(v));
  const course = (await api('admin', 'POST', '/api/admin/courses', fd, true)).data.id;
  const reg = (phone, name) => api('anon', 'POST', '/api/site/register', withReceipt({ course_id: course, name, phone }), true);
  const seats = () => db.prepare('SELECT seats_taken s FROM courses WHERE id=?').get(course).s;
  const row = (phone) => db.prepare('SELECT * FROM course_registrations WHERE course_id=? AND phone=?').get(course, `+968${phone}`);
  const file = (r) => path.join(process.env.UPLOAD_DIR, path.basename(r.receipt_name));

  assert.equal((await reg('91000081', 'محمد الحارثي')).status, 201);
  assert.equal((await reg('91000082', 'خالد الراشدي')).status, 201);
  assert.equal(seats(), 2);
  const a = row('91000081'); const b = row('91000082');
  assert.ok(fs.existsSync(file(a)), 'الإيصال محفوظ قبل الحذف');

  // الصلاحيات: للمدير وحده
  assert.equal((await api('anon', 'DELETE', `/api/admin/registrations/${a.id}`)).status, 401);
  assert.equal((await api('u1', 'DELETE', `/api/admin/registrations/${a.id}`)).status, 403);
  assert.ok(row('91000081'), 'لم يُحذف');

  // طلب معلّق: حذف + مقعد يعود + إيصال يُحذف + تدقيق، والآخر سليم
  assert.equal((await api('admin', 'DELETE', `/api/admin/registrations/${a.id}`)).status, 200);
  assert.equal(row('91000081'), undefined); assert.equal(seats(), 1);
  assert.equal(fs.existsSync(file(a)), false, 'ملف الإيصال حُذف');
  assert.ok(row('91000082') && fs.existsSync(file(b)), 'الآخر لم يتأثر');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='course.reg_deleted' AND entity_id=?").get(a.id).c, 1);
  assert.equal((await api('admin', 'DELETE', `/api/admin/registrations/${a.id}`)).status, 404, 'لا حذف مكرر');

  // مرفوض: المقعد عاد عند الرفض، فلا يعود مرتين عند الحذف
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${b.id}`, { status: 'rejected', reason: 'الإيصال غير واضح' })).status, 200);
  assert.equal(seats(), 0);
  assert.equal((await api('admin', 'DELETE', `/api/admin/registrations/${b.id}`)).status, 200);
  assert.equal(seats(), 0, 'لا يتجاوز الصفر ولا يُخصم مرتين');

  // الاسم المحذوف يسجّل من جديد، والمقبول يحرّر مقعده عند حذفه
  assert.equal((await reg('91000081', 'محمد الحارثي')).status, 201, 'قيد التفرد لا يمنع بعد الحذف');
  const again = row('91000081');
  assert.equal((await api('admin', 'PATCH', `/api/admin/registrations/${again.id}`, { status: 'confirmed' })).status, 200);
  assert.equal(seats(), 1);
  assert.equal((await api('admin', 'DELETE', `/api/admin/registrations/${again.id}`)).status, 200);
  assert.equal(seats(), 0);
  assert.equal((await api('admin', 'DELETE', `/api/admin/courses/${course}`)).status, 200, 'الدورة بلا مسجلين تُحذف');
});

test('حذف الأعضاء: معاينة ما سيُمحى، تأكيد للسجلات، حجب السجلات المالية، وتنظيف المراجع', async () => {
  const { db } = await import('../server/db.js');
  const mk = async (name, phone, extra = {}) => (await api('admin', 'POST', '/api/admin/users', { name, phone, ...extra })).data.user;
  const exists = (id) => !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);

  // عضو له نشاط: ورد شخصي وتسجيل، ومسند إليه ورد إدارة، وله سجل تذكير، وأنشأ ورداً
  const X = await mk('عضو للحذف', '97777771');
  await login('x', '97777771');
  const personal = (await api('x', 'POST', '/api/my/plan', { title: 'ورد خاص', target_count: 1 })).data.task;
  const today = (await api('x', 'GET', '/api/my/today')).data.today;
  assert.equal((await api('x', 'POST', '/api/my/submit', { task_id: personal.id, date: today, count: 1 })).status, 201);
  const adminTask = (await api('admin', 'POST', '/api/admin/tasks', { title: 'ورد مُسنَد للحذف', target_count: 1, start_date: '2020-01-01', assign: { user_ids: [X.id] } })).data.task;
  db.prepare('UPDATE tasks SET created_by=? WHERE id=?').run(X.id, adminTask.id);
  db.prepare("INSERT INTO reminders(task_id,user_id,occ_date,mode,ok,sent_at) VALUES(?,?,?,'manual',1,?)").run(adminTask.id, X.id, today, Date.now());

  // للمدير وحده
  assert.equal((await api('u1', 'GET', `/api/admin/users/${X.id}/deletion-impact`)).status, 403);
  assert.equal((await api('u1', 'DELETE', `/api/admin/users/${X.id}`)).status, 403);

  // المعاينة ثم التأكيد
  const imp = (await api('admin', 'GET', `/api/admin/users/${X.id}/deletion-impact`)).data;
  assert.equal(imp.impact.submissions, 1); assert.equal(imp.impact.personal_wirds, 1); assert.deepEqual(imp.blockers, []); assert.equal(imp.has_history, true);
  const noForce = await api('admin', 'DELETE', `/api/admin/users/${X.id}`);
  assert.equal(noForce.status, 409); assert.equal(noForce.data.needs_force, true);
  assert.ok(exists(X.id), 'لم يُحذف بلا تأكيد');
  assert.equal((await api('admin', 'DELETE', `/api/admin/users/${X.id}?force=1`)).status, 200);

  // ما يُمحى وما يبقى
  assert.equal(exists(X.id), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM submissions WHERE user_id=?').get(X.id).c, 0);
  assert.equal(db.prepare('SELECT 1 FROM tasks WHERE id=?').get(personal.id), undefined, 'ورده الشخصي يُمحى');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM task_assignees WHERE kind='user' AND ref_id=?").get(X.id).c, 0, 'لا إسناد يتيم يرثه من يأخذ المعرّف لاحقاً');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reminders WHERE user_id=?').get(X.id).c, 0);
  const kept = db.prepare('SELECT created_by FROM tasks WHERE id=?').get(adminTask.id);
  assert.ok(kept && kept.created_by === null, 'ورد الإدارة يبقى بلا منشئ');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='user.deleted' AND entity_id=?").get(X.id).c, 1);
  assert.equal((await api('x', 'GET', '/api/my/today')).status, 401, 'جلساته انتهت');
  assert.equal((await api('x', 'POST', '/api/auth/request-otp', { phone: '97777771' })).data.dev_code, undefined, 'لا يدخل بعد الحذف');
  assert.equal((await api('u2', 'GET', '/api/my/today')).status, 200, 'غيره لم يتأثر');
  assert.equal((await api('admin', 'DELETE', `/api/admin/users/${X.id}`)).status, 404);
  await api('admin', 'DELETE', `/api/admin/tasks/${adminTask.id}`);

  // سجلات مالية: طلب متجر أو هدية أهداها ← يُمنع الحذف
  const Y = await mk('له طلب', '97777772');
  db.prepare("INSERT INTO orders(user_id,status,payment_method,subtotal_minor,total_minor,created_at,updated_at) VALUES(?,'new','cod',1000,1000,?,?)").run(Y.id, Date.now(), Date.now());
  const blockedOrder = await api('admin', 'DELETE', `/api/admin/users/${Y.id}?force=1`);
  assert.equal(blockedOrder.status, 400); assert.match(blockedOrder.data.error, /طلب/);
  assert.ok(exists(Y.id));
  const Z = await mk('أهدى هدية', '97777773');
  const course = db.prepare('SELECT id FROM courses LIMIT 1').get();
  assert.ok(course, 'توجد دورة من اختبارات سابقة');
  db.prepare("INSERT INTO gifts(giver_id,course_id,recipient_name,recipient_contact,recipient_channel,status,created_at) VALUES(?,?,?,?,'whatsapp','pending',?)").run(Z.id, course.id, 'مستلم', '+96895550000', Date.now());
  assert.match((await api('admin', 'DELETE', `/api/admin/users/${Z.id}`)).data.error, /هدية/);
  assert.ok(exists(Z.id));

  // نفسه: ممنوع. ومن لا سجلات له: حذف مباشر، ومشرف يترك حلقته بلا مشرف
  assert.equal((await api('admin', 'DELETE', `/api/admin/users/${(await api('admin', 'GET', '/api/auth/me')).data.user.id}`)).status, 400);
  const S = await mk('مشرف للحذف', '97777774', { role: 'supervisor' });
  const gid = db.prepare('INSERT INTO groups(name,supervisor_id,created_at) VALUES(?,?,?)').run('حلقة بلا مشرف', S.id, Date.now()).lastInsertRowid;
  assert.equal((await api('admin', 'GET', `/api/admin/users/${S.id}/deletion-impact`)).data.impact.supervised_groups, 1);
  assert.equal((await api('admin', 'DELETE', `/api/admin/users/${S.id}`)).status, 200, 'بلا سجلات: لا يلزمه تأكيد إضافي');
  assert.equal(db.prepare('SELECT supervisor_id s FROM groups WHERE id=?').get(gid).s, null);
});
