/* GoMo Candles — customer sign-in (mobile OTP · email & password · Google) and the account dashboard.
   Loaded as an ES module after shop.js; talks to the shop through window.GomoShop and exposes window.GomoAuth. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, signInWithCustomToken, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, linkWithCredential, linkWithPopup, EmailAuthProvider, signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const S = window.GomoShop;
const CFG = window.GOMO_CONFIG || {};
const { esc, inr } = S;
const X = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GOOGLE = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
const WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3z"/></svg>';

// ------------------------------------------------------------------ Firebase

const fbApp = initializeApp(CFG.FIREBASE);
const auth = getAuth(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});
const google = new GoogleAuthProvider();
google.setCustomParameters({ prompt: 'select_account' });

const state = { user: null, profile: null, can: { otp_channels: [], email_codes: false }, loaded: false };
const listeners = [];
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

function emit() { listeners.forEach((fn) => { try { fn(state.profile); } catch (e) { console.error(e); } }); updateHeader(); }

const FB_ERRORS = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/email-already-in-use': 'An account already exists with this email. Sign in instead, or reset your password.',
  'auth/weak-password': 'Use at least 8 characters for your password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'auth/user-disabled': 'This account has been disabled. Please contact us.',
  'auth/account-exists-with-different-credential': 'This email already has a GoMo account. Sign in with your email and password (or your mobile number) instead.',
  'auth/credential-already-in-use': 'That sign-in already belongs to another GoMo account.',
  'auth/provider-already-linked': 'This sign-in method is already connected.',
  'auth/popup-blocked': 'Your browser blocked the Google window. Please allow pop-ups, or try again.',
  'auth/unauthorized-domain': 'Google sign-in is not enabled for this site yet.',
  'auth/requires-recent-login': 'For your security, please sign out and sign in again, then retry.',
};
const fbMessage = (e) => FB_ERRORS[e?.code] || e?.message?.replace(/^Firebase: /, '').replace(/\s*\(auth\/[^)]+\)\.?/, '') || 'Something went wrong. Please try again.';
const silent = (e) => ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'].includes(e?.code);

async function getToken(force = false) {
  return auth.currentUser ? auth.currentUser.getIdToken(force) : null;
}

async function loadProfile() {
  if (!auth.currentUser) { state.profile = null; emit(); return null; }
  try {
    const d = await S.api('/api/account');
    state.profile = d.profile;
    state.can = d.can || state.can;
  } catch (e) {
    if (e.data?.code === 'account_merged' || e.data?.code === 'account_disabled') {
      await doSignOut(true);
      S.toast(e.message);
      return null;
    }
    throw e;
  }
  emit();
  return state.profile;
}

async function doSignOut(quiet) {
  await fbSignOut(auth).catch(() => {});
  state.user = null; state.profile = null;
  emit();
  if (!quiet) S.toast('Signed out');
}

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  if (user) { try { await loadProfile(); } catch (e) { console.warn('account load failed', e.message); } }
  else { state.profile = null; emit(); }
  state.loaded = true;
  readyResolve();
});

getRedirectResult(auth).then((r) => { if (r?.user) afterSignIn(); }).catch((e) => { if (!silent(e)) setTimeout(() => S.toast(fbMessage(e)), 600); });

// ------------------------------------------------------------------ header button

function updateHeader() {
  const btn = document.getElementById('acctBtn');
  if (!btn) return;
  const p = state.profile;
  btn.setAttribute('aria-label', p ? `Your account${p.pending.length ? ' — details to confirm' : ''}` : 'Sign in');
  btn.querySelector('.dot').hidden = !(p && p.pending.length);
  btn.classList.toggle('signed', !!p);
}

// ------------------------------------------------------------------ shared: code entry

/** 6 digit boxes. `code` (optional) redraws them filled in, e.g. while the code is being checked. */
function codeBoxes(id, code = '', busy = false) {
  const d = String(code || '').replace(/\D/g, '').slice(0, 6);
  return `<div class="otp-boxes${busy ? ' checking' : ''}" id="${id}" role="group" aria-label="6-digit code">${[0, 1, 2, 3, 4, 5].map((i) =>
    `<input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="Digit ${i + 1}" value="${esc(d[i] || '')}"${busy ? ' readonly' : ''} ${i === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'}>`).join('')}</div>`;
}
function bindCodeBoxes(root, onComplete) {
  const boxes = [...root.querySelectorAll('.otp-boxes input')];
  if (!boxes.length) return;
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (digits, from = 0) => {
    digits.split('').forEach((d, i) => { if (boxes[from + i]) boxes[from + i].value = d; });
    const next = boxes.find((b) => !b.value);
    (next || boxes[boxes.length - 1]).focus();
    if (value().length === 6) onComplete(value());
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      const d = b.value.replace(/\D/g, '');
      if (d.length > 1) { b.value = ''; fill(d.slice(0, 6), i); return; }
      b.value = d;
      if (d && boxes[i + 1]) boxes[i + 1].focus();
      if (value().length === 6) onComplete(value());
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && boxes[i - 1]) { boxes[i - 1].focus(); boxes[i - 1].value = ''; e.preventDefault(); }
      if (e.key === 'ArrowLeft' && boxes[i - 1]) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && boxes[i + 1]) boxes[i + 1].focus();
    });
    b.addEventListener('paste', (e) => {
      const d = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      if (d) { e.preventDefault(); fill(d, 0); }
    });
  });
  setTimeout(() => boxes[0].focus({ preventScroll: true }), 50);
}

const SPAM_TIP = '<span class="spam-tip">Not in your inbox? Check your Spam or Promotions folder.</span>';
const channelText = (c) => (c === 'whatsapp' ? 'on WhatsApp' : c === 'sms' ? 'by SMS' : c === 'email' ? 'by email' : '(test mode)');
const normPhone = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
};

function countdown(btn, seconds, label) {
  if (!btn) return;
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    if (!document.body.contains(btn)) return clearInterval(t);
    if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = label; return; }
    btn.textContent = `${label} in ${left}s`;
    left--;
  };
  const t = setInterval(tick, 1000);
  tick();
}

// ------------------------------------------------------------------ sign-in modal

const am = { reason: null, view: 'id', ident: '', emailMode: 'code', phone: '', email: '', name: '', sent: null, busy: false, error: '', info: '', pending: null };

function authModal() {
  let m = document.getElementById('authModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal auth-modal';
    m.id = 'authModal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'authTitle');
    m.innerHTML = '<div class="modal-card"></div>';
    document.body.appendChild(m);
    m.addEventListener('click', onAuthClick);
    m.addEventListener('submit', onAuthSubmit);
    m.addEventListener('input', (e) => {
      if (e.target.id === 'am-pw') return syncIdButton(m);
      if (e.target.id !== 'am-id') return;
      const el = e.target;
      // Autofilled mobiles like "09062656165" or "+91 90626 56165" → "9062656165"; emails are left as typed.
      if (idKind(el.value) === 'phone') {
        let d = el.value.replace(/\D/g, '');
        if ((/^\s*\+/.test(el.value) || d.length >= 12) && d.startsWith('91')) d = d.slice(2);
        d = d.replace(/^0+/, '').slice(0, 10);
        if (d !== el.value) el.value = d;
      }
      am.ident = el.value;
      const kind = idKind(el.value);
      el.inputMode = kind === 'phone' ? 'tel' : 'email';
      const h = m.querySelector('#am-id-hint');
      if (h) h.innerHTML = idHint(kind, otpChannelList().includes('sms'));
      m.querySelector('#am-cc').hidden = kind !== 'phone';
      m.querySelector('#am-id-wrap').className = kind === 'phone' ? 'prefix' : '';
      m.querySelector('#am-pw-field').hidden = kind !== 'email';
      syncIdButton(m);
    });
  }
  return m;
}

/** Checkout needs a verified mobile only once a code channel is configured; until then the number is typed at checkout. */
function needsPhoneVerify(reason) { return reason === 'checkout' && !!state.profile && !state.profile.phone_verified && otpChannelList().length > 0; }

/** Open sign-in. Resolves with the profile when the user is signed in (and, for checkout, has a verified mobile when required). */
function openAuth(reason = 'account') {
  am.reason = reason;
  am.error = ''; am.info = ''; am.busy = false; am.sent = null; am.optional = false;
  if (needsPhoneVerify(reason)) am.view = 'verify_phone';
  else am.view = 'id';
  if (am.view === 'verify_phone') am.phone = state.profile?.phone || '';
  renderAuth();
  S.open(authModal());
  return new Promise((resolve, reject) => {
    if (am.pending) am.pending.reject(new Error('replaced'));
    am.pending = { resolve, reject };
  });
}

function finishAuth() {
  const p = am.pending;
  am.pending = null;
  S.closeAll();
  if (p) p.resolve(state.profile);
  else if (am.reason === 'account') openAccount();
}

const otpOk = () => otpChannelList().length > 0;

function renderAuth() {
  const m = authModal();
  const chans = otpChannelList();
  const otpOk = chans.length > 0;
  const smsOk = chans.includes('sms');
  const title = am.view === 'verify_phone' || am.view === 'verify_code' ? 'Verify your mobile' : 'Sign in to GoMo';
  const lead = am.reason === 'checkout'
    ? (am.view.startsWith('verify') ? 'We deliver to a verified mobile number. It takes 20 seconds.' : 'Sign in to place your order — your cart is saved.')
    : 'Track orders, save addresses and check out faster.';
  const alert = (am.error ? `<div class="alert err" role="alert">${esc(am.error)}</div>` : '') + (am.info ? `<div class="alert ok" role="status">${esc(am.info)}</div>` : '');
  let body = '';
  if (am.view === 'mobile') am.view = 'id'; // old name
  const wantPassword = am.view === 'email' && ['signin', 'signup', 'reset'].includes(am.emailMode);
  if (am.view === 'email' && !wantPassword) am.view = 'id';

  if (am.view === 'id' || am.view === 'email') {
    if (am.view === 'id') {
      // One box: digits → mobile code (WhatsApp, then SMS); "@" → email code. Hint text follows what's configured.
      const hint = otpOk && emailCodesOk() ? 'Email or mobile number' : otpOk ? 'Mobile number' : 'Email';
      const kind = idKind(am.ident);
      body += `<form class="form" id="amId" novalidate>
          <div class="field"><label for="am-id">${hint}</label>
            <div class="${kind === 'phone' ? 'prefix' : ''}" id="am-id-wrap"><span id="am-cc"${kind === 'phone' ? '' : ' hidden'}>+91</span>
            <input id="am-id" name="ident" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="254"
              inputmode="${kind === 'phone' ? 'tel' : 'email'}" placeholder="${otpOk && emailCodesOk() ? 'you@email.com or 98765 43210' : otpOk ? '98765 43210' : 'you@email.com'}" value="${esc(am.ident)}"></div>
            <div class="muted-note" id="am-id-hint" style="text-align:left;margin-top:6px">${idHint(kind, smsOk)}</div></div>
          <div class="field" id="am-pw-field"${kind === 'email' ? '' : ' hidden'}>
            <label for="am-pw">Password <i style="font-weight:400;color:var(--muted)">(optional)</i></label>
            <input id="am-pw" name="password" type="password" autocomplete="current-password" placeholder="Leave empty to get a code instead">
            <div class="auth-links" style="justify-content:flex-end;margin-top:6px"><button type="button" class="link-btn" data-a="forgot">Forgot password?</button></div></div>
          <button type="submit" class="btn btn-rust btn-block" id="am-id-btn"${am.busy ? ' disabled' : ''}>${am.busy ? '<span class="spinner"></span> Please wait…' : 'Get code'}</button></form>`;
    } else {
      const mode = am.emailMode;
      body += `<form class="form" id="amEmail" novalidate>
          ${mode === 'signup' ? `<div class="field"><label for="am-name">Your name</label><input id="am-name" name="name" autocomplete="name" maxlength="80" value="${esc(am.name)}"></div>` : ''}
          <div class="field"><label for="am-email">Email</label><input id="am-email" name="email" type="email" autocomplete="email" maxlength="254" value="${esc(am.email)}"></div>
          ${mode !== 'reset' ? `<div class="field"><label for="am-pass">Password</label><input id="am-pass" name="password" type="password" minlength="8" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></div>` : ''}
          <button type="submit" class="btn btn-rust btn-block"${am.busy ? ' disabled' : ''}>${am.busy ? '<span class="spinner"></span>' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
          <div class="auth-links">
            ${mode === 'signin' ? '<button type="button" class="link-btn" data-a="mode-reset">Forgot password?</button><button type="button" class="link-btn" data-a="mode-signup">New here? Create an account</button>' : '<button type="button" class="link-btn" data-a="use-code">Back to sign in</button>'}
            ${otpOk || emailCodesOk() ? '<button type="button" class="link-btn" data-a="use-code">Sign in with a code instead</button>' : ''}
          </div></form>`;
    }
    body += `<div class="divider"><span>or</span></div>
      <button type="button" class="btn btn-line btn-block google-btn" data-a="google"${am.busy ? ' disabled' : ''}>${GOOGLE} Continue with Google</button>`;
  } else if (am.view === 'code' || am.view === 'verify_code') {
    const s = am.sent || {};
    body = `<p class="auth-sent">Enter the code we sent ${channelText(s.channel)} to <b>${esc(s.masked || '')}</b>
        <button type="button" class="link-btn" data-a="change">Change</button></p>
      ${s.dev_code ? `<p class="dev-code">Test mode code: <b>${esc(s.dev_code)}</b></p>` : ''}
      <form id="amCode" novalidate>${codeBoxes('amBoxes', am.code, am.busy)}
        <button type="submit" class="btn btn-rust btn-block"${am.busy ? ' disabled' : ''}>${am.busy ? '<span class="spinner"></span> Checking…' : 'Verify'}</button></form>
      <div class="auth-links">${s.email || s.channel === 'email' ? SPAM_TIP : ''}<button type="button" class="link-btn" data-a="resend" id="amResend">Resend code</button>
        ${smsOk && !s.email && s.channel !== 'sms' ? '<button type="button" class="link-btn" data-a="sms" id="amSms">Send by SMS instead</button>' : ''}</div>`;
  } else if (am.view === 'verify_phone') {
    body = `<form class="form" id="amVerifyPhone" novalidate>
        <div class="field"><label for="am-vphone">Mobile number</label><div class="prefix"><span>+91</span><input id="am-vphone" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="14" placeholder="98765 43210" value="${esc(am.phone)}"></div></div>
        <button type="submit" class="btn btn-rust btn-block"${am.busy ? ' disabled' : ''}>${am.busy ? '<span class="spinner"></span> Sending…' : 'Send code'}</button>
        <p class="muted-note">Order updates are sent to this number on WhatsApp.</p>
        ${am.optional && am.reason !== 'checkout' ? '<div class="auth-links"><button type="button" class="link-btn" data-a="skip-phone">Skip for now</button></div>' : ''}</form>
      ${otpOk ? '' : `<div class="alert info">Mobile verification is being set up. Meanwhile you can <a href="${esc(S.waOrderLink())}" target="_blank" rel="noopener" style="text-decoration:underline;font-weight:600">order on WhatsApp</a>.</div>`}`;
  }

  m.querySelector('.modal-card').innerHTML =
    `<div class="panel-head"><h3 id="authTitle">${title}</h3><button type="button" class="x-btn" data-a="close" aria-label="Close">${X}</button></div>
     <div class="modal-body auth-body"><p class="auth-lead">${esc(lead)}</p>${alert}${body}</div>`;
  if (am.view === 'code' || am.view === 'verify_code') {
    bindCodeBoxes(m, (code) => verifyCode(code));
    countdown(m.querySelector('#amResend'), am.sent?.resend_in || 30, 'Resend code');
    countdown(m.querySelector('#amSms'), am.sent?.resend_in || 30, 'Send by SMS instead');
  } else {
    setTimeout(() => { const f = m.querySelector('.auth-body input'); if (f) f.focus({ preventScroll: true }); }, 60);
  }
}

function setAm(patch) { Object.assign(am, patch); renderAuth(); }

/** Delivery channels for codes: from the account response when signed in, else from the public catalog. */
function otpChannelList() {
  const a = state.can?.otp_channels || [];
  const b = S.catalog().account?.otp_channels || [];
  return [...new Set([...a, ...b])];
}

/** What the single sign-in box holds: 'email' if it has an @, 'phone' if it is digits, else ''. */
function idKind(v) {
  const t = String(v || '').trim();
  if (t.includes('@')) return 'email';
  const d = t.replace(/[\s\-().+]/g, '');
  return d && /^\d+$/.test(d) ? 'phone' : '';
}
function syncIdButton(m) {
  const b = m.querySelector('#am-id-btn');
  const pw = m.querySelector('#am-pw');
  if (b && !am.busy) b.textContent = idKind(am.ident) === 'email' && pw?.value ? 'Sign in' : 'Get code';
}
function idHint(kind, smsOk) {
  if (kind === 'phone') return `We'll send a 6-digit code on WhatsApp${smsOk ? ' (or SMS)' : ''} to +91 ${esc(normPhone(am.ident) || '…')}`;
  if (kind === 'email') return emailCodesOk() ? "Enter your password, or leave it empty and we'll email you a 6-digit code." : 'Enter your password to sign in.';
  return 'No password needed. We send you a 6-digit code.';
}

const emailCodesOk = () => !!(S.catalog().account?.email_login || state.can?.email_codes);

/** Sign-in by email code (Postal). Used directly, or when the mobile code could not be delivered. */
async function sendEmailCode() {
  const email = String(am.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return setAm({ error: 'Enter a valid email address.' });
  if (!emailCodesOk()) return setAm({ view: 'email', emailMode: 'signin', email, error: '', info: 'Sign in with your email and password.' });
  setAm({ busy: true, error: '' });
  try {
    const sent = await S.api('/api/auth/email/start', { method: 'POST', body: { email } });
    am.code = '';
    setAm({ busy: false, sent: { ...sent, email }, view: 'code' });
  } catch (e) {
    setAm({ busy: false, error: e.message });
  }
}

async function sendCode(channel) {
  const phone = normPhone(am.phone);
  if (!phone) return setAm({ error: 'Enter a valid 10-digit mobile number.' });
  setAm({ busy: true, error: '', info: '' });
  const verifying = am.view === 'verify_phone' || am.view === 'verify_code';
  try {
    const sent = await S.api(verifying ? '/api/account/phone/start' : '/api/auth/otp/start', { method: 'POST', body: { phone, channel } });
    am.code = '';
    setAm({ busy: false, sent: { ...sent, phone }, view: verifying ? 'verify_code' : 'code' });
  } catch (e) {
    if (e.data?.code === 'already_verified') { await loadProfile(); return finishAuth(); }
    const undeliverable = e.data?.code === 'otp_unavailable' || e.data?.code === 'not_on_whatsapp';
    if (!verifying && undeliverable && emailCodesOk()) {
      return setAm({ busy: false, view: 'id', ident: am.email || '', error: '', sent: null,
        info: 'We couldn\'t send a code to your mobile right now. Enter your email instead and we\'ll send the code there.' });
    }
    setAm({ busy: false, error: e.message, sent: am.sent });
  }
}

async function verifyCode(code) {
  if (am.busy) return;
  const phone = am.sent?.phone || normPhone(am.phone);
  am.code = code;
  setAm({ busy: true, error: '' });
  try {
    if (am.view === 'verify_code') {
      const r = await S.api('/api/account/phone/verify', { method: 'POST', body: { phone, code } });
      state.profile = r.profile;
      emit();
      if (r.merged) S.toast(`We combined your earlier account${r.merged.orders ? ` (${r.merged.orders} order${r.merged.orders === 1 ? '' : 's'})` : ''} into this one.`);
      else if (r.orders_linked) S.toast(`Found ${r.orders_linked} earlier order${r.orders_linked === 1 ? '' : 's'} for this number.`);
      am.busy = false;
      return finishAuth();
    }
    if (am.sent?.email) {
      const r = await S.api('/api/auth/email/verify', { method: 'POST', body: { email: am.sent.email, code } });
      await signInWithCustomToken(auth, r.custom_token);
      am.busy = false;
      return afterSignIn(r.is_new, { offerPhone: r.needs_phone });
    }
    const r = await S.api('/api/auth/otp/verify', { method: 'POST', body: { phone, code } });
    await signInWithCustomToken(auth, r.custom_token);
    am.busy = false;
    await afterSignIn(r.is_new);
  } catch (e) {
    am.code = '';
    setAm({ busy: false, error: e.code ? fbMessage(e) : e.message });
    if (e.data?.code === 'code_expired' || e.data?.code === 'locked') setAm({ view: am.view === 'verify_code' ? 'verify_phone' : 'id' });
  }
}

async function afterSignIn(isNew, { offerPhone = false } = {}) {
  try { await loadProfile(); } catch (e) { return setAm({ busy: false, error: e.message }); }
  if (!state.profile) return;
  if (needsPhoneVerify(am.reason)) {
    am.phone = '';
    return setAm({ view: 'verify_phone', busy: false, error: '', sent: null, info: 'Signed in. Now verify your mobile number to order.' });
  }
  // Signed in with an email code and no verified mobile yet: let them choose to add one now or skip.
  if (offerPhone && otpChannelList().length > 0 && !state.profile.phone_verified) {
    am.phone = '';
    return setAm({ view: 'verify_phone', optional: true, busy: false, error: '', sent: null, info: 'You\'re signed in. Add your mobile for WhatsApp order updates, or skip for now.' });
  }
  S.toast(isNew ? 'Welcome to GoMo!' : `Welcome back${state.profile.name ? ', ' + state.profile.name.split(' ')[0] : ''}`);
  finishAuth();
}

async function emailSubmit(form) {
  const email = form.email.value.trim();
  am.email = email;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return setAm({ error: 'Enter a valid email address.' });
  const mode = am.emailMode;
  if (mode === 'reset') {
    setAm({ busy: true, error: '' });
    try { await sendPasswordResetEmail(auth, email); } catch (e) { if (e.code !== 'auth/user-not-found') return setAm({ busy: false, error: fbMessage(e) }); }
    return setAm({ busy: false, view: 'id', ident: email, info: 'If an account exists for this email, we have sent a link to reset the password.' });
  }
  const password = form.password.value;
  if (password.length < 8) return setAm({ error: 'Use at least 8 characters for your password.' });
  if (mode === 'signup') {
    am.name = form.name.value.trim();
    if (am.name.length < 2) return setAm({ error: 'Please enter your name.' });
  }
  setAm({ busy: true, error: '', info: '' });
  try {
    if (mode === 'signup') {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: am.name }).catch(() => {});
      await afterSignIn(true);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      await afterSignIn(false);
    }
  } catch (e) {
    setAm({ busy: false, error: fbMessage(e) });
  }
}

async function passwordSignIn(email, password) {
  setAm({ busy: true, error: '', info: '' });
  try {
    await signInWithEmailAndPassword(auth, email, password);
    await afterSignIn(false);
  } catch (e) {
    setAm({ busy: false, error: fbMessage(e) });
  }
}

async function googleSignIn() {
  setAm({ busy: true, error: '' });
  try {
    await signInWithPopup(auth, google);
    await afterSignIn(false);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      sessionStorage.setItem('gomo_auth_reason', am.reason || 'account');
      return signInWithRedirect(auth, google);
    }
    setAm({ busy: false, error: silent(e) ? '' : fbMessage(e) });
  }
}

function onAuthClick(e) {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  e.preventDefault();
  const a = b.getAttribute('data-a');
  if (a === 'close') { const p = am.pending; am.pending = null; S.closeAll(); if (p) p.reject(new Error('closed')); }
  else if (a === 'use-code') setAm({ view: 'id', error: '', info: '' });
  else if (a === 'forgot') setAm({ view: 'email', emailMode: 'reset', email: am.ident.trim(), error: '', info: '' });
  else if (a.startsWith('mode-')) setAm({ view: 'email', emailMode: a.slice(5), email: am.email || (idKind(am.ident) === 'email' ? am.ident.trim() : ''), error: '', info: '' });
  else if (a === 'google') googleSignIn();
  else if (a === 'change') setAm({ view: am.view === 'verify_code' ? 'verify_phone' : 'id', error: '', sent: null });
  else if (a === 'resend') { if (am.sent?.email) sendEmailCode(); else sendCode('auto'); }
  else if (a === 'skip-phone') { am.optional = false; S.toast(`Welcome${state.profile?.name ? ', ' + state.profile.name.split(' ')[0] : ''}!`); finishAuth(); }
  else if (a === 'sms') sendCode('sms');
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'amId') {
    am.ident = f.ident.value.trim();
    const kind = idKind(am.ident);
    if (kind === 'email') {
      am.email = am.ident;
      const pw = f.password.value;
      if (pw) return passwordSignIn(am.email, pw);
      if (!emailCodesOk()) return setAm({ view: 'email', emailMode: 'signin', email: am.email, error: '', info: 'Enter your password, or create an account if you are new here.' });
      return sendEmailCode();
    }
    if (kind === 'phone') {
      if (!otpOk()) {
        await S.catalogReady?.();
        if (!otpOk()) return setAm({ error: 'Mobile sign-in isn\'t available right now. Please use your email.' });
      }
      am.phone = am.ident; return sendCode('auto');
    }
    return setAm({ error: 'Enter your email or 10-digit mobile number.' });
  }
  if (f.id === 'amVerifyPhone') { am.phone = f.phone.value; sendCode('auto'); }
  else if (f.id === 'amEmail') emailSubmit(f);
  else if (f.id === 'amCode') {
    const code = [...f.querySelectorAll('.otp-boxes input')].map((i) => i.value).join('');
    if (code.length === 6) verifyCode(code); else setAm({ error: 'Enter all 6 digits.' });
  }
}

// ------------------------------------------------------------------ account dashboard

const acc = { orders: null, verify: null, addr: null, link: null, nameEdit: false, error: '', busy: false };

const onAccountPage = () => location.pathname.replace(/\/+$/, '') === '/account';

/** The account page (/account). Same handlers as the old pop-up, rendered into <main id="accountView">. */
function accountModal() {
  const page = onAccountPage() && document.getElementById('accountView');
  if (page) {
    if (!page.dataset.bound) {
      page.dataset.bound = '1';
      page.innerHTML = '<div class="wrap acct-page"><div class="modal-card"></div></div>';
      page.addEventListener('click', onAccountClick);
      page.addEventListener('submit', onAccountSubmit);
      page.addEventListener('input', onAccountInput);
    }
    return page;
  }
  let m = document.getElementById('accountModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal acct-modal';
    m.id = 'accountModal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'acctTitle');
    m.innerHTML = '<div class="modal-card"></div>';
    document.body.appendChild(m);
    m.addEventListener('click', onAccountClick);
    m.addEventListener('submit', onAccountSubmit);
    m.addEventListener('input', onAccountInput);
  }
  return m;
}

async function openAccount() {
  if (!onAccountPage()) { location.href = '/account'; return; }
  await ready;
  if (!state.profile) {
    renderSignedOut();
    try { await openAuth('account-page'); } catch { return; }
    if (!state.profile) return;
  }
  Object.assign(acc, { verify: null, addr: null, link: null, nameEdit: false, error: '' });
  renderAccount();
  try { await loadProfile(); } catch { /* keep the cached profile */ }
  renderAccount();
  try { acc.orders = (await S.api('/api/account/orders')).orders; acc.ordersFailed = false; } catch (e) { acc.orders = []; acc.ordersFailed = true; acc.error = e.message; }
  renderAccount();
}

function verifyPanel(kind) {
  const v = acc.verify;
  if (!v || v.kind !== kind) return '';
  const err = v.error ? `<div class="alert err" role="alert">${esc(v.error)}</div>` : '';
  if (v.step === 'enter') {
    return `<form class="verify-panel" data-verify="${kind}" novalidate>${err}
      <div class="field"><label for="v-phone">Mobile number</label><div class="prefix"><span>+91</span><input id="v-phone" name="phone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel-national" value="${esc(v.phone || '')}"></div></div>
      <div class="vp-actions"><button type="button" class="btn btn-line btn-sm" data-c="vcancel">Cancel</button><button type="submit" class="btn btn-rust btn-sm"${v.busy ? ' disabled' : ''}>${v.busy ? '<span class="spinner"></span>' : 'Send code'}</button></div></form>`;
  }
  return `<form class="verify-panel" data-verify-code="${kind}" novalidate>${err}
    <p class="auth-sent">Code sent ${channelText(v.sent?.channel)} to <b>${esc(v.sent?.masked || '')}</b></p>
    ${v.sent?.dev_code ? `<p class="dev-code">Test mode code: <b>${esc(v.sent.dev_code)}</b></p>` : ''}
    ${codeBoxes(`vb-${kind}`, v.code, v.busy)}
    ${kind === 'email' || v.sent?.channel === 'email' ? `<p class="muted-note">${SPAM_TIP}</p>` : ''}
    <div class="vp-actions"><button type="button" class="link-btn" data-c="vresend" id="vResend">Resend</button>
      ${kind === 'phone' && otpChannelList().includes('sms') && v.sent?.channel !== 'sms' ? '<button type="button" class="link-btn" data-c="vsms" id="vSms">Send by SMS</button>' : ''}
      <button type="button" class="btn btn-line btn-sm" data-c="vcancel">Cancel</button>
      <button type="submit" class="btn btn-rust btn-sm"${v.busy ? ' disabled' : ''}>${v.busy ? '<span class="spinner"></span>' : 'Verify'}</button></div></form>`;
}

function checkItem(ok, title, sub, action, panel) {
  return `<li class="check-item${ok ? ' ok' : ''}"><span class="ci-ic">${ok ? CHECK : '!'}</span>
    <div><b>${title}</b><small>${sub}</small>${panel || ''}</div>${action || ''}</li>`;
}

function renderSignedOut() {
  S.hideLoader?.();
  const m = accountModal();
  document.title = 'Your account — GoMo Candles';
  m.querySelector('.modal-card').innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span aria-current="page">Account</span></nav>
    <div class="ap-signin">
      <span class="ap-avatar" aria-hidden="true">G</span>
      <h1 class="acct-h1">Your account</h1>
      <p class="lead">Sign in to track orders, save addresses and check out faster.</p>
      <button type="button" class="btn btn-rust" data-c="signin">Sign in</button>
      <ul class="ap-perks"><li>Track every order</li><li>Saved addresses</li><li>WhatsApp updates</li></ul>
    </div>`;
}

function renderAccount() {
  const m = accountModal();
  const p = state.profile;
  if (!p) return onAccountPage() ? renderSignedOut() : undefined;
  if (onAccountPage()) { document.title = 'Your account — GoMo Candles'; S.hideLoader?.(); }
  const prov = p.providers || [];
  const hasPassword = prov.includes('password');
  const hasGoogle = prov.includes('google.com');
  const wa = p.whatsapp_status;
  const otpOk = otpChannelList().length > 0;

  const phoneItem = checkItem(p.phone_verified, 'Mobile number',
    p.phone_verified ? `+91 ${esc(p.phone)} · verified ${p.phone_verified_via === 'sms' ? 'by SMS' : p.phone_verified_via === 'whatsapp' ? 'on WhatsApp' : ''}` : 'Needed to place orders and get delivery updates.',
    acc.verify?.kind === 'phone' ? '' : `<button type="button" class="btn btn-${p.phone_verified ? 'line' : 'rust'} btn-sm" data-c="vphone"${otpOk ? '' : ' disabled title="Mobile verification is being set up"'}>${p.phone_verified ? 'Change' : 'Verify'}</button>`,
    verifyPanel('phone'));
  const waItem = p.phone_verified ? checkItem(wa === 'verified', 'WhatsApp',
    wa === 'verified' ? 'Order updates come to your WhatsApp.' : wa === 'unavailable' ? 'This number is not on WhatsApp — we\'ll keep you updated by email.' : 'Confirm so order updates reach you on WhatsApp.',
    wa === 'verified' || acc.verify?.kind === 'whatsapp' || !otpChannelList().some((c) => c === 'whatsapp' || c === 'dev') ? '' : `<button type="button" class="btn btn-${wa === 'unavailable' ? 'line' : 'rust'} btn-sm" data-c="vwa">${wa === 'unavailable' ? 'Check again' : 'Confirm'}</button>`,
    verifyPanel('whatsapp')) : '';
  const emailItem = checkItem(!!(p.email && p.email_verified), 'Email',
    p.email ? (p.email_verified ? `${esc(p.email)} · confirmed` : `${esc(p.email)} · not confirmed yet`) : 'Add an email for order receipts and to sign in with a password.',
    p.email
      ? (p.email_verified || acc.verify?.kind === 'email' ? '' : `<button type="button" class="btn btn-rust btn-sm" data-c="vemail"${state.can.email_codes ? '' : ' disabled title="Email confirmation is being set up"'}>Confirm</button>`)
      : (acc.link ? '' : '<button type="button" class="btn btn-rust btn-sm" data-c="addemail">Add email</button>'),
    verifyPanel('email') + (acc.link ? linkPanel() : '') + (p.email && !p.email_verified && !state.can.email_codes ? '<small class="ci-note">Email confirmation codes will be available soon.</small>' : ''));

  const methods = `<ul class="methods">
    <li><span>${p.phone_verified ? CHECK : '–'}</span>Mobile number (code on WhatsApp / SMS)</li>
    <li><span>${hasPassword ? CHECK : '–'}</span>Email &amp; password ${hasPassword ? '' : p.email ? '' : '<button type="button" class="link-btn" data-c="addemail">Set up</button>'}</li>
    <li><span>${hasGoogle ? CHECK : '–'}</span>Google ${hasGoogle ? '' : '<button type="button" class="link-btn" data-c="linkgoogle">Connect</button>'}</li></ul>`;

  const orders = acc.orders == null ? '<p class="muted">Loading your orders…</p>'
    : acc.ordersFailed ? '<p class="muted">We couldn\u2019t load your orders. <button type="button" class="link-btn" data-c="oreload">Try again</button></p>'
    : !acc.orders.length ? '<p class="muted">No orders yet. <a href="/shop" data-c="shop">Start shopping →</a></p>'
      : `<ul class="order-list">${acc.orders.map((o) => `<li><div><b>${esc(o.order_no)}</b><small>${esc(S.fmtDate(o.created_at))} · ${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</small></div>
          <div class="ol-right">${o.status === 'placed' && o.payment_method === 'razorpay' && o.payment_status === 'pending'
            ? '<span class="status-pill pending">Payment pending</span>' : `<span class="status-pill ${esc(o.status)}">${esc(o.status_label)}</span>`}<b>${inr(o.total)}</b>
          ${o.status === 'placed' && o.payment_method === 'razorpay' && o.payment_status === 'pending' ? `<button type="button" class="btn btn-rust btn-sm" data-c="opay" data-no="${esc(o.order_no)}">Pay now</button>` : ''}
          ${o.status === 'cancelled' && /refund/i.test(o.payment_label || '') ? `<small class="muted">${esc(o.payment_label)}</small>` : ''}
          <button type="button" class="link-btn" data-c="track" data-no="${esc(o.order_no)}">Track</button>
          ${o.can_cancel ? `<button type="button" class="link-btn danger" data-c="ocancel" data-no="${esc(o.order_no)}">Cancel order</button>` : ''}</div></li>`).join('')}</ul>`;

  const addrs = p.addresses || [];
  const addresses = `${addrs.length ? `<ul class="addr-list">${addrs.map((a) => `<li><div><b>${esc(a.label || a.name || 'Address')}${a.default ? ' <em>Default</em>' : ''}</b>
        <small>${esc([a.line1, a.line2, a.landmark].filter(Boolean).join(', '))}<br>${esc(`${a.city}, ${a.state} ${a.pincode}`)}${a.lat ? ' · pinned on map' : ''}</small></div>
        <div class="addr-actions">${a.default ? '' : `<button type="button" class="link-btn" data-c="adefault" data-id="${esc(a.id)}">Make default</button>`}
        <button type="button" class="link-btn" data-c="aedit" data-id="${esc(a.id)}">Edit</button>
        <button type="button" class="link-btn" data-c="adel" data-id="${esc(a.id)}">Remove</button></div></li>`).join('')}</ul>` : '<p class="muted">No saved addresses yet.</p>'}
    ${acc.addr ? addressForm() : addrs.length < 5 ? '<button type="button" class="btn btn-line btn-sm" data-c="anew">+ Add address</button>' : ''}`;

  const nameBlock = acc.nameEdit
    ? `<form id="nameForm" class="name-form"><input name="name" maxlength="80" value="${esc(p.name || '')}" aria-label="Your name" autocomplete="name"><button class="btn btn-rust btn-sm" type="submit">Save</button><button type="button" class="link-btn" data-c="nameoff">Cancel</button></form>`
    : `<b>${esc(p.name || 'Hello!')}</b> <button type="button" class="link-btn" data-c="nameon">${p.name ? 'Edit name' : 'Add your name'}</button>`;

  if (onAccountPage()) {
    // Page layout (/account): profile header, then orders as the main column and details in a sidebar.
    const initial = esc((p.name || p.email || 'G').trim().charAt(0).toUpperCase());
    const contact = [p.phone ? `+91 ${esc(p.phone)}` : '', p.email ? esc(p.email) : ''].filter(Boolean).join(' · ');
    const nOrders = acc.orders ? acc.orders.length : null;
    const todo = p.pending.length;
    m.querySelector('.modal-card').innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span aria-current="page">Account</span></nav>
      ${acc.error ? `<div class="alert err" role="alert">${esc(acc.error)}</div>` : ''}
      <header class="ap-head">
        <span class="ap-avatar" aria-hidden="true">${initial}</span>
        <div class="ap-who"><h1 id="acctTitle" class="ap-name acct-hello">${nameBlock}</h1>
          <p>${contact || 'Welcome to GoMo'}</p></div>
        <div class="ap-stats">
          <span><b>${nOrders == null ? '–' : nOrders}</b>${nOrders === 1 ? 'order' : 'orders'}</span>
          <span><b>${addrs.length}</b>${addrs.length === 1 ? 'address' : 'addresses'}</span>
        </div>
        <button type="button" class="btn btn-line btn-sm ap-signout" data-c="signout">Sign out</button>
      </header>
      ${todo ? `<div class="ap-todo"><b>${todo === 1 ? '1 step left' : `${todo} steps left`}</b> Confirm your details below so we can deliver and keep you updated.</div>` : ''}
      <div class="ap-grid acct-body">
        <div class="ap-main">
          <section class="ap-card"><div class="ap-card-h"><h2>Your orders</h2><a href="/shop" class="link-btn">Shop more →</a></div>${orders}</section>
          <section class="ap-card"><div class="ap-card-h"><h2>Saved addresses</h2></div>${addresses}</section>
        </div>
        <aside class="ap-side">
          <section class="ap-card"><div class="ap-card-h"><h2>${todo ? 'Confirm your details' : 'Your details'}</h2></div><ul class="checklist">${phoneItem}${waItem}${emailItem}</ul></section>
          <section class="ap-card"><div class="ap-card-h"><h2>Ways to sign in</h2></div>${methods}</section>
          <section class="ap-card"><div class="ap-card-h"><h2>Your data</h2></div>
            <p class="muted-note" style="text-align:left;margin:0 0 10px">See our <a href="/privacy-policy">privacy policy</a>.</p>
            <div class="ap-privacy"><button type="button" class="link-btn" data-c="export">Download my data</button>
            <button type="button" class="link-btn danger" data-c="delacct">Delete my account</button></div></section>
        </aside>
      </div>`;
  } else {
  m.querySelector('.modal-card').innerHTML = `
    <div class="panel-head"><h3 id="acctTitle">Your account</h3><button type="button" class="x-btn" data-close aria-label="Close">${X}</button></div>
    <div class="modal-body acct-body">
      ${acc.error ? `<div class="alert err" role="alert">${esc(acc.error)}</div>` : ''}
      <div class="acct-hello">${nameBlock}
        <button type="button" class="link-btn signout" data-c="signout">Sign out</button></div>
      <section><h4>${p.pending.length ? 'Please confirm your details' : 'Your details'}</h4><ul class="checklist">${phoneItem}${waItem}${emailItem}</ul></section>
      <section><h4>Your orders</h4>${orders}</section>
      <section><h4>Saved addresses</h4>${addresses}</section>
      <section><h4>Ways to sign in</h4>${methods}</section>
    </div>`;
  }

  const vf = m.querySelector('[data-verify-code]');
  if (vf) {
    bindCodeBoxes(vf, (code) => verifyAccountCode(code));
    countdown(m.querySelector('#vResend'), acc.verify.sent?.resend_in || 30, 'Resend');
    countdown(m.querySelector('#vSms'), acc.verify.sent?.resend_in || 30, 'Send by SMS');
  }
  if (acc.addr) bindAddressForm(m);
}

function linkPanel() {
  const l = acc.link;
  return `<form class="verify-panel" id="linkForm" novalidate>${l.error ? `<div class="alert err" role="alert">${esc(l.error)}${l.conflict ? ' <button type="button" class="link-btn" data-c="switchacct">Sign in with that email</button>' : ''}</div>` : ''}
    <div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" autocomplete="email" value="${esc(l.email || '')}"></div>
    <div class="field"><label for="l-pass">Choose a password</label><input id="l-pass" name="password" type="password" minlength="8" autocomplete="new-password"></div>
    <div class="vp-actions"><button type="button" class="btn btn-line btn-sm" data-c="linkoff">Cancel</button><button type="submit" class="btn btn-rust btn-sm"${l.busy ? ' disabled' : ''}>${l.busy ? '<span class="spinner"></span>' : 'Save email'}</button></div>
    <p class="muted-note" style="text-align:left">You can then sign in with this email and password too. We'll send a code to confirm it.</p></form>`;
}

async function startVerify(kind, channel = 'auto') {
  const v = acc.verify || { kind };
  v.kind = kind;
  v.busy = true; v.error = '';
  acc.verify = v;
  renderAccount();
  try {
    let path, body;
    if (kind === 'phone') {
      const phone = normPhone(v.phone);
      if (!phone) throw Object.assign(new Error('Enter a valid 10-digit mobile number.'), { keep: true });
      v.phoneNorm = phone;
      path = '/api/account/phone/start'; body = { phone, channel };
    } else path = `/api/account/${kind}/start`;
    v.sent = await S.api(path, { method: 'POST', body });
    v.step = 'code';
  } catch (e) {
    v.error = e.message;
    if (kind === 'phone' && !v.sent) v.step = 'enter';
    if (e.data?.code === 'not_on_whatsapp' || e.data?.code === 'already_verified') { acc.verify = null; await loadProfile().catch(() => {}); S.toast(e.message); }
  }
  v.busy = false;
  renderAccount();
}

async function verifyAccountCode(code) {
  const v = acc.verify;
  if (!v || v.busy) return;
  v.busy = true; v.error = ''; v.code = code;
  renderAccount();
  try {
    const body = v.kind === 'phone' ? { phone: v.phoneNorm, code } : { code };
    const r = await S.api(`/api/account/${v.kind}/verify`, { method: 'POST', body });
    state.profile = r.profile;
    if (v.kind === 'email') await getToken(true).catch(() => {});
    emit();
    S.toast(v.kind === 'phone' ? (r.merged ? 'Mobile verified — your earlier account was combined into this one.' : 'Mobile number verified') : v.kind === 'whatsapp' ? 'WhatsApp confirmed' : 'Email confirmed');
    acc.verify = null;
    if (v.kind === 'phone' && (r.merged || r.orders_linked)) acc.orders = (await S.api('/api/account/orders')).orders;
  } catch (e) {
    v.busy = false; v.error = e.message; v.code = '';
    if (e.data?.code === 'code_expired' || e.data?.code === 'locked') { v.step = v.kind === 'phone' ? 'enter' : 'code'; v.sent = v.kind === 'phone' ? null : v.sent; }
  }
  renderAccount();
}

async function linkEmail(form) {
  const l = acc.link;
  l.email = form.email.value.trim();
  const password = form.password.value;
  l.error = ''; l.conflict = false;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(l.email)) { l.error = 'Enter a valid email address.'; return renderAccount(); }
  if (password.length < 8) { l.error = 'Use at least 8 characters for your password.'; return renderAccount(); }
  l.busy = true; renderAccount();
  try {
    await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(l.email, password));
    await getToken(true);
    await loadProfile();
    acc.link = null;
    S.toast('Email added');
    if (state.can.email_codes) return startVerify('email');
  } catch (e) {
    l.busy = false;
    if (e.code === 'auth/email-already-in-use' || e.code === 'auth/credential-already-in-use') {
      l.conflict = true;
      l.error = 'That email already has a GoMo account. Sign in with it, then verify this mobile number there — we\'ll combine both accounts.';
    } else l.error = fbMessage(e);
  }
  renderAccount();
}

async function linkGoogle() {
  try {
    await linkWithPopup(auth.currentUser, google);
    await getToken(true);
    await loadProfile();
    S.toast('Google connected');
  } catch (e) {
    if (silent(e)) return;
    if (e.code === 'auth/credential-already-in-use' || e.code === 'auth/email-already-in-use') {
      acc.error = 'That Google account already has a GoMo account. Sign in with Google, then verify this mobile number there — we\'ll combine both accounts.';
    } else acc.error = fbMessage(e);
  }
  renderAccount();
}

// ---- addresses (dashboard)

const STATES = () => S.STATES;
function addrField(name, label, opts = {}) {
  const v = acc.addr.values[name] ?? '';
  const err = acc.addr.errors?.[name];
  let input;
  if (name === 'state') input = `<select id="a-state" name="state" autocomplete="address-level1"><option value="">Select…</option>${STATES().map((s) => `<option${s === v ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
  else input = `<input id="a-${name}" name="${name}" value="${esc(v)}"${opts.ac ? ` autocomplete="${opts.ac}"` : ''}${opts.mode ? ` inputmode="${opts.mode}"` : ''} maxlength="${opts.max || 160}">`;
  return `<div class="field${opts.full ? ' full' : ''}${err ? ' invalid' : ''}"><label for="a-${name}">${label}${opts.optional ? ' <i>(optional)</i>' : ''}</label>${input}<div class="err">${esc(err || '')}</div></div>`;
}

function addressForm() {
  const a = acc.addr;
  return `<form class="addr-form" id="addrForm" novalidate>
    ${a.error ? `<div class="alert err" role="alert">${esc(a.error)}</div>` : ''}
    ${window.GomoLocation?.available() ? `<button type="button" class="btn btn-line btn-sm loc-btn" data-c="locate">${LOC_ICON} Use my current location</button><div class="loc-holder" hidden></div>` : ''}
    <div class="form-grid">
      ${addrField('name', 'Recipient name', { ac: 'name', max: 80 })}
      ${addrField('label', 'Label', { optional: true, max: 30 })}
      ${addrField('line1', 'House / flat, street', { ac: 'address-line1', full: true })}
      ${addrField('line2', 'Area / locality', { ac: 'address-line2', full: true, optional: true })}
      ${addrField('landmark', 'Landmark', { optional: true, max: 100 })}
      ${addrField('pincode', 'PIN code', { ac: 'postal-code', mode: 'numeric', max: 6 })}
      ${addrField('city', 'City', { ac: 'address-level2', max: 60 })}
      ${addrField('state', 'State')}
    </div>
    ${a.values.lat ? '<p class="muted-note" style="text-align:left">Map pin saved with this address</p>' : ''}
    <div class="vp-actions"><button type="button" class="btn btn-line btn-sm" data-c="aoff">Cancel</button><button type="submit" class="btn btn-rust btn-sm"${a.busy ? ' disabled' : ''}>${a.busy ? '<span class="spinner"></span>' : 'Save address'}</button></div></form>`;
}
const LOC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/></svg>';

function bindAddressForm(m) {
  const pin = m.querySelector('#a-pincode');
  if (pin) pin.addEventListener('input', () => S.pinAutofill(pin.value, (d) => {
    const vals = acc.addr.values;
    if (!vals.city) vals.city = d.city;
    if (!vals.state && d.state) vals.state = d.state;
    const form = m.querySelector('#addrForm');
    if (form) { if (!form.city.value) form.city.value = d.city || ''; if (!form.state.value && d.state) form.state.value = d.state; }
  }));
}

async function saveAddressForm(form) {
  const a = acc.addr;
  for (const k of ['name', 'label', 'line1', 'line2', 'landmark', 'pincode', 'city', 'state']) a.values[k] = form[k].value.trim();
  a.errors = S.validateAddress(a.values, true);
  if (Object.keys(a.errors).length) return renderAccount();
  a.busy = true; renderAccount();
  try {
    const path = a.id ? `/api/account/addresses/${a.id}` : '/api/account/addresses';
    await S.api(path, { method: a.id ? 'PUT' : 'POST', body: a.values });
    acc.addr = null;
    await loadProfile();
    S.toast('Address saved');
  } catch (e) {
    a.busy = false; a.error = e.message; a.errors = e.data?.fields || {};
  }
  renderAccount();
}

async function onAccountClick(e) {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  const c = b.getAttribute('data-c');
  if (c !== 'shop') e.preventDefault();
  const p = state.profile;
  acc.error = '';
  if (c === 'signout') { S.closeAll(); await doSignOut(); if (onAccountPage()) location.href = '/'; return; }
  if (c === 'shop') return S.closeAll();
  if (c === 'signin') { try { await openAuth('account-page'); } catch { return; } return openAccount(); }
  if (c === 'nameon') { acc.nameEdit = true; return renderAccount(); }
  if (c === 'nameoff') { acc.nameEdit = false; return renderAccount(); }
  if (c === 'vphone') { acc.verify = { kind: 'phone', step: 'enter', phone: '' }; return renderAccount(); }
  if (c === 'vwa') return startVerify('whatsapp');
  if (c === 'vemail') return startVerify('email');
  if (c === 'vcancel') { acc.verify = null; return renderAccount(); }
  if (c === 'export') {
    b.disabled = true;
    try {
      const res = await fetch(String(CFG.API_BASE || '').replace(/\/+$/, '') + '/api/account/export', { headers: { authorization: 'Bearer ' + (await getToken()) } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not download your data.');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: 'gomo-my-data.json' });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { S.toast(e.message); }
    b.disabled = false; return;
  }
  if (c === 'delacct') {
    const typed = prompt('This permanently deletes your GoMo account, saved addresses and sign-in. Past orders are kept only for tax records.\n\nType DELETE to confirm.');
    if (typed !== 'DELETE') return;
    b.disabled = true;
    try {
      await S.api('/api/account/delete', { method: 'POST', body: { confirm: 'DELETE' } });
      S.toast('Your account has been deleted.');
      S.closeAll(); await doSignOut(true); if (onAccountPage()) location.href = '/';
    } catch (e) { S.toast(e.message); b.disabled = false; }
    return;
  }
  if (c === 'oreload') {
    acc.orders = null; renderAccount();
    try { acc.orders = (await S.api('/api/account/orders')).orders; acc.ordersFailed = false; acc.error = ''; } catch (e) { acc.orders = []; acc.ordersFailed = true; }
    return renderAccount();
  }
  if (c === 'opay') {
    const no = b.dataset.no;
    S.closeAll();
    const ord = (acc.orders || []).find((x) => x.order_no === no) || {};
    return S.payOrder(no, ord.phone || (state.profile || {}).phone || '');
  }
  if (c === 'ocancel') {
    const no = b.dataset.no, o = (acc.orders || []).find((x) => x.order_no === no);
    const paid = o && o.payment_status === 'paid';
    if (!confirm(`Cancel order ${no}?${paid ? '\n\nYou paid online, so we will refund you to the same account.' : ''}`)) return;
    b.disabled = true;
    try {
      const r = await S.api(`/api/orders/${encodeURIComponent(no)}/cancel`, { method: 'POST', body: {} });
      S.toast(r.refund_due ? 'Order cancelled. We\'ll review it and refund you to the same account — you\'ll see the status here.' : 'Order cancelled.');
    } catch (e) { S.toast(e.message); }
    try { acc.orders = (await S.api('/api/account/orders')).orders; } catch { /* keep the list */ }
    return renderAccount();
  }
  if (c === 'vresend') return startVerify(acc.verify.kind, 'auto');
  if (c === 'vsms') return startVerify('phone', 'sms');
  if (c === 'addemail') { acc.link = { email: '' }; return renderAccount(); }
  if (c === 'linkoff') { acc.link = null; return renderAccount(); }
  if (c === 'switchacct') {
    const email = acc.link.email; acc.link = null; S.closeAll(); await doSignOut(true);
    if (onAccountPage()) renderSignedOut();
    const done = openAuth(onAccountPage() ? 'account-page' : 'account');
    setAm({ view: 'email', emailMode: 'signin', email, info: 'Sign in with that email to use its account.' });
    try { await done; } catch { return; }
    return onAccountPage() ? openAccount() : undefined;
  }
  if (c === 'linkgoogle') return linkGoogle();
  if (c === 'track') { const no = b.getAttribute('data-no'); S.closeAll(); return S.openTrack(no, p.phone); }
  if (c === 'anew') { acc.addr = { id: null, values: { name: p.name || '' }, errors: {} }; return renderAccount(); }
  if (c === 'aedit') { const a = p.addresses.find((x) => x.id === b.getAttribute('data-id')); acc.addr = { id: a.id, values: { ...a }, errors: {} }; return renderAccount(); }
  if (c === 'aoff') { acc.addr = null; return renderAccount(); }
  if (c === 'adel') {
    if (!confirm('Remove this address?')) return;
    try { await S.api(`/api/account/addresses/${b.getAttribute('data-id')}`, { method: 'DELETE' }); await loadProfile(); } catch (err) { acc.error = err.message; }
    return renderAccount();
  }
  if (c === 'adefault') {
    const a = p.addresses.find((x) => x.id === b.getAttribute('data-id'));
    try { await S.api(`/api/account/addresses/${a.id}`, { method: 'PUT', body: { ...a, default: true } }); await loadProfile(); } catch (err) { acc.error = err.message; }
    return renderAccount();
  }
  if (c === 'locate') {
    const holder = accountModal().querySelector('.loc-holder');
    const form = accountModal().querySelector('#addrForm');
    for (const k of ['name', 'label', 'line1', 'line2', 'landmark', 'pincode', 'city', 'state']) acc.addr.values[k] = form[k].value.trim();
    window.GomoLocation.start(holder, {
      api: S.api,
      onApply: (f) => {
        const vals = acc.addr.values;
        const filled = ['line1', 'line2', 'city', 'state', 'pincode'].some((k) => vals[k]);
        if (filled && !confirm('Replace the address fields with your location?')) { Object.assign(vals, { lat: f.lat, lng: f.lng, accuracy: f.accuracy }); return renderAccount(); }
        Object.assign(vals, f);
        renderAccount();
      },
    });
  }
}

async function onAccountSubmit(e) {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'nameForm') {
    try { const r = await S.api('/api/account', { method: 'PUT', body: { name: f.name.value } }); state.profile = { ...state.profile, name: r.profile.name }; acc.nameEdit = false; emit(); } catch (err) { acc.error = err.message; }
    return renderAccount();
  }
  if (f.id === 'linkForm') return linkEmail(f);
  if (f.id === 'addrForm') return saveAddressForm(f);
  if (f.matches('[data-verify="phone"]')) { acc.verify.phone = f.phone.value; return startVerify('phone'); }
  if (f.matches('[data-verify-code]')) {
    const code = [...f.querySelectorAll('.otp-boxes input')].map((i) => i.value).join('');
    if (code.length === 6) return verifyAccountCode(code);
  }
}

function onAccountInput(e) {
  if (e.target.closest('[data-verify="phone"]') && e.target.name === 'phone' && acc.verify) acc.verify.phone = e.target.value;
}

// ------------------------------------------------------------------ public API

/** Resolve with a profile that satisfies `reason` ('checkout' may need a verified mobile), prompting sign-in as needed. */
async function require(reason = 'checkout') {
  await ready;
  if (state.user && !state.profile) { try { await loadProfile(); } catch (e) { S.toast(e.message); } }
  if (state.profile && !needsPhoneVerify(reason)) return state.profile;
  return openAuth(reason);
}

window.GomoAuth = {
  ready, require, openAccount, openAuth, getToken, refresh: loadProfile, signOut: () => doSignOut(),
  get user() { return state.user; }, get profile() { return state.profile; },
  on(fn) { listeners.push(fn); },
};
const reason = sessionStorage.getItem('gomo_auth_reason');
if (reason) sessionStorage.removeItem('gomo_auth_reason');
document.dispatchEvent(new CustomEvent('gomo-auth-ready'));
ready.then(() => {
  updateHeader();
  if (location.hash === '#account') { location.replace('/account'); return; }
  if (onAccountPage()) openAccount().finally(() => S.hideLoader?.());
});
