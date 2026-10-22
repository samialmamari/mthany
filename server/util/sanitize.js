/**
 * تنقية النصوص قبل التخزين (حماية XSS من الطبقة الأولى).
 * العرض في الواجهة يتم دائماً عبر عقد نصية (textContent) فلا يُفسَّر أي HTML أصلاً،
 * ومع ذلك نزيل الوسوم والرموز الخطرة من المحتوى المخزَّن.
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g;

export function stripHtml(s) {
  let out = String(s ?? '');
  let prev;
  do { prev = out; out = out.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z!?][^>]*>/g, ''); } while (out !== prev);
  return out.replace(/javascript\s*:/gi, '').replace(/data\s*:\s*text\/html/gi, '');
}

/** عنوان من سطر واحد */
export function cleanTitle(s, max = 120) {
  return stripHtml(s).replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** نص متعدد الأسطر (فقرات وقوائم بسيطة) */
export function cleanBody(s, max = 5000) {
  return stripHtml(s).replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

export const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
