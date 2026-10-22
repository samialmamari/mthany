import crypto from 'node:crypto';
import { config } from '../config.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', config.secret).update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomCode = (digits = 6) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
