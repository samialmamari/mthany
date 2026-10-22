import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { config } from '../config.js';

/**
 * يحوّل أي إدخال إلى صيغة E.164 أو يُرجع null.
 * يقبل الأرقام العربية/الفارسية، والمسافات والشرطات، و00 كبادئة دولية.
 */
export function normalizePhone(input, country = config.defaultCountry) {
  if (input == null) return null;
  let s = String(input)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const p = s.startsWith('+')
    ? parsePhoneNumberFromString(s)
    : parsePhoneNumberFromString(s, country);
  if (!p || !p.isValid()) return null;
  return p.number; // E.164
}

export function maskPhone(e164) {
  return e164.length > 6 ? e164.slice(0, 4) + '•'.repeat(e164.length - 7) + e164.slice(-3) : e164;
}

export function countryList() {
  const names = new Intl.DisplayNames(['ar'], { type: 'region' });
  return getCountries()
    .map((c) => ({ code: c, dial: '+' + getCountryCallingCode(c), name: names.of(c) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}
