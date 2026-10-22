import { h, get, post, busy } from './core.js';
import { shell } from './site.js';

const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));

const BENEFITS = [
  ['🌿', 'وردك اليومي', 'سجّل أذكارك وأدعيتك بضغطة، وتابع هدفك كل يوم.'],
  ['📈', 'إحصاءات تقدّمك', 'رسوم بسيطة تريك مواظبتك وأيامك المتتالية.'],
  ['🤲', 'مجتمع داعم', 'تذكير ودعاء مع إخوانك في بيئة هادئة بلا مقارنة.'],
  ['📚', 'مكتبة ودورات', 'مواد نافعة ودورات تعينك على الاستمرار.'],
];

export async function renderRegister(root, onDone) {
  const { default: def, countries: list } = await get('/api/auth/countries');
  const sorted = [...list].sort((a, b) => (a.code === def ? -1 : b.code === def ? 1 : 0));

  const text = (props) => h('input', { class: 's-input', type: 'text', maxlength: 30, ...props });
  const first = text({ autocomplete: 'given-name', placeholder: 'الاسم الأول', 'aria-label': 'الاسم الأول' });
  const father = text({ autocomplete: 'additional-name', placeholder: 'اسم الأب', 'aria-label': 'اسم الأب' });
  const family = text({ autocomplete: 'family-name', placeholder: 'اسم الجد / العائلة', 'aria-label': 'اسم الجد أو العائلة' });
  const country = h('select', { class: 's-input', 'aria-label': 'رمز الدولة' },
    sorted.map((c) => h('option', { value: c.code, selected: c.code === def }, `${flag(c.code)} ${c.dial}  ${c.name}`)));
  const phone = h('input', { class: 's-input', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', placeholder: '9X XXX XXX', 'aria-label': 'رقم الهاتف', dir: 'ltr' });
  const email = h('input', { class: 's-input', type: 'email', autocomplete: 'email', maxlength: 120, placeholder: 'name@example.com', 'aria-label': 'البريد الإلكتروني', dir: 'ltr' });
  const pass = h('input', { class: 's-input', type: 'password', autocomplete: 'new-password', maxlength: 64, placeholder: '8 أحرف على الأقل', 'aria-label': 'كلمة السر' });
  const pass2 = h('input', { class: 's-input', type: 'password', autocomplete: 'new-password', maxlength: 64, placeholder: 'أعد كتابتها', 'aria-label': 'تأكيد كلمة السر' });
  const show = h('label', { class: 's-check' },
    h('input', { type: 'checkbox', onchange: (e) => { pass.type = pass2.type = e.target.checked ? 'text' : 'password'; } }), 'إظهار كلمة السر');

  let gender = '';
  const genderOpts = [['male', 'ذكر'], ['female', 'أنثى']].map(([v, label]) =>
    h('label', { class: 's-choice' }, h('input', { type: 'radio', name: 'gender', value: v, onchange: () => { gender = v; } }), h('span', {}, label)));

  const err = h('p', { class: 's-err', role: 'alert', hidden: true });
  const btn = h('button', { class: 's-btn s-btn-peach s-btn-block', type: 'submit' }, 'إنشاء الحساب');
  const showError = (msg) => { err.textContent = msg; err.hidden = false; err.scrollIntoView({ block: 'center', behavior: 'smooth' }); };

  const group = (title, hint, ...kids) => h('fieldset', { class: 's-group' }, h('legend', {}, title), hint ? h('p', { class: 's-group-hint' }, hint) : null, ...kids);

  const form = h('form', {
    novalidate: true,
    onsubmit: (e) => {
      e.preventDefault(); err.hidden = true;
      if (![first, father, family].every((i) => i.value.trim().length >= 2)) return showError('اكتب اسمك الثلاثي كاملاً');
      if (!gender) return showError('اختر الجنس');
      if (!phone.value.trim()) return showError('اكتب رقم الهاتف');
      if (!email.value || !email.validity.valid) return showError('صيغة البريد الإلكتروني غير صحيحة');
      if (pass.value.length < 8) return showError('كلمة السر يجب ألا تقل عن 8 أحرف');
      if (pass.value !== pass2.value) return showError('كلمتا السر غير متطابقتين');
      busy(btn, async () => {
        try {
          const r = await post('/api/auth/register', {
            name: [first, father, family].map((i) => i.value.trim()).join(' '),
            phone: phone.value, country: country.value, gender, email: email.value, password: pass.value,
          });
          onDone(r.user);
        } catch (ex) { showError(ex.message); }
      });
    },
  },
    group('١ · بياناتك الشخصية', null,
      h('div', { class: 's-field' }, h('span', {}, 'الاسم الثلاثي'), h('div', { class: 's-name3' }, first, father, family)),
      h('div', { class: 's-field' }, h('span', {}, 'الجنس'), h('div', { class: 's-choices', role: 'radiogroup', 'aria-label': 'الجنس' }, genderOpts))),
    group('٢ · وسائل التواصل', null,
      h('label', { class: 's-field' }, h('span', {}, 'رقم الهاتف'), h('div', { class: 's-phone' }, country, phone),
        h('small', {}, 'اكتب الرقم بدون رمز الدولة. الافتراضي سلطنة عُمان (+968).')),
      h('label', { class: 's-field' }, h('span', {}, 'البريد الإلكتروني'), email)),
    group('٣ · حماية حسابك', null,
      h('div', { class: 's-grid2' },
        h('label', { class: 's-field' }, h('span', {}, 'كلمة السر'), pass),
        h('label', { class: 's-field' }, h('span', {}, 'تأكيد كلمة السر'), pass2)),
      show),
    err, btn,
    h('p', { class: 's-note', style: 'text-align:center' }, 'بياناتك خاصة بك ولا تظهر لغيرك.'));

  shell(root, '#/register', [
    h('section', { class: 's-page-head s-pattern' }, h('div', { class: 's-wrap' },
      h('div', { class: 's-eyebrow' }, 'انضم إلى مثاني'),
      h('h1', {}, 'أنشئ حسابك وابدأ رحلتك'),
      h('p', {}, 'دقيقة واحدة تفصلك عن ورد يومي هادئ ومتابعة تعينك على الاستمرار.'))),
    h('section', { class: 's-section' }, h('div', { class: 's-wrap s-reg' },
      h('div', { class: 's-card s-reg-form' }, form,
        h('p', { class: 's-note', style: 'text-align:center' }, 'لديك حساب؟ ', h('a', { href: '#/login' }, 'سجّل دخولك'))),
      h('aside', { class: 's-reg-side', 'aria-label': 'ماذا ستجد في حسابك' },
        h('h2', {}, 'ماذا ستجد في حسابك؟'),
        BENEFITS.map(([ic, t, p]) => h('div', { class: 's-benefit' }, h('span', { class: 's-benefit-ic', 'aria-hidden': 'true' }, ic), h('div', {}, h('h3', {}, t), h('p', {}, p))))))),
  ]);
  first.focus({ preventScroll: true });
}
