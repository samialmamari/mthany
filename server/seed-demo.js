// بيانات تجريبية: node server/seed-demo.js — أعضاء وحلقات وسجل 30 يوماً من أعداد عشوائية للأوراد الافتراضية
import { db, now, tx } from './db.js';
import { ensureAdmin, ensureDefaultAdhkar } from './bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { addDays, localDate } from './util/time.js';
import { ordinalFem } from './services/site.js';

ensureAdmin();
ensureDefaultAdhkar();
const hasUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE role<>'admin'").get().c > 0;
const ago = 30 * 86_400_000;
const mkUser = (name, phone, role) => db.prepare('INSERT INTO users(name,phone,role,created_at) VALUES(?,?,?,?)').run(name, phone, role, now() - ago).lastInsertRowid;
const mkGroup = (name, sup) => db.prepare('INSERT INTO groups(name,supervisor_id,created_at) VALUES(?,?,?)').run(name, sup, now() - ago).lastInsertRowid;
const join = (u, g) => db.prepare('INSERT INTO user_groups(user_id,group_id,joined_at) VALUES(?,?,?)').run(u, g, now() - ago);

const base = { 'الاستغفار': [120, 300], 'الصلاة على النبي': [50, 200], 'تاج الذكر': [30, 100], 'الرقية': [1, 5], 'تلاوة القرآن': [2, 10], 'الاستماع إلى القرآن': [10, 60] };

if (!hasUsers) tx(() => {
  const sup = mkUser('سالم الحارثي', '+96891000001', 'supervisor');
  const sup2 = mkUser('خالد البوسعيدي', '+96891000002', 'supervisor');
  const g1 = mkGroup('حلقة الفجر', sup);
  const g2 = mkGroup('حلقة المغرب', sup2);
  const names = ['أحمد البلوشي', 'مريم الكندي', 'يوسف الرواحي', 'فاطمة الهنائية', 'عبدالله المعمري', 'نورة السيابية'];
  const users = names.map((n, i) => { const id = mkUser(n, `+9689200000${i}`, 'user'); join(id, i < 3 ? g1 : g2); return id; });

  const today = localDate();
  const rate = [0.95, 0.8, 0.6, 0.9, 0.4, 0.7];
  db.prepare('UPDATE tasks SET start_date=?').run(addDays(today, -30));
  users.forEach((uid, i) => {
    for (const [title, [lo, hi]] of Object.entries(base)) {
      const task = db.prepare('SELECT id FROM tasks WHERE title=?').get(title);
      if (!task) continue;
      let v = lo + Math.random() * (hi - lo);
      const drift = (Math.random() - 0.35) * (hi - lo) * 0.04; // اتجاه عام صاعد غالباً
      for (let d = 30; d >= 1; d--) {
        v = Math.min(hi * 1.4, Math.max(lo * 0.3, v + drift + (Math.random() - 0.5) * (hi - lo) * 0.25));
        if (Math.random() > rate[i]) continue; // يوم لم يُسجَّل
        const date = addDays(today, -d);
        const at = Date.parse(`${date}T12:00:00Z`);
        db.prepare('INSERT OR IGNORE INTO submissions(task_id,user_id,occ_date,count,submitted_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(task.id, uid, date, Math.max(1, Math.round(v)), at, at);
      }
    }
  });
});
// ---------- محتوى تجريبي للمكتبة والمتجر ----------
function writeDemo(name, text) {
  const stored = `lib-demo-${name}`;
  fs.writeFileSync(path.join(config.uploadDir, stored), `%PDF-1.4\n% ${text}\n`);
  return stored;
}
if (!db.prepare('SELECT 1 FROM library_files LIMIT 1').get()) {
  const t = now();
  const cat = (n) => db.prepare('SELECT id FROM library_categories WHERE name=?').get(n)?.id ?? null;
  const files = [
    ['أذكار الصباح والمساء', 'ملف PDF منسّق للطباعة بحجم الجيب.', 'أذكار الصباح والمساء', 'adhkar-morning.pdf'],
    ['أدعية من القرآن الكريم', 'مجموعة أدعية مع مواضعها في المصحف.', 'أدعية', 'quran-duaa.pdf'],
    ['ورد المداومة اليومي', 'جدول مطبوع لمتابعة وردك اليومي.', 'عام', 'daily-wird.pdf'],
  ];
  tx(() => {
    for (const [title, desc, c, fname] of files) {
      const stored = writeDemo(fname, title);
      db.prepare(`INSERT INTO library_files(title,description,category_id,file_name,stored_name,mime,size,downloads,created_at,updated_at)
        VALUES(?,?,?,?,?,'application/pdf',?,?,?,?)`).run(title, desc, cat(c), fname, stored,
        fs.statSync(path.join(config.uploadDir, stored)).size, Math.floor(Math.random() * 40), t, t);
    }
    const prods = [
      ['digital', 'كتاب الأذكار (نسخة رقمية)', 'نسخة PDF عالية الجودة للطباعة والقراءة على الجوال.', 2500, null, 'book-adhkar.pdf'],
      ['digital', 'بطاقات أدعية للأطفال', 'بطاقات ملونة جاهزة للطباعة.', 0, null, 'kids-cards.pdf'],
      ['physical', 'سبحة خشبية', 'سبحة من خشب طبيعي، 100 حبة.', 3500, 12, null],
      ['physical', 'كتاب الأذكار (نسخة مطبوعة)', 'غلاف فني، حجم الجيب.', 4000, 25, null],
    ];
    prods.forEach(([kind, title, desc, price, stock, fname], i) => {
      const stored = fname ? writeDemo(fname, title) : null;
      db.prepare(`INSERT INTO products(kind,title,description,price_minor,stock,file_name,stored_name,file_mime,file_size,sort,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, title, desc, price, stock, fname, stored, fname ? 'application/pdf' : null,
        stored ? fs.statSync(path.join(config.uploadDir, stored)).size : null, i, t, t);
    });
  });
}

// ---------- دورات الموقع العام ----------
if (!db.prepare('SELECT 1 FROM courses LIMIT 1').get()) {
  const t = now();
  const add = (c) => db.prepare(
    `INSERT INTO courses(kind,title,summary,description,month,start_date,end_date,time_label,place,price_minor,seats,seats_taken,status,sort,course_no,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(c.kind, c.title, c.summary || '', c.description || '', c.month ?? null, c.start ?? null, c.end ?? null, c.time || '', c.place || '',
    c.price, c.seats ?? null, c.taken ?? 0, c.status || 'open', c.sort ?? 0, c.no ?? null, t, t);

  const d = (n) => addDays(localDate(), n);
  add({ kind: 'remote', title: 'دورة الاستشفاء — الدفعة الثانية عشرة', summary: 'ستة لقاءات مباشرة مع ورد يومي ومتابعة.', time: 'كل ثلاثاء، 8:00 مساءً', start: d(12), end: d(47), price: 15000, seats: 40, taken: 28, sort: 1 });
  add({ kind: 'remote', title: 'الاستشفاء بالقرآن — دورة مكثّفة', summary: 'ثلاثة أيام متتالية في تدبّر آيات الشفاء.', time: 'الخميس إلى السبت، 7:30 مساءً', start: d(25), end: d(27), price: 8000, seats: 30, taken: 27, sort: 2 });
  add({ kind: 'remote', title: 'أذكار الصباح والمساء — لقاء تأسيسي', summary: 'لقاء واحد يضبط لك وردك اليومي.', time: 'السبت، 6:00 مساءً', start: d(6), price: 0, seats: 100, taken: 61, sort: 3 });

  // خطة العام: اثنتا عشرة دورة تبدأ من الدورة العاشرة، منتصف كل شهر ونحو ١٣ يوماً
  let py = Number(localDate().slice(0, 4)); let pm = Number(localDate().slice(5, 7)) + 1; let no = 10;
  if (pm > 12) { pm = 1; py += 1; }
  for (let i = 0; i < 12; i++) {
    const start = `${py}-${String(pm).padStart(2, '0')}-15`;
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + 12 * 86_400_000).toISOString().slice(0, 10);
    add({
      kind: 'year_month', title: `دورة الاستشفاء — الدورة ${ordinalFem(no)}`, month: pm, start, end,
      summary: 'دورة الاستشفاء بالقرآن الكريم، عن بُعد، نحو ١٣ يوماً بعد صلاة العشاء.',
      time: 'بعد صلاة العشاء', price: 5000, seats: 40, sort: no, no,
    });
    pm++; if (pm > 12) { pm = 1; py += 1; }
    no++;
  }

  add({ kind: 'membership', title: 'العضوية الدائمة', summary: 'انتماء مستمر طوال العام: كل الدورات والمكتبة والمجتمع والمتابعة.', price: 45000, sort: 1,
    description: 'حضور جميع الدورات عن بُعد\nخطة العام كاملة\nالمكتبة الرقمية ومنتجاتها بخصم\nمتابعة شخصية لوردك\nأولوية في الخلوات الحضورية' });

  add({ kind: 'retreat', title: 'خلوة الذكر — نزوى', summary: 'يومان من الانقطاع للذكر في جوٍّ هادئ.', place: 'نزوى، سلطنة عُمان', time: 'الجمعة والسبت', start: d(40), end: d(41), price: 25000, seats: 25, taken: 19, sort: 1 });
  add({ kind: 'retreat', title: 'معسكر الاستشفاء — صلالة', summary: 'ثلاثة أيام للتعلّم والتطبيق والراحة.', place: 'صلالة، سلطنة عُمان', time: 'الخميس إلى السبت', start: d(80), end: d(82), price: 35000, seats: 30, taken: 4, sort: 2 });
  console.log('أُضيفت دورات الموقع التعريفي.');
}

console.log(hasUsers ? 'الأعضاء موجودون؛ أُضيف محتوى المكتبة فقط.' : 'تمت إضافة بيانات تجريبية.\nالمدير: +96890000000 | مشرف: +96891000001 | عضو: +96892000000');
