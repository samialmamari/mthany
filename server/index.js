import { config } from './config.js';
import './db.js';
import { createApp } from './app.js';
import { ensureAdmin, ensureDefaultAdhkar } from './bootstrap.js';
import { startReminderScheduler } from './services/reminders.js';
import { startNotifyScheduler } from './services/notify.js';
import { startReceiptPurge } from './services/registrations.js';
import { startGiftScheduler } from './services/gifts.js';
import { db } from './db.js';

ensureAdmin();
ensureDefaultAdhkar();
const app = createApp();
startReminderScheduler();
startNotifyScheduler();
startReceiptPurge();
startGiftScheduler();

// تنظيف دوري لرموز OTP والجلسات المنتهية
setInterval(() => {
  const t = Date.now();
  db.prepare('DELETE FROM otps WHERE created_at < ?').run(t - 24 * 3_600_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
}, 3_600_000).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n  منصة مثاني لمواصلة الذكر والدعاء تعمل على: http://localhost:${config.port}`);
  console.log(`  مزود الرسائل: ${config.provider}${config.provider === 'console' ? '  (الرموز تظهر هنا في السجل)' : ''}\n`);
});
