import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { randomToken } from './crypto.js';
import { extOf, validSignature } from './files.js';
import { bad, HttpError } from '../middleware/auth.js';

/** إيصال التحويل: صورة أو PDF (يُستعمل للتسجيل في الدورات وللإهداء) */
export const RECEIPT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

export const receiptUpload = multer({
  storage: multer.diskStorage({ destination: config.uploadDir, filename: (_q, f, cb) => cb(null, `rcpt-${randomToken(16)}.${extOf(f.originalname)}`) }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_q, f, cb) => (RECEIPT_TYPES[extOf(f.originalname)] ? cb(null, true) : cb(new HttpError(400, 'الإيصال يجب أن يكون صورة (jpg أو png أو webp) أو ملف PDF'))),
});

export const dropFile = (f) => { if (f) fs.rmSync(f.path, { force: true }); };

/** يفحص الإيصال المرفوع؛ يرمي عند الغياب أو عدم مطابقة المحتوى للامتداد */
export function checkReceipt(file, required) {
  if (!file) { if (required) throw bad('ارفع إيصال التحويل لإتمام التسجيل'); return null; }
  if (!validSignature(file)) throw bad('ملف الإيصال تالف أو غير مطابق لنوعه');
  return { name: path.basename(file.filename), mime: RECEIPT_TYPES[extOf(file.originalname)] };
}
