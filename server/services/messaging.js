/**
 * إرسال الرسائل (OTP والتذكيرات) عبر واتساب مع بديل SMS.
 * المزودون: console (للتجربة) | whatsapp_cloud (Meta) | twilio
 */
import { config } from '../config.js';

const digits = (e164) => e164.replace(/^\+/, '');

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// ---------------- Meta WhatsApp Cloud API ----------------
async function waCloud(to, { text, template, lang, params = [], otp }) {
  const { phoneId, token } = config.wa;
  if (!phoneId || !token) throw new Error('إعدادات WhatsApp Cloud غير مكتملة');
  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (template) {
    const components = [];
    if (params.length) components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) });
    if (otp) { // قالب المصادقة يتطلب زر نسخ الرمز
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(otp) }] });
    }
    body = { messaging_product: 'whatsapp', to: digits(to), type: 'template', template: { name: template, language: { code: lang }, components } };
  } else {
    body = { messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } };
  }
  await postJson(url, body, headers);
}

// ---------------- Twilio ----------------
async function twilio(to, text, whatsapp) {
  const { sid, token, waFrom, smsFrom } = config.twilio;
  if (!sid || !token) throw new Error('إعدادات Twilio غير مكتملة');
  const from = whatsapp ? waFrom : smsFrom;
  if (!from) throw new Error('رقم المرسل في Twilio غير مضبوط');
  const form = new URLSearchParams({ To: whatsapp ? `whatsapp:${to}` : to, From: from, Body: text });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function viaWhatsapp(to, msg) {
  switch (config.provider) {
    case 'whatsapp_cloud': return waCloud(to, msg);
    case 'twilio': return twilio(to, msg.text, true);
    default:
      console.log(`\n[رسالة واتساب (تجريبي) → ${to}]\n${msg.text}\n`);
  }
}

async function viaSms(to, text) {
  if (config.smsFallback === 'twilio') return twilio(to, text, false);
  throw new Error('بديل SMS غير مفعّل');
}

/** يرجع { ok, channel, error } ولا يرمي استثناءً */
async function deliver(to, msg) {
  try {
    await viaWhatsapp(to, msg);
    return { ok: true, channel: config.provider === 'console' ? 'console' : 'whatsapp' };
  } catch (e) {
    const waErr = e.message;
    if (config.smsFallback !== 'none') {
      try { await viaSms(to, msg.text); return { ok: true, channel: 'sms' }; }
      catch (e2) { return { ok: false, channel: null, error: `واتساب: ${waErr} | SMS: ${e2.message}` }; }
    }
    return { ok: false, channel: null, error: waErr };
  }
}

export function sendOtp(phone, code) {
  const text = `مثاني — رمز التحقق الخاص بك: ${code}\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`;
  return deliver(phone, {
    text, otp: code, params: [code],
    template: config.wa.otpTemplate || undefined, lang: config.wa.otpLang,
  });
}

export function sendReminder(phone, { userName, taskTitle, deadlineText }) {
  const text = `مثاني 🌿 تذكير لطيف\n${userName}، لم تسجّل وردك «${taskTitle}» بعد.\nيمكنك تسجيله حتى ${deadlineText}.\nتقبّل الله منك.`;
  return deliver(phone, {
    text, params: [userName, taskTitle],
    template: config.wa.reminderTemplate || undefined, lang: config.wa.reminderLang,
  });
}

// ---------------- إشعارات المجتمع (قوالب عربية) ----------------
const NOTICE = {
  post_published: (p) => `مثاني — موضوعك «${p[0]}» نُشر في المجتمع. شكراً لمساهمتك 🌿`,
  post_needs_edit: (p) => `مثاني — موضوعك «${p[0]}» يحتاج تعديلاً قبل النشر.${p[1] && p[1] !== '-' ? `\nملاحظة الإدارة: ${p[1]}` : ''}\nعدّله وأعد إرساله من صفحة «مواضيعي».`,
  post_rejected: (p) => `مثاني — تم رفض موضوعك «${p[0]}».${p[1] && p[1] !== '-' ? `\nالسبب: ${p[1]}` : ''}`,
  access_activated: (p) => `مثاني — تم تفعيل لوحة المتابعة لدورتك «${p[0]}». ادخل إلى حسابك وابدأ متابعتك 🌿`,
  receipt_rejected: (p) => `مثاني — تعذّر قبول إيصال دورة «${p[0]}».\nالسبب: ${p[1]}\nيمكنك رفع إيصال جديد من حسابك.`,
  gift_card: (p) => `مثاني 🌿\n${p[0]} أهداك مقعداً في «${p[1]}».${p[2] ? `\n«${p[2]}»` : ''}\nاستلم هديتك من هنا: ${p[3]}`,
  gift_reminder: (p) => `مثاني 🌿 تذكير لطيف: ما زالت هديتك في «${p[0]}» بانتظارك.\nاستلمها من هنا: ${p[1]}`,
  gift_sent: (p) => `مثاني — راجعنا إيصالك وأُرسلت هديتك إلى ${p[0]} 🌿 جزاك الله خيراً.`,
  gift_received: (p) => `مثاني — استلم ${p[0]} هديتك «${p[1]}» 🌿 تقبّل الله منك.`,
  gift_rejected: (p) => `مثاني — تعذّر قبول إيصال هديتك إلى ${p[0]}.\nالسبب: ${p[1]}\nيمكنك رفع إيصال جديد من صفحة «هداياي».`,
  review_digest: (p) => `مثاني — لديك ${p[0]} مواضيع بانتظار المراجعة في المجتمع.`,
};

/** يرسل إشعاراً بقالب عربي جاهز: key من NOTICE وparams مصفوفة نصوص */
export function sendNotice(phone, key, params = []) {
  const tpl = config.noticeTemplates[key];
  return deliver(phone, { text: NOTICE[key](params), params, template: tpl || undefined, lang: config.wa.reminderLang });
}
export const NOTICE_KEYS = Object.keys(NOTICE);
