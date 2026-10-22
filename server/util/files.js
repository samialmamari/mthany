import fs from 'node:fs';
import path from 'node:path';

/** الأنواع المسموحة للمكتبة والمنتجات الرقمية (الامتداد → نوع المحتوى) */
export const FILE_TYPES = {
  pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};
export const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
export const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();

/** يتحقق أن محتوى الملف يطابق امتداده (لا نثق بالامتداد وحده) */
export function validSignature(file) {
  const e = extOf(file.originalname);
  const fd = fs.openSync(file.path, 'r');
  const b = Buffer.alloc(512);
  const n = fs.readSync(fd, b, 0, 512, 0);
  fs.closeSync(fd);
  const s4 = b.subarray(0, 4).toString('latin1');
  switch (e) {
    case 'pdf': return s4 === '%PDF';
    case 'jpg': case 'jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'png': return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'gif': return s4 === 'GIF8';
    case 'webp': return s4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'wav': return s4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE';
    case 'mp3': return b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'm4a': return b.subarray(4, 8).toString('latin1') === 'ftyp';
    case 'zip': case 'docx': return s4 === 'PK\x03\x04';
    case 'txt': return !b.subarray(0, n).includes(0);
    default: return false;
  }
}

export const formatBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(n / 1024))} ك.ب`);
