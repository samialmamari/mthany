import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { db, now, tx, placeholders } from '../db.js';
import { config } from '../config.js';
import { normalizePhone } from '../util/phone.js';
import { bad, forbidden, HttpError, notFound, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { removeStoredFile } from '../services/submissions.js';
import { scopeUserIds } from '../services/schedule.js';

const r = Router();
const staff = requireRole('admin', 'supervisor');
const adminOnly = requireRole('admin');
const ROLES = ['admin', 'supervisor', 'user'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const groupsOf = (uid) => db.prepare(
  'SELECT g.id, g.name FROM groups g JOIN user_groups ug ON ug.group_id=g.id WHERE ug.user_id=? ORDER BY g.name',
).all(uid);

function userOut(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, active: !!u.active, has_pin: !!u.pin_hash,
    last_login_at: u.last_login_at, groups: groupsOf(u.id) };
}

function setGroups(userId, groupIds) {
  const ids = [...new Set((groupIds || []).map(Number).filter(Boolean))];
  const existing = new Set(db.prepare('SELECT group_id FROM user_groups WHERE user_id=?').all(userId).map((x) => x.group_id));
  for (const gid of existing) if (!ids.includes(gid)) db.prepare('DELETE FROM user_groups WHERE user_id=? AND group_id=?').run(userId, gid);
  for (const gid of ids) {
    if (existing.has(gid)) continue;
    if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(gid)) throw bad('حلقة غير موجودة');
    db.prepare('INSERT INTO user_groups(user_id,group_id,joined_at) VALUES(?,?,?)').run(userId, gid, now());
  }
}

function adminCount() { return db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1`).get().c; }

// ============================ المستخدمون ============================
r.get('/users', staff, (req, res) => {
  const scope = scopeUserIds(req.user);
  const { q, group_id, role, active } = req.query;
  let sql = 'SELECT * FROM users WHERE 1=1';
  const args = [];
  if (scope) { sql += ` AND id IN (${placeholders(scope.length ? scope : [0])})`; args.push(...(scope.length ? scope : [0])); }
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  if (role) { sql += ' AND role = ?'; args.push(role); }
  if (active === '0' || active === '1') { sql += ' AND active = ?'; args.push(Number(active)); }
  if (group_id) { sql += ' AND id IN (SELECT user_id FROM user_groups WHERE group_id = ?)'; args.push(Number(group_id)); }
  sql += ' ORDER BY name';
  res.json({ users: db.prepare(sql).all(...args).map(userOut) });
});

r.post('/users', adminOnly, (req, res) => {
  const { name, phone, country, role = 'user', group_ids } = req.body || {};
  const p = normalizePhone(phone, country || config.defaultCountry);
  if (!String(name || '').trim()) throw bad('الاسم مطلوب');
  if (!p) throw bad('صيغة رقم الهاتف غير صحيحة');
  if (!ROLES.includes(role)) throw bad('دور غير صالح');
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(p)) throw bad('هذا الرقم مسجل مسبقاً');
  const id = tx(() => {
    const uid = db.prepare('INSERT INTO users(name,phone,role,created_at) VALUES(?,?,?,?)').run(String(name).trim(), p, role, now()).lastInsertRowid;
    setGroups(uid, group_ids);
    return uid;
  });
  res.status(201).json({ user: userOut(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

r.patch('/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw notFound();
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : u.name;
  const role = b.role ?? u.role;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  let phone = u.phone;
  if (b.phone !== undefined) {
    phone = normalizePhone(b.phone, b.country || config.defaultCountry);
    if (!phone) throw bad('صيغة رقم الهاتف غير صحيحة');
    if (phone !== u.phone && db.prepare('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, id)) throw bad('هذا الرقم مسجل مسبقاً');
  }
  if (!name) throw bad('الاسم مطلوب');
  if (!ROLES.includes(role)) throw bad('دور غير صالح');
  const losesAdmin = u.role === 'admin' && u.active && (role !== 'admin' || !active);
  if (losesAdmin && adminCount() <= 1) throw bad('لا يمكن إزالة آخر مدير للنظام');
  if (id === req.user.id && (!active || role !== u.role)) throw bad('لا يمكنك تعطيل نفسك أو تغيير دورك');
  tx(() => {
    db.prepare('UPDATE users SET name=?, phone=?, role=?, active=? WHERE id=?').run(name, phone, role, active, id);
    if (b.group_ids !== undefined) setGroups(id, b.group_ids);
    if (phone !== u.phone || !active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    if (role !== 'supervisor') db.prepare('UPDATE groups SET supervisor_id=NULL WHERE supervisor_id=?').run(id);
  });
  res.json({ user: userOut(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

r.post('/users/:id/logout-all', adminOnly, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

r.post('/users/:id/reset-pin', adminOnly, (req, res) => {
  db.prepare('UPDATE users SET pin_hash=NULL, pin_failures=0, pin_locked_until=0 WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * ما يُمحى مع العضو عند حذفه نهائياً، وما يمنع حذفه.
 * تُمحى أنشطته (تسجيلاته وأوراده الشخصية ومواضيعه وإشعاراته)، أمّا سجلات المال (طلبات المتجر والهدايا التي أهداها)
 * فتبقى محفوظة: من له شيء منها يُعطَّل حسابه بدلاً من حذفه.
 */
function deletionImpact(u, actorId) {
  const n = (sql, ...a) => db.prepare(sql).get(...a).c;
  const impact = {
    submissions: n('SELECT COUNT(*) c FROM submissions WHERE user_id=?', u.id),
    personal_wirds: n('SELECT COUNT(*) c FROM tasks WHERE owner_id=?', u.id),
    posts: n('SELECT COUNT(*) c FROM community_posts WHERE author_id=?', u.id),
    supervised_groups: n('SELECT COUNT(*) c FROM groups WHERE supervisor_id=?', u.id),
    registrations: n('SELECT COUNT(*) c FROM course_registrations WHERE user_id=? OR phone=?', u.id, u.phone),
  };
  const orders = n('SELECT COUNT(*) c FROM orders WHERE user_id=?', u.id);
  const gifts = n('SELECT COUNT(*) c FROM gifts WHERE giver_id=?', u.id);
  const blockers = [];
  if (u.id === actorId) blockers.push('لا يمكنك حذف نفسك');
  if (u.role === 'admin' && u.active && adminCount() <= 1) blockers.push('لا يمكن حذف آخر مدير');
  if (orders) blockers.push(`للعضو ${orders} طلب في المتجر وسجلات المبيعات تبقى محفوظة؛ عطّل حسابه بدلاً من حذفه`);
  if (gifts) blockers.push(`أهدى العضو ${gifts} هدية وسجلاتها تبقى محفوظة؛ عطّل حسابه بدلاً من حذفه`);
  return { impact, blockers, has_history: impact.submissions + impact.personal_wirds + impact.posts > 0 };
}

r.get('/users/:id/deletion-impact', adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw notFound();
  res.json({ user: { id: u.id, name: u.name, role: u.role }, ...deletionImpact(u, req.user.id) });
});

/** حذف نهائي. من له سجلات يلزمه ?force=1 بعد أن تعرض الواجهة ما سيُمحى */
r.delete('/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw notFound();
  const { impact, blockers, has_history: hasHistory } = deletionImpact(u, req.user.id);
  if (blockers.length) throw bad(blockers[0]);
  if (hasHistory && req.query.force !== '1') throw new HttpError(409, 'للعضو سجلات ستُمحى معه نهائياً؛ أكّد الحذف لمتابعته', { needs_force: true, impact });
  const images = db.prepare('SELECT image_name FROM community_posts WHERE author_id=? AND image_name IS NOT NULL').all(id).map((x) => x.image_name);
  tx(() => {
    // مراجع لا يحميها المفتاح الأجنبي: تُنظَّف حتى لا يرثها عضو يأخذ المعرّف نفسه لاحقاً
    db.prepare('UPDATE tasks SET created_by=NULL WHERE created_by=?').run(id);
    db.prepare("DELETE FROM task_assignees WHERE kind='user' AND ref_id=?").run(id);
    db.prepare('DELETE FROM reminders WHERE user_id=?').run(id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    audit(req.user.id, 'user.deleted', 'user', id, { name: u.name, role: u.role, ...impact });
  });
  images.forEach(removeStoredFile);
  res.json({ ok: true });
});

// ---------- استيراد Excel ----------
const cellText = (c) => {
  const v = c?.value;
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((x) => x.text).join('') : '') ?? '');
  return String(v);
};
const HEAD = {
  name: ['الاسم', 'اسم', 'name'],
  phone: ['الهاتف', 'رقم الهاتف', 'الجوال', 'رقم الجوال', 'phone', 'mobile'],
  role: ['الدور', 'الصلاحية', 'role'],
  group: ['الحلقة', 'الحلقات', 'المجموعة', 'المجموعات', 'group', 'groups'],
};

r.get('/users-template.xlsx', adminOnly, async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('المستخدمون', { views: [{ rightToLeft: true }] });
  ws.columns = [{ header: 'الاسم', width: 28 }, { header: 'الهاتف', width: 20 }, { header: 'الدور', width: 14 }, { header: 'الحلقة', width: 28 }];
  ws.addRow(['أحمد البلوشي', '91234567', 'عضو', 'حلقة الفجر']);
  ws.addRow(['سالم الحارثي', '+96892345678', 'مشرف', 'حلقة الفجر، حلقة المغرب']);
  ws.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="users-template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

const ROLE_WORDS = { 'مدير': 'admin', 'مدير النظام': 'admin', admin: 'admin', 'مشرف': 'supervisor', 'مشرف حلقة': 'supervisor', supervisor: 'supervisor', 'عضو': 'user', 'مستخدم': 'user', user: 'user' };

r.post('/users/import', adminOnly, upload.single('file'), async (req, res) => {
  if (!req.file) throw bad('أرفق ملف Excel (.xlsx)');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch { throw bad('تعذّرت قراءة الملف، تأكد أنه بصيغة .xlsx'); }
  const ws = wb.worksheets[0];
  if (!ws) throw bad('الملف فارغ');
  const idx = {};
  ws.getRow(1).eachCell((c, n) => {
    const h = cellText(c).trim().toLowerCase();
    for (const [k, names] of Object.entries(HEAD)) if (names.includes(h)) idx[k] = n;
  });
  if (!idx.name || !idx.phone) throw bad('يجب أن يحتوي الصف الأول على عمودي «الاسم» و«الهاتف»');

  const country = req.body.country || config.defaultCountry;
  const out = { added: 0, updated: 0, errors: [] };
  const seen = new Set();
  tx(() => {
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const name = cellText(row.getCell(idx.name)).trim();
      const rawPhone = cellText(row.getCell(idx.phone)).trim();
      if (!name && !rawPhone) return;
      const phone = normalizePhone(rawPhone, country);
      if (!name) return out.errors.push({ row: n, error: 'الاسم فارغ' });
      if (!phone) return out.errors.push({ row: n, error: `رقم غير صالح: ${rawPhone}` });
      if (seen.has(phone)) return out.errors.push({ row: n, error: 'رقم مكرر داخل الملف' });
      seen.add(phone);
      let role = 'user';
      if (idx.role) {
        const w = cellText(row.getCell(idx.role)).trim().toLowerCase();
        if (w) { role = ROLE_WORDS[w]; if (!role) return out.errors.push({ row: n, error: `دور غير معروف: ${w}` }); }
      }
      const groupNames = idx.group ? cellText(row.getCell(idx.group)).split(/[,،;؛\n]/).map((x) => x.trim()).filter(Boolean) : [];
      const gids = groupNames.map((gn) => {
        let g = db.prepare('SELECT id FROM groups WHERE name=?').get(gn);
        if (!g) g = { id: db.prepare('INSERT INTO groups(name,created_at) VALUES(?,?)').run(gn, now()).lastInsertRowid };
        return Number(g.id);
      });
      const ex = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
      if (ex) {
        if (ex.role === 'admin' && role !== 'admin') role = 'admin'; // لا نُنزل مديراً عبر الاستيراد
        db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(name, idx.role ? role : ex.role, ex.id);
        if (gids.length) { const cur = groupsOf(ex.id).map((g) => g.id); setGroups(ex.id, [...new Set([...cur, ...gids])]); }
        out.updated++;
      } else {
        const uid = db.prepare('INSERT INTO users(name,phone,role,created_at) VALUES(?,?,?,?)').run(name, phone, role, now()).lastInsertRowid;
        setGroups(uid, gids);
        out.added++;
      }
    });
  });
  res.json(out);
});

// ============================ المجموعات ============================
function groupOut(g) {
  return {
    ...g,
    supervisor_name: g.supervisor_id ? db.prepare('SELECT name FROM users WHERE id=?').get(g.supervisor_id)?.name : null,
    members: db.prepare('SELECT COUNT(*) c FROM user_groups WHERE group_id=?').get(g.id).c,
  };
}

r.get('/groups', staff, (req, res) => {
  let rows = db.prepare('SELECT * FROM groups ORDER BY name').all();
  if (req.user.role === 'supervisor') rows = rows.filter((g) => g.supervisor_id === req.user.id);
  res.json({ groups: rows.map(groupOut) });
});

function checkSupervisor(id) {
  if (id == null || id === '') return null;
  const s = db.prepare('SELECT role FROM users WHERE id=? AND active=1').get(Number(id));
  if (!s || s.role !== 'supervisor') throw bad('المشرف المختار غير صالح');
  return Number(id);
}

r.post('/groups', adminOnly, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw bad('اسم الحلقة مطلوب');
  if (db.prepare('SELECT 1 FROM groups WHERE name=?').get(name)) throw bad('اسم الحلقة مستخدم');
  const id = db.prepare('INSERT INTO groups(name,supervisor_id,created_at) VALUES(?,?,?)')
    .run(name, checkSupervisor(req.body.supervisor_id), now()).lastInsertRowid;
  if (req.body.user_ids) putMembers(id, req.body.user_ids);
  res.status(201).json({ group: groupOut(db.prepare('SELECT * FROM groups WHERE id=?').get(id)) });
});

r.patch('/groups/:id', adminOnly, (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id=?').get(Number(req.params.id));
  if (!g) throw notFound();
  const name = req.body.name !== undefined ? String(req.body.name).trim() : g.name;
  if (!name) throw bad('اسم الحلقة مطلوب');
  if (db.prepare('SELECT 1 FROM groups WHERE name=? AND id<>?').get(name, g.id)) throw bad('اسم الحلقة مستخدم');
  const sup = req.body.supervisor_id !== undefined ? checkSupervisor(req.body.supervisor_id) : g.supervisor_id;
  db.prepare('UPDATE groups SET name=?, supervisor_id=? WHERE id=?').run(name, sup, g.id);
  if (req.body.user_ids) putMembers(g.id, req.body.user_ids);
  res.json({ group: groupOut(db.prepare('SELECT * FROM groups WHERE id=?').get(g.id)) });
});

function putMembers(gid, userIds) {
  const ids = [...new Set(userIds.map(Number))];
  tx(() => {
    const cur = new Set(db.prepare('SELECT user_id FROM user_groups WHERE group_id=?').all(gid).map((x) => x.user_id));
    for (const u of cur) if (!ids.includes(u)) db.prepare('DELETE FROM user_groups WHERE group_id=? AND user_id=?').run(gid, u);
    for (const u of ids) {
      if (cur.has(u)) continue;
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(u)) throw bad('مستخدم غير موجود');
      db.prepare('INSERT INTO user_groups(user_id,group_id,joined_at) VALUES(?,?,?)').run(u, gid, now());
    }
  });
}

r.get('/groups/:id/members', staff, (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id=?').get(Number(req.params.id));
  if (!g) throw notFound();
  if (req.user.role === 'supervisor' && g.supervisor_id !== req.user.id) throw forbidden();
  res.json({ user_ids: db.prepare('SELECT user_id FROM user_groups WHERE group_id=?').all(g.id).map((x) => x.user_id) });
});

r.delete('/groups/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare(`SELECT 1 FROM task_assignees WHERE kind='group' AND ref_id=?`).get(id);
  if (used) throw bad('الحلقة مسندة لأوراد؛ أزل الإسناد أولاً');
  db.prepare('DELETE FROM groups WHERE id=?').run(id);
  res.json({ ok: true });
});

export default r;
