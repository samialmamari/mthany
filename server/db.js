import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,              -- E.164
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','supervisor','user')),
  active INTEGER NOT NULL DEFAULT 1,
  pin_hash TEXT,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',   -- login | change_phone
  user_id INTEGER,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily','monthly','once')),   -- الأوراد كلها يومية
  submit_types TEXT NOT NULL DEFAULT '["count"]',  -- الورد يُسجَّل بعدد دائماً
  days_of_week TEXT,                                -- JSON [0..6] للمهام اليومية (null = كل الأيام)
  month_rule TEXT CHECK (month_rule IN ('day','last_workday')),
  month_day INTEGER,                                -- يوم الاستحقاق للمهام الشهرية
  month_open_day INTEGER,                           -- يوم بدء الإرسال في الشهر (افتراضي 1)
  shift_on_holiday INTEGER NOT NULL DEFAULT 1,      -- نقل الاستحقاق ليوم العمل السابق إن صادف عطلة
  start_time TEXT NOT NULL DEFAULT '00:00',
  deadline_time TEXT NOT NULL DEFAULT '23:59',
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,                         -- أول تاريخ سريان
  end_date TEXT,
  once_deadline_date TEXT,                          -- للمهمة لمرة واحدة (start_date = تاريخ البدء)
  remind_before_min INTEGER,                        -- تذكير تلقائي قبل الموعد بعدد الدقائق
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_pauses (   -- فترات الإيقاف/الأرشفة: لا استحقاقات داخلها
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_date TEXT NOT NULL,
  to_date TEXT                                      -- null = مستمر
);

CREATE TABLE IF NOT EXISTS task_assignees (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('all','group','user')),
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignees_task ON task_assignees(task_id);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occ_date TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  is_late INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  edit_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, user_id, occ_date)
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, occ_date);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  occ_date TEXT NOT NULL,
  mode TEXT NOT NULL,                       -- manual | auto
  channel TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_by INTEGER,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rem ON reminders(task_id, user_id, occ_date, mode);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS community_posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES community_categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_name TEXT,
  image_mime TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','pending','published','rejected','needs_edit','archived')),
  decision_note TEXT NOT NULL DEFAULT '',        -- سبب الرفض أو ملاحظات التعديل
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  published_at INTEGER,
  pinned_at INTEGER,
  delete_requested_at INTEGER,
  auto_published INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON community_posts(status, published_at);
CREATE INDEX IF NOT EXISTS idx_posts_author ON community_posts(author_id, status);

CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)               -- تفاعل واحد لكل مستخدم على كل موضوع
);

CREATE TABLE IF NOT EXISTS post_reports (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at INTEGER NOT NULL,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  UNIQUE (post_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS community_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_bans (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  post_banned INTEGER NOT NULL DEFAULT 0,
  react_banned INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  wa_key TEXT,                                  -- مفتاح قالب واتساب (إن وُجد)
  wa_params TEXT,                               -- JSON
  wa_status TEXT NOT NULL DEFAULT 'none'        -- none | pending | sent | failed | skipped
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_wa ON notifications(wa_status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS library_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS library_files (            -- التنزيلات المجانية
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES library_categories(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,                            -- الاسم الأصلي
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (                 -- المتجر
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('digital','physical')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0,             -- بأصغر وحدة (بيسة: 1 ر.ع = 1000)
  stock INTEGER,                                      -- للمادي؛ null = غير محدود
  image_name TEXT,
  image_mime TEXT,
  file_name TEXT,                                     -- للرقمي: الملف المُسلَّم بعد الدفع
  stored_name TEXT,
  file_mime TEXT,
  file_size INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('new','paid','processing','shipped','delivered','cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod','bank_transfer','free')),
  subtotal_minor INTEGER NOT NULL,
  shipping_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  ship_name TEXT, ship_phone TEXT, ship_city TEXT, ship_address TEXT,
  note TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',               -- رقم الحوالة يدخله العميل
  admin_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paid_at INTEGER, shipped_at INTEGER, delivered_at INTEGER, cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,                                -- لقطة وقت الشراء
  kind TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS courses (                 -- دورات الاستشفاء وخطة العام والعضوية والخلوات
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('remote','year_month','membership','retreat')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  month INTEGER,                                     -- 1..12 لبطاقات خطة العام
  start_date TEXT, end_date TEXT,
  time_label TEXT NOT NULL DEFAULT '',               -- مثل: كل ثلاثاء، 8 مساءً
  place TEXT NOT NULL DEFAULT '',                    -- للخلوات الحضورية
  price_minor INTEGER NOT NULL DEFAULT 0,
  seats INTEGER,                                     -- null = غير محدود
  seats_taken INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','closed','archived')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_kind ON courses(kind, status, sort);

CREATE TABLE IF NOT EXISTS course_registrations (     -- تسجيلات الدورات (من الموقع العام أو إهداءً)
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,                                -- E.164
  note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'self' CHECK (kind IN ('self','gift')),
  gift_from TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  payment_ref TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  UNIQUE (course_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_reg_course ON course_registrations(course_id, status);

CREATE TABLE IF NOT EXISTS daily_messages (          -- رسالة اليوم (آية أو تدبر) تتحكم بها الإدارة
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',                   -- المرجع: السورة والآية أو قائل الأثر
  show_date TEXT,                                    -- تاريخ محدد YYYY-MM-DD، أو NULL للتدوير اليومي
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_date ON daily_messages(show_date, active);
`);

// ---------- ترقية المخطط للقواعد القائمة ----------
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('tasks').includes('sort')) db.exec('ALTER TABLE tasks ADD COLUMN sort INTEGER NOT NULL DEFAULT 0');
if (!cols('tasks').includes('link_url')) db.exec("ALTER TABLE tasks ADD COLUMN link_url TEXT NOT NULL DEFAULT ''");
if (!cols('tasks').includes('target_count')) db.exec('ALTER TABLE tasks ADD COLUMN target_count INTEGER');   // الهدف اليومي (اختياري)
if (!cols('tasks').includes('count_unit')) db.exec("ALTER TABLE tasks ADD COLUMN count_unit TEXT NOT NULL DEFAULT 'مرة'");
if (!cols('tasks').includes('read_text')) db.exec("ALTER TABLE tasks ADD COLUMN read_text TEXT NOT NULL DEFAULT ''");   // نص يُقرأ داخل التطبيق من زر «فتح للقراءة»
if (!cols('tasks').includes('owner_id')) db.exec('ALTER TABLE tasks ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE');   // ورد شخصي: خاص بصاحبه فقط ولا يظهر للإدارة
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id)');
if (!cols('submissions').includes('count')) db.exec('ALTER TABLE submissions ADD COLUMN count INTEGER');
if (!cols('users').includes('wa_notify')) db.exec('ALTER TABLE users ADD COLUMN wa_notify INTEGER NOT NULL DEFAULT 1');
if (!cols('users').includes('quiet_start')) db.exec("ALTER TABLE users ADD COLUMN quiet_start TEXT DEFAULT '22:00'");
if (!cols('users').includes('quiet_end')) db.exec("ALTER TABLE users ADD COLUMN quiet_end TEXT DEFAULT '07:00'");
for (const [c, d] of [['instructor', "TEXT NOT NULL DEFAULT ''"], ['goals', "TEXT NOT NULL DEFAULT '[]'"], ['topics', "TEXT NOT NULL DEFAULT '[]'"],
  ['faq', "TEXT NOT NULL DEFAULT '[]'"], ['schedule', "TEXT NOT NULL DEFAULT '[]'"], ['course_no', 'INTEGER'], ['attend_link', "TEXT NOT NULL DEFAULT ''"], ['attend_note', "TEXT NOT NULL DEFAULT ''"],
  ['duration_label', "TEXT NOT NULL DEFAULT ''"], ['image_name', 'TEXT'], ['image_mime', 'TEXT']]) {
  if (!cols('courses').includes(c)) db.exec(`ALTER TABLE courses ADD COLUMN ${c} ${d}`);
}
for (const [c, d] of [['cover_name', 'TEXT'], ['cover_mime', 'TEXT'], ['meta_label', "TEXT NOT NULL DEFAULT ''"], ['featured', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!cols('library_files').includes(c)) db.exec(`ALTER TABLE library_files ADD COLUMN ${c} ${d}`);
}
if (!cols('users').includes('reminder_time')) db.exec('ALTER TABLE users ADD COLUMN reminder_time TEXT');
if (!cols('users').includes('community_terms_at')) db.exec('ALTER TABLE users ADD COLUMN community_terms_at INTEGER');
if (!cols('users').includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
if (!cols('users').includes('birth_date')) db.exec('ALTER TABLE users ADD COLUMN birth_date TEXT');
if (!cols('users').includes('gender')) db.exec("ALTER TABLE users ADD COLUMN gender TEXT CHECK (gender IN ('male','female'))");
if (!cols('course_registrations').includes('receipt_name')) db.exec('ALTER TABLE course_registrations ADD COLUMN receipt_name TEXT');
if (!cols('course_registrations').includes('receipt_mime')) db.exec('ALTER TABLE course_registrations ADD COLUMN receipt_mime TEXT');
for (const [c, d] of [['pay_phone', "TEXT NOT NULL DEFAULT ''"], ['whatsapp_link', "TEXT NOT NULL DEFAULT ''"], ['thanks_text', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!cols('courses').includes(c)) db.exec(`ALTER TABLE courses ADD COLUMN ${c} ${d}`);
}
for (const [c, d] of [['reject_reason', "TEXT NOT NULL DEFAULT ''"], ['reviewed_at', 'INTEGER'], ['reviewed_by', 'INTEGER']]) {
  if (!cols('course_registrations').includes(c)) db.exec(`ALTER TABLE course_registrations ADD COLUMN ${c} ${d}`);
}
// وصول لوحة المتابعة: الحسابات القائمة مفتوحة، والجديدة من صفحة التسجيل تُفتح بعد قبول الإدارة لإيصالها
if (!cols('users').includes('tracking_access')) db.exec('ALTER TABLE users ADD COLUMN tracking_access INTEGER NOT NULL DEFAULT 1');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

// نظام الإهداء: شخص يدفع رسوم دورة ويُهديها لآخر، فتصله بطاقة برابط يُستعمل مرة واحدة
db.exec(`
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY,
  giver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,
  recipient_contact TEXT NOT NULL,                 -- E.164 أو بريد
  recipient_channel TEXT NOT NULL CHECK (recipient_channel IN ('whatsapp','email')),
  message TEXT NOT NULL DEFAULT '',
  anonymous INTEGER NOT NULL DEFAULT 0,            -- 1 = «من محب» بدون اسم
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','sent','received','declined','transfer_requested')),
  reject_reason TEXT NOT NULL DEFAULT '',
  receipt_name TEXT,
  receipt_mime TEXT,
  token TEXT UNIQUE,
  base_url TEXT NOT NULL DEFAULT '',
  seat_reserved INTEGER NOT NULL DEFAULT 0,        -- يُحجز المقعد عند قبول الإدارة
  delivery TEXT NOT NULL DEFAULT '',               -- whatsapp_sent | whatsapp_failed | manual
  transfer_name TEXT,
  transfer_contact TEXT,
  transfer_channel TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  sent_at INTEGER,
  claimed_at INTEGER,
  claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reminder_at INTEGER,
  alert_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gifts_giver ON gifts(giver_id, id);
CREATE INDEX IF NOT EXISTS idx_gifts_status ON gifts(status, course_id);
`);

// لا تسجيل لاحق: ما سُجّل سابقاً بعد انتهاء وقته يُعامل كمسجَّل في وقته
db.exec('UPDATE submissions SET is_late = 0 WHERE is_late = 1');

// ما لا يخدم فكرة المنصة (ذكر ودعاء ودعم) أُزيل: العطل والإعفاءات ومرفقات الإرسال
for (const t of ['holidays', 'exemptions', 'submission_files']) db.exec(`DROP TABLE IF EXISTS ${t}`);

// رسائل اليوم الافتراضية (تتغير يومياً بالتدوير، وتعدّلها الإدارة)
if (!db.prepare('SELECT 1 FROM daily_messages LIMIT 1').get()) {
  const seed = [
    ['﴿أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ﴾', 'الرعد ٢٨'],
    ['﴿فَاذْكُرُونِي أَذْكُرْكُمْ وَاشْكُرُوا لِي وَلَا تَكْفُرُونِ﴾', 'البقرة ١٥٢'],
    ['﴿وَاذْكُر رَّبَّكَ فِي نَفْسِكَ تَضَرُّعًا وَخِيفَةً﴾', 'الأعراف ٢٠٥'],
    ['﴿إِنَّ الصَّلَاةَ تَنْهَىٰ عَنِ الْفَحْشَاءِ وَالْمُنكَرِ ۗ وَلَذِكْرُ اللَّهِ أَكْبَرُ﴾', 'العنكبوت ٤٥'],
    ['﴿يَا أَيُّهَا الَّذِينَ آمَنُوا اذْكُرُوا اللَّهَ ذِكْرًا كَثِيرًا﴾', 'الأحزاب ٤١'],
    ['﴿وَالذَّاكِرِينَ اللَّهَ كَثِيرًا وَالذَّاكِرَاتِ أَعَدَّ اللَّهُ لَهُم مَّغْفِرَةً وَأَجْرًا عَظِيمًا﴾', 'الأحزاب ٣٥'],
    ['﴿وَاسْتَغْفِرُوا رَبَّكُمْ ثُمَّ تُوبُوا إِلَيْهِ﴾', 'هود ٩٠'],
  ];
  const t = Date.now();
  seed.forEach(([text, source], i) => db.prepare('INSERT INTO daily_messages(text,source,sort,created_at,updated_at) VALUES(?,?,?,?,?)').run(text, source, i, t, t));
}

// تصنيفات المكتبة الافتراضية
if (!db.prepare('SELECT 1 FROM library_categories LIMIT 1').get()) {
  ['أذكار وأدعية مأثورة', 'كتيبات وتدبرات إيمانية', 'جداول متابعة ورقية', 'تسجيلات صوتية'].forEach((n, i) => db.prepare('INSERT INTO library_categories(name,sort) VALUES(?,?)').run(n, i));
}

// تصنيفات المجتمع الافتراضية (مرة واحدة)
if (!db.prepare('SELECT 1 FROM community_categories LIMIT 1').get()) {
  ['طلب دعاء', 'فوائد وأذكار', 'تجارب وتشجيع', 'أسئلة واستفسارات'].forEach((n, i) => db.prepare('INSERT INTO community_categories(name,sort) VALUES(?,?)').run(n, i));
}

// ---------- أدوات مساعدة ----------
export const now = () => Date.now();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

export const placeholders = (arr) => arr.map(() => '?').join(',');
