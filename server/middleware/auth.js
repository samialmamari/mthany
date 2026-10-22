import { db, now } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../util/crypto.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const forbidden = (msg = 'غير مصرّح لك بهذا الإجراء') => new HttpError(403, msg);
export const notFound = (msg = 'العنصر غير موجود') => new HttpError(404, msg);

const COOKIE = 'sid';

export function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, has_pin: !!u.pin_hash, access: u.role !== 'user' || !!u.tracking_access };
}

export function loadSession(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    const row = db.prepare(
      `SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    ).get(sha256(token), now());
    if (row) { req.user = row; req.sessionId = row.session_id; }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'يلزم تسجيل الدخول'));
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'يلزم تسجيل الدخول'));
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

export function startSession(req, res, userId) {
  const token = randomToken();
  const t = now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,user_agent,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(sha256(token), userId, String(req.headers['user-agent'] || '').slice(0, 200), t, t + config.sessionDays * 86_400_000);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: config.sessionDays * 86_400_000, path: '/',
  });
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, userId);
}

export function clearCookie(res) { res.clearCookie(COOKIE, { path: '/' }); }

/** حماية CSRF إضافية: رفض الطلبات المعدِّلة القادمة من أصل مختلف */
export function sameOriginOnly(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return next(forbidden('طلب من مصدر غير موثوق')); }
    catch { return next(forbidden()); }
  }
  next();
}
