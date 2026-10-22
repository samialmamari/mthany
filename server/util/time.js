import { config } from '../config.js';

const MIN = 60_000;
const DAY = 86_400_000;

/** تاريخ محلي YYYY-MM-DD لطابع زمني UTC (بالمللي ثانية) */
export function localDate(ms = Date.now()) {
  return new Date(ms + config.tzOffsetMin * MIN).toISOString().slice(0, 10);
}

/** تحويل تاريخ محلي + وقت HH:MM إلى مللي ثانية UTC */
export function localToMs(date, hhmm = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - config.tzOffsetMin * MIN;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** اليوم من الأسبوع: 0=الأحد ... 6=السبت */
export function dow(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysInMonth(y, m /* 1-12 */) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function pad(n) { return String(n).padStart(2, '0'); }
export function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

export function* eachDate(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
