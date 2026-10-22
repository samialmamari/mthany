import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// تحميل .env يدوياً (بلا اعتماد على حزمة إضافية)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && (!env.APP_SECRET || env.APP_SECRET.startsWith('change-me'))) {
  console.error('خطأ: يجب ضبط APP_SECRET بقيمة عشوائية طويلة في بيئة الإنتاج.');
  process.exit(1);
}

export const config = {
  isProd,
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),   // عنوان الموقع العام لروابط الهدايا (مثل https://mathani.example)
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT || 3000),
  secret: env.APP_SECRET || 'dev-only-secret-not-for-production',
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'app.db'),
  uploadDir: env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  tzOffsetMin: Number(env.TZ_OFFSET_MIN ?? 240),
  defaultCountry: env.DEFAULT_COUNTRY || 'OM',
  adminPhone: env.ADMIN_PHONE || '',
  adminName: env.ADMIN_NAME || 'مدير النظام',
  provider: env.MESSAGE_PROVIDER || 'console',
  devShowOtp: !isProd && env.DEV_SHOW_OTP !== '0',
  smsFallback: env.SMS_FALLBACK || 'none',
  wa: {
    phoneId: env.WA_PHONE_NUMBER_ID, token: env.WA_ACCESS_TOKEN,
    otpTemplate: env.WA_OTP_TEMPLATE, otpLang: env.WA_OTP_TEMPLATE_LANG || 'ar',
    reminderTemplate: env.WA_REMINDER_TEMPLATE, reminderLang: env.WA_REMINDER_TEMPLATE_LANG || 'ar',
  },
  // قوالب واتساب (Meta) لإشعارات المجتمع؛ إن تُركت فارغة تُرسل رسالة نصية عادية
  noticeTemplates: {
    post_published: env.WA_TPL_POST_PUBLISHED, post_needs_edit: env.WA_TPL_POST_NEEDS_EDIT,
    post_rejected: env.WA_TPL_POST_REJECTED, review_digest: env.WA_TPL_REVIEW_DIGEST,
    gift_card: env.WA_TPL_GIFT_CARD, gift_reminder: env.WA_TPL_GIFT_REMINDER,
  },
  twilio: {
    sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN,
    waFrom: env.TWILIO_WHATSAPP_FROM, smsFrom: env.TWILIO_SMS_FROM,
  },
  otp: { ttlMs: 5 * 60_000, maxAttempts: 5, resendGapMs: 60_000, maxPerHour: 5 },
  sessionDays: 30,
};
