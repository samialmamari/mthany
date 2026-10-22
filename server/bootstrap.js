import { db, now } from './db.js';
import { config } from './config.js';
import { normalizePhone } from './util/phone.js';
import { localDate } from './util/time.js';

/** ينشئ أول مدير من متغيرات البيئة إن لم يوجد أي مدير */
export function ensureAdmin() {
  const has = db.prepare(`SELECT 1 FROM users WHERE role='admin' AND active=1`).get();
  if (has) return;
  const phone = normalizePhone(config.adminPhone);
  if (!phone) {
    console.warn('⚠️  لا يوجد مدير للنظام. اضبط ADMIN_PHONE في ملف .env (مثال: +96890000000) ثم أعد التشغيل.');
    return;
  }
  const ex = db.prepare('SELECT id FROM users WHERE phone=?').get(phone);
  if (ex) db.prepare(`UPDATE users SET role='admin', active=1 WHERE id=?`).run(ex.id);
  else db.prepare('INSERT INTO users(name,phone,role,created_at) VALUES(?,?,?,?)').run(config.adminName, phone, 'admin', now());
  console.log(`✔ تم إنشاء مدير النظام: ${phone}`);
}

/** الأوراد الافتراضية للمنصة (تُنشأ مرة واحدة إن لم يوجد أي ورد): كلها يومية بعدد وهدف يمكن للإدارة تعديله */
export const DEFAULT_ADHKAR = [
  { title: 'أذكار الصباح', unit: 'مرة', target: 1 },
  { title: 'أذكار المساء', unit: 'مرة', target: 1 },
  { title: 'الاستغفار', unit: 'مرة', target: 100 },
  { title: 'الصلاة على النبي', unit: 'مرة', target: 100 },
  { title: 'تاج الذكر', unit: 'مرة', target: 100 },
  { title: 'الرقية الشرعية', unit: 'مرة', target: 1 },
  { title: 'تلاوة القرآن', unit: 'صفحة', target: 5 },
  { title: 'الاستماع إلى القرآن', unit: 'دقيقة', target: 15 },
];

export function ensureDefaultAdhkar() {
  if (db.prepare('SELECT 1 FROM tasks LIMIT 1').get()) return;
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const t = now();
  for (const a of DEFAULT_ADHKAR) {
    const id = db.prepare(
      `INSERT INTO tasks(title,description,kind,submit_types,start_time,deadline_time,grace_minutes,start_date,count_unit,target_count,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(a.title, '', 'daily', '["count"]', '00:00', '23:59', 0, localDate(), a.unit, a.target, admin?.id ?? null, t, t).lastInsertRowid;
    db.prepare("INSERT INTO task_assignees(task_id,kind,ref_id,created_at) VALUES(?,'all',NULL,?)").run(id, t);
  }
  console.log('✔ أُنشئت الأوراد الافتراضية (الاستغفار، الصلاة على النبي، تاج الذكر، الرقية، تلاوة القرآن، الاستماع إلى القرآن)');
}
