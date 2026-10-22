import { h, mount, icon, get, post, fail, toast, busy, state } from './core.js';

let countriesCache;
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));

async function countries() {
  if (!countriesCache) countriesCache = await get('/api/auth/countries');
  return countriesCache;
}

export async function renderLogin(root, onDone) {
  const { default: def, countries: list } = await countries();
  const sorted = [...list].sort((a, b) => (a.code === def ? -1 : b.code === def ? 1 : 0));

  const country = h('select', { class: 'input', 'aria-label': 'رمز الدولة' },
    sorted.map((c) => h('option', { value: c.code, selected: c.code === def }, `${flag(c.code)} ${c.dial}  ${c.name}`)));
  const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', placeholder: '9X XXX XXX', 'aria-label': 'رقم الهاتف', dir: 'ltr' });
  const box = h('div', { class: 'card' });
  let mode = 'otp';

  function phoneStep() {
    const error = h('div', { class: 'err', role: 'alert', hidden: true });
    const pin = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'الرمز السري', 'aria-label': 'الرمز السري' });
    const pinField = h('label', { class: 'field', hidden: mode !== 'pin' }, h('span', { class: 'lbl' }, 'الرمز السري (PIN)'), pin);
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'pin' ? 'دخول' : 'إرسال رمز التحقق عبر واتساب');
    const toggle = h('button', { class: 'btn block', type: 'button', style: 'margin-top:.6rem', onclick: () => { mode = mode === 'otp' ? 'pin' : 'otp'; phoneStep(); } },
      mode === 'otp' ? 'الدخول بالرمز السري' : 'الدخول برمز واتساب');
    const form = h('form', {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault(); error.hidden = true;
        busy(btn, async () => {
          try {
            if (mode === 'pin') {
              const r = await post('/api/auth/login-pin', { phone: phone.value, country: country.value, pin: pin.value });
              return onDone(r.user);
            }
            const r = await post('/api/auth/request-otp', { phone: phone.value, country: country.value });
            otpStep(r);
          } catch (err) { error.textContent = err.message; error.hidden = false; }
        });
      },
    },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'رقم الهاتف'),
        h('div', { class: 'phone-row' }, country, phone),
        h('div', { class: 'hint' }, 'الافتراضي سلطنة عُمان (+968). اكتب الرقم بدون رمز الدولة.')),
      pinField, error, btn, toggle);
    mount(box, h('h2', {}, 'تسجيل الدخول'), h('p', { class: 'muted' }, mode === 'pin' ? 'ادخل برقم هاتفك ورمزك السري.' : 'سنرسل لك رمز تحقق على واتساب. لا حاجة لبريد إلكتروني.'), form);
    phone.focus();
  }

  function otpStep(resp) {
    const error = h('div', { class: 'err', role: 'alert', hidden: true });
    const code = h('input', { class: 'input otp-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', 'aria-label': 'رمز التحقق' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'تأكيد ودخول');
    const resend = h('button', { class: 'btn block', type: 'button', disabled: true, style: 'margin-top:.6rem' }, '');
    let left = 60; let timer;
    const paint = () => { resend.disabled = left > 0; resend.textContent = left > 0 ? `إعادة الإرسال بعد ${left} ثانية` : 'إعادة إرسال الرمز'; };
    paint();
    timer = setInterval(() => { if (--left <= 0) clearInterval(timer); paint(); }, 1000);

    const submit = () => {
      error.hidden = true;
      busy(btn, async () => {
        try { const r = await post('/api/auth/verify-otp', { phone: phone.value, country: country.value, code: code.value }); clearInterval(timer); onDone(r.user); }
        catch (err) { error.textContent = err.message; error.hidden = false; code.select(); }
      });
    };
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) submit(); });
    resend.addEventListener('click', () => busy(resend, async () => {
      const r = await post('/api/auth/request-otp', { phone: phone.value, country: country.value });
      toast('تم إرسال رمز جديد', 'ok'); clearInterval(timer); otpStep(r);
    }));
    mount(box, h('h2', {}, 'أدخل رمز التحقق'),
      h('p', { class: 'muted' }, resp.message),
      resp.dev_code ? h('div', { class: 'dev-banner' }, 'وضع التجربة: الرمز هو ', h('span', { class: 'kbd num' }, resp.dev_code)) : null,
      h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } }, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'الرمز المكوّن من 6 أرقام'), code), error, btn, resend,
        h('button', { class: 'btn block', type: 'button', style: 'margin-top:.6rem', onclick: () => { clearInterval(timer); phoneStep(); } }, 'تغيير رقم الهاتف')));
    code.focus();
  }

  phoneStep();
  mount(root, h('div', { class: 'auth' }, h('div', { class: 'box' },
    h('div', { class: 'hero' }, h('div', { class: 'logo' }, h('img', { src: '/img/logo.png', alt: 'مثاني' })), h('h1', { class: 'sr-only' }, 'مثاني'), h('p', { class: 'muted' }, 'سجّل دخولك لتواصل ذكر الله والدعاء مع إخوانك'), h('p', { class: 'verse small' }, '﴿أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ﴾')),
    box,
    h('p', { style: 'text-align:center;margin-top:1rem' }, 'ليس لديك حساب؟ ', h('a', { href: '#/register' }, 'أنشئ حساباً جديداً')),
    h('p', { style: 'text-align:center;margin-top:.5rem' }, h('a', { class: 'btn', href: '#/site' }, 'العودة إلى الموقع')))));
}
