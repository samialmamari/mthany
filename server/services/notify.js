/**
 * الإشعارات: داخل المنصة دائماً، وعبر واتساب اختيارياً (طابور يحترم خيار المستخدم وساعات الهدوء)،
 * مع ملخص يومي للمراجعين بدل رسالة لكل موضوع.
 */
import { db, now, getSetting } from '../db.js';
import { config } from '../config.js';
import { localDate } from '../util/time.js';
import { NOTICE_KEYS, sendNotice } from './messaging.js';
import { getCS, pendingCountFor, reviewerIds } from './community.js';

/** n = { type, title, body, link, wa?: { key, params } } */
export function notify(userIds, n) {
  const ids = [...new Set(userIds)].filter(Boolean);
  const ins = db.prepare('INSERT INTO notifications(user_id,type,title,body,link,created_at,wa_key,wa_params,wa_status) VALUES(?,?,?,?,?,?,?,?,?)');
  for (const uid of ids) {
    const u = db.prepare('SELECT wa_notify FROM users WHERE id=? AND active=1').get(uid);
    if (!u) continue;
    const wa = n.wa && u.wa_notify ? n.wa : null;
    ins.run(uid, n.type, n.title, n.body || '', n.link || null, now(), wa?.key ?? null, wa ? JSON.stringify(wa.params || []) : null, wa ? 'pending' : 'none');
  }
  if (ids.length && n.wa) setImmediate(() => flushWhatsapp().catch((e) => console.error('[notify]', e)));
}

export function inQuietHours(user, ms = Date.now()) {
  if (!user.quiet_start || !user.quiet_end) return false;
  const d = new Date(ms + config.tzOffsetMin * 60_000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const t = (x) => { const [h, mm] = x.split(':').map(Number); return h * 60 + mm; };
  const s = t(user.quiet_start), e = t(user.quiet_end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

let flushing = false;
/** يرسل رسائل واتساب المعلّقة لمن ليس في ساعات الهدوء؛ ما تجاوز 24 ساعة يُتخطّى */
export async function flushWhatsapp() {
  if (flushing) return;
  flushing = true;
  try {
    const t = now();
    db.prepare("UPDATE notifications SET wa_status='skipped' WHERE wa_status='pending' AND created_at < ?").run(t - 24 * 3_600_000);
    const rows = db.prepare(
      `SELECT n.id, n.wa_key, n.wa_params, u.phone, u.wa_notify, u.quiet_start, u.quiet_end
       FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.wa_status='pending' ORDER BY n.id LIMIT 50`,
    ).all();
    for (const r of rows) {
      if (!r.wa_notify) { db.prepare("UPDATE notifications SET wa_status='skipped' WHERE id=?").run(r.id); continue; }
      if (inQuietHours(r, t)) continue; // يبقى معلّقاً حتى انتهاء ساعات الهدوء
      if (!NOTICE_KEYS.includes(r.wa_key)) { db.prepare("UPDATE notifications SET wa_status='skipped' WHERE id=?").run(r.id); continue; }
      const res = await sendNotice(r.phone, r.wa_key, JSON.parse(r.wa_params || '[]'));
      db.prepare('UPDATE notifications SET wa_status=? WHERE id=?').run(res.ok ? 'sent' : 'failed', r.id);
      if (!res.ok) console.error('[notify] فشل واتساب:', res.error);
    }
  } finally { flushing = false; }
}

/** ملخص يومي للمراجعين بعدد المواضيع المعلّقة (مرة واحدة يومياً بعد الساعة المضبوطة) */
export function runDigest() {
  const cs = getCS();
  if (!cs.enabled || !cs.digest.enabled) return;
  const today = localDate();
  if (getSetting('community_digest_last', '') === today) return;
  const d = new Date(Date.now() + config.tzOffsetMin * 60_000);
  const [hh, mm] = cs.digest.time.split(':').map(Number);
  if (d.getUTCHours() * 60 + d.getUTCMinutes() < hh * 60 + mm) return;
  db.prepare("INSERT INTO settings(key,value) VALUES('community_digest_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(today));
  for (const uid of reviewerIds()) {
    const count = pendingCountFor({ id: uid, role: db.prepare('SELECT role FROM users WHERE id=?').get(uid).role });
    if (!count) continue;
    notify([uid], {
      type: 'review_digest', title: `لديك ${count} مواضيع بانتظار المراجعة`, body: 'ملخص يومي', link: '#/community-admin?tab=pending',
      wa: { key: 'review_digest', params: [String(count)] },
    });
  }
}

export function startNotifyScheduler() {
  const tick = () => { try { runDigest(); } catch (e) { console.error('[digest]', e); } flushWhatsapp().catch((e) => console.error('[notify]', e)); };
  const h = setInterval(tick, 60_000);
  h.unref();
  return () => clearInterval(h);
}
