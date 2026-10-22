import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { normalizePhone, countryList } from '../util/phone.js';
import { isTime } from '../util/time.js';
import { cleanTitle } from '../util/sanitize.js';
import { getCS, reviewerScope } from '../services/community.js';
import { getStore } from '../services/store.js';
import { hmac, safeEqual, randomCode, hashPin, verifyPin } from '../util/crypto.js';
import { sendOtp } from '../services/messaging.js';
import {
  bad, HttpError, publicUser, requireAuth, startSession, clearCookie,
} from '../middleware/auth.js';

const r = Router();
const DUMMY_HASH = hashPin('dummy-for-timing'); // لتقليل فرق التوقيت عند رقم غير موجود

const ipLimit = (max, windowMin = 60) => rateLimit({
  windowMs: windowMin * 60_000, limit: max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة من هذا الجهاز، حاول لاحقاً' },
});

const MSG_GENERIC_SENT = 'إن كان رقمك مسجلاً لدى الإدارة فسيصلك رمز التحقق عبر واتساب خلال لحظات.';

function phoneFrom(body) {
  const p = normalizePhone(body.phone, body.country || config.defaultCountry);
  if (!p) throw bad('صيغة رقم الهاتف غير صحيحة');
  return p;
}

/** يصدر رمزاً جديداً بعد فحص الحدود؛ يرمي HttpError عند التجاوز */
async function issueOtp(phone, purpose, userId) {
  const t = now();
  const last = db.prepare('SELECT created_at FROM otps WHERE phone=? ORDER BY created_at DESC LIMIT 1').get(phone);
  if (last && t - last.created_at < config.otp.resendGapMs) {
    const wait = Math.ceil((config.otp.resendGapMs - (t - last.created_at)) / 1000);
    throw new HttpError(429, `انتظر ${wait} ثانية قبل طلب رمز جديد`, { retry_after: wait });
  }
  const hourly = db.prepare('SELECT COUNT(*) AS c FROM otps WHERE phone=? AND created_at > ?').get(phone, t - 3_600_000).c;
  if (hourly >= config.otp.maxPerHour) throw new HttpError(429, 'تجاوزت الحد المسموح من الطلبات، حاول بعد ساعة');

  const code = randomCode(6);
  db.prepare('UPDATE otps SET used=1 WHERE phone=? AND used=0').run(phone);
  const id = db.prepare('INSERT INTO otps(phone,purpose,user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(phone, purpose, userId ?? null, hmac(phone + ':' + code), t + config.otp.ttlMs, t).lastInsertRowid;
  const sent = await sendOtp(phone, code);
  if (!sent.ok) {
    db.prepare('UPDATE otps SET used=1 WHERE id=?').run(id);
    console.error('[otp] فشل الإرسال:', sent.error);
    throw new HttpError(502, 'تعذّر إرسال الرمز حالياً، حاول لاحقاً');
  }
  return config.devShowOtp ? code : undefined;
}

function checkOtp(phone, purpose, code) {
  const row = db.prepare(
    `SELECT * FROM otps WHERE phone=? AND purpose=? AND used=0 ORDER BY created_at DESC LIMIT 1`,
  ).get(phone, purpose);
  if (!row || row.expires_at < now()) throw bad('الرمز غير صالح أو منتهي، اطلب رمزاً جديداً');
  if (row.attempts >= config.otp.maxAttempts) {
    db.prepare('UPDATE otps SET used=1 WHERE id=?').run(row.id);
    throw bad('تجاوزت عدد المحاولات، اطلب رمزاً جديداً');
  }
  const ok = safeEqual(row.code_hash, hmac(phone + ':' + String(code || '').trim()));
  if (!ok) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id=?').run(row.id);
    const left = config.otp.maxAttempts - row.attempts - 1;
    throw bad(left > 0 ? `الرمز غير صحيح (متبقي ${left} محاولات)` : 'الرمز غير صحيح، اطلب رمزاً جديداً');
  }
  db.prepare('UPDATE otps SET used=1 WHERE id=?').run(row.id);
  return row;
}

r.get('/countries', (_req, res) => res.json({ default: config.defaultCountry, countries: countryList() }));

r.post('/request-otp', ipLimit(20), async (req, res) => {
  const phone = phoneFrom(req.body || {});
  const user = db.prepare('SELECT * FROM users WHERE phone=? AND active=1').get(phone);
  let dev_code;
  if (user) dev_code = await issueOtp(phone, 'login', user.id);
  else await new Promise((ok) => setTimeout(ok, 150 + Math.random() * 150)); // تقليل فرق التوقيت
  res.json({ ok: true, message: MSG_GENERIC_SENT, ttl: config.otp.ttlMs / 1000, dev_code });
});

// ---- تسجيل عضو جديد (بدون تحقق من الهاتف حالياً) ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function registrationFrom(body) {
  const name = cleanTitle(body.name, 100);
  if (name.split(' ').filter((p) => p.length >= 2).length < 3) throw bad('اكتب اسمك الثلاثي كاملاً');
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) throw bad('صيغة البريد الإلكتروني غير صحيحة');
  if (!['male', 'female'].includes(body.gender)) throw bad('اختر الجنس');
  const password = String(body.password || '');
  if (password.length < 8 || password.length > 64) throw bad('كلمة السر يجب أن تكون من 8 إلى 64 حرفاً');
  const phone = phoneFrom(body);
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) throw new HttpError(409, 'هذا الرقم مسجّل مسبقاً، سجّل دخولك بدلاً من ذلك');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'هذا البريد الإلكتروني مسجّل مسبقاً');
  return { name, email, gender: body.gender, password, phone };
}

r.post('/register', ipLimit(20), (req, res) => {
  const f = registrationFrom(req.body || {});
  const id = db.prepare('INSERT INTO users(name,phone,email,gender,pin_hash,created_at,tracking_access) VALUES(?,?,?,?,?,?,0)')
    .run(f.name, f.phone, f.email, f.gender, hashPin(f.password), now()).lastInsertRowid;
  startSession(req, res, id);
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

r.post('/verify-otp', ipLimit(40), (req, res) => {
  const phone = phoneFrom(req.body || {});
  const user = db.prepare('SELECT * FROM users WHERE phone=? AND active=1').get(phone);
  if (!user) throw bad('الرمز غير صالح أو منتهي، اطلب رمزاً جديداً');
  checkOtp(phone, 'login', req.body.code);
  db.prepare('UPDATE users SET pin_failures=0, pin_locked_until=0 WHERE id=?').run(user.id);
  startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

r.post('/login-pin', ipLimit(40), (req, res) => {
  const phone = phoneFrom(req.body || {});
  const pin = String(req.body.pin || '');
  const fail = () => new HttpError(401, 'رقم الهاتف أو الرمز السري غير صحيح');
  const user = db.prepare('SELECT * FROM users WHERE phone=? AND active=1').get(phone);
  if (!user || !user.pin_hash) { verifyPin(pin, DUMMY_HASH); throw fail(); }
  if (user.pin_locked_until > now()) {
    throw new HttpError(429, `الحساب مقفل مؤقتاً بسبب محاولات خاطئة، حاول بعد ${Math.ceil((user.pin_locked_until - now()) / 60000)} دقيقة أو ادخل برمز واتساب`);
  }
  if (!verifyPin(pin, user.pin_hash)) {
    const f = user.pin_failures + 1;
    db.prepare('UPDATE users SET pin_failures=?, pin_locked_until=? WHERE id=?')
      .run(f >= 5 ? 0 : f, f >= 5 ? now() + 15 * 60_000 : 0, user.id);
    throw fail();
  }
  db.prepare('UPDATE users SET pin_failures=0, pin_locked_until=0 WHERE id=?').run(user.id);
  startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

r.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const groups = db.prepare(`SELECT g.id, g.name FROM groups g JOIN user_groups ug ON ug.group_id=g.id WHERE ug.user_id=?`).all(req.user.id);
  res.json({ user: { ...publicUser(req.user), groups, prefs: { wa_notify: !!req.user.wa_notify, quiet_start: req.user.quiet_start, quiet_end: req.user.quiet_end, reminder_time: req.user.reminder_time } }, server: { tz_offset_min: config.tzOffsetMin, now: now() }, community: { enabled: getCS().enabled, reviewer: !!reviewerScope(req.user), admin: req.user.role === 'admin' }, store: { enabled: getStore().enabled } });
});

// تفضيلات الإشعارات: واتساب وساعات الهدوء
r.patch('/prefs', requireAuth, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const qs = b.quiet_start === undefined ? u.quiet_start : (b.quiet_start || null);
  const qe = b.quiet_end === undefined ? u.quiet_end : (b.quiet_end || null);
  for (const v of [qs, qe]) if (v && !isTime(v)) throw bad('صيغة الوقت غير صحيحة');
  if (!!qs !== !!qe) throw bad('حدّد بداية الهدوء ونهايته معاً أو اتركهما فارغين');
  const wa = b.wa_notify === undefined ? u.wa_notify : (b.wa_notify ? 1 : 0);
  let rt = b.reminder_time === undefined ? u.reminder_time : (b.reminder_time || null);
  if (rt && !isTime(rt)) throw bad('صيغة وقت التذكير غير صحيحة');
  db.prepare('UPDATE users SET wa_notify=?, quiet_start=?, quiet_end=?, reminder_time=? WHERE id=?').run(wa, qs, qe, rt, u.id);
  res.json({ ok: true, prefs: { wa_notify: !!wa, quiet_start: qs, quiet_end: qe, reminder_time: rt } });
});

r.post('/logout', (req, res) => {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id=?').run(req.sessionId);
  clearCookie(res);
  res.json({ ok: true });
});

r.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
  clearCookie(res);
  res.json({ ok: true });
});

r.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, user_agent, created_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC')
    .all(req.user.id, now());
  res.json({ sessions: rows.map((s) => ({ ...s, current: s.id === req.sessionId })) });
});

// ---- PIN اختياري ----
r.post('/pin', requireAuth, (req, res) => {
  const { pin, current } = req.body || {};
  const u = req.user;
  if (u.pin_hash && !verifyPin(String(current || ''), u.pin_hash)) throw bad('الرمز السري الحالي غير صحيح');
  if (pin == null || pin === '') {
    db.prepare('UPDATE users SET pin_hash=NULL WHERE id=?').run(u.id);
    return res.json({ ok: true, has_pin: false });
  }
  if (String(pin).length < 4 || String(pin).length > 64) throw bad('الرمز السري يجب ألا يقل عن 4 أحرف');
  db.prepare('UPDATE users SET pin_hash=?, pin_failures=0, pin_locked_until=0 WHERE id=?').run(hashPin(pin), u.id);
  res.json({ ok: true, has_pin: true });
});

// ---- تغيير رقم الهاتف (يتطلب تحققاً من الرقم الجديد) ----
r.post('/change-phone/request', requireAuth, ipLimit(10), async (req, res) => {
  const phone = phoneFrom(req.body || {});
  if (phone === req.user.phone) throw bad('هذا هو رقمك الحالي');
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) throw new HttpError(409, 'هذا الرقم مسجل لمستخدم آخر');
  const dev_code = await issueOtp(phone, 'change_phone', req.user.id);
  res.json({ ok: true, ttl: config.otp.ttlMs / 1000, dev_code });
});

r.post('/change-phone/confirm', requireAuth, ipLimit(20), (req, res) => {
  const phone = phoneFrom(req.body || {});
  const row = checkOtp(phone, 'change_phone', req.body.code);
  if (row.user_id !== req.user.id) throw bad('الرمز غير صالح');
  if (db.prepare('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, req.user.id)) throw new HttpError(409, 'هذا الرقم مسجل لمستخدم آخر');
  db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(req.user.id, req.sessionId); // خروج بقية الأجهزة
  res.json({ ok: true, phone });
});

export default r;
