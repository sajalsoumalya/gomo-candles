import { HttpError } from './util.js';
import { isValidEmail, normalizePhone, INDIAN_STATES } from './validate.js';

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
import { db } from './db.js';

export const EVENTS = ['order_placed', 'payment_received', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'admin_new_order'];

// WhatsApp uses its own formatting: *bold*, _italic_. Keep lines short; customers read these on a phone.
const SIGN = '\n\nWarm regards,\n*Team {{store_name}}* 🕯️\n_More than a candle. A moment of peace._';
export const DEFAULT_TEMPLATES = {
  order_placed: {
    whatsapp: '🕯️ *Thank you for your order, {{name}}!*\n\nWe\'ve received your order and it\'s now in our hands.\n\n*Order no:* {{order_no}}\n━━━━━━━━━━━━━━━\n{{items}}\n━━━━━━━━━━━━━━━\n{{discount_line}}Shipping: {{shipping}}\n*Total: {{total}}*\nPayment: {{payment}}\n\n📍 *Delivering to*\n{{address}}\n\nWe\'ll confirm your order shortly and keep you updated at every step.\n\n🔎 Track your order: {{track_link}}' + SIGN,
    email_subject: 'Thank you for your order {{order_no}} — {{store_name}}',
    email_intro: 'Hi {{name}},\n\nThank you for choosing {{store_name}}. We\'ve received your order and will confirm it shortly. Here\'s a summary for your records.',
  },
  payment_received: {
    whatsapp: '✅ *Payment received*\n\nHi {{name}}, we\'ve received your payment of *{{total}}* for order *{{order_no}}*. Thank you!\n\nYour order is being prepared with care.\n\n🔎 Track: {{track_link}}' + SIGN,
    email_subject: 'Payment received — order {{order_no}}',
    email_intro: 'Hi {{name}},\n\nWe\'ve received your payment of {{total}}. Thank you! Your order is now being prepared with care.',
  },
  confirmed: {
    whatsapp: '✨ *Your order is confirmed*\n\nHi {{name}}, great news — order *{{order_no}}* is confirmed and our team is now hand-preparing it for you.\n\n🔎 Track: {{track_link}}' + SIGN,
    email_subject: 'Your order {{order_no}} is confirmed',
    email_intro: 'Hi {{name}},\n\nGreat news — your order is confirmed. Our team is now hand-preparing it for you.',
  },
  packed: {
    whatsapp: '🎁 *Packed with care*\n\nHi {{name}}, your order *{{order_no}}* has been carefully packed and will be handed to our courier partner soon.\n\n🔎 Track: {{track_link}}' + SIGN,
    email_subject: 'Your order {{order_no}} is packed',
    email_intro: 'Hi {{name}},\n\nYour order has been carefully packed and will be on its way very soon.',
  },
  shipped: {
    whatsapp: '🚚 *Your order is on its way!*\n\nHi {{name}}, order *{{order_no}}* has been shipped.\n\n{{shipping_info}}\n\n🔎 Track: {{track_link}}' + SIGN,
    email_subject: 'Your order {{order_no}} has shipped',
    email_intro: 'Hi {{name}},\n\nGood news — your order is on its way! You\'ll find the courier and tracking details below.',
  },
  out_for_delivery: {
    whatsapp: '📦 *Out for delivery today*\n\nHi {{name}}, your order *{{order_no}}* is out for delivery and will reach you today.\n{{cod_note}}\n\n🔎 Track: {{track_link}}' + SIGN,
    email_subject: 'Arriving today — order {{order_no}}',
    email_intro: 'Hi {{name}},\n\nYour order is out for delivery and will reach you today.',
  },
  delivered: {
    whatsapp: '🌿 *Delivered — enjoy your moment of peace*\n\nHi {{name}}, your order *{{order_no}}* has been delivered.\n\nWe hope it brings calm and warmth to your space. If anything isn\'t right, just reply to this message — we\'re happy to help.\n\nThank you for choosing {{store_name}} 💛' + SIGN,
    email_subject: 'Delivered — order {{order_no}}',
    email_intro: 'Hi {{name}},\n\nYour order has been delivered. We hope it brings calm and warmth to your space.\n\nIf anything isn\'t quite right, simply reply to this email — we\'re always happy to help.',
  },
  cancelled: {
    whatsapp: '*Order cancelled*\n\nHi {{name}}, your order *{{order_no}}* has been cancelled.\n\nIf this was unexpected or you need any help, please message us at {{store_whatsapp}} — we\'re here for you.' + SIGN,
    email_subject: 'Your order {{order_no}} has been cancelled',
    email_intro: 'Hi {{name}},\n\nYour order has been cancelled. If this was unexpected, or if you\'d like help placing a new order, simply reply to this email or WhatsApp us at {{store_whatsapp}}.',
  },
  admin_new_order: {
    whatsapp: '🛎️ *New order {{order_no}}*\n\n*{{total}}* · {{payment}}\n👤 {{full_name}} · +91 {{phone}}\n\n{{items}}\n\n📍 {{address}}',
    email_subject: '🛎️ New order {{order_no}} — {{total}} ({{payment}})',
    email_intro: 'A new order has been placed by {{full_name}} (+91 {{phone}}).',
  },
};

export const DEFAULT_OTP_MESSAGE = '🔐 *{{code}}* is your {{store_name}} verification code.\n\nIt is valid for {{minutes}} minutes. For your security, please do not share this code with anyone — our team will never ask for it.';

export const DEFAULT_SETTINGS = {
  store: { name: 'GoMo Candles', whatsapp: '', email: 'support@earthenbeauty.in', shop_url: '' },
  shipping: { free_above: 999, include_equal: false, fee: 0, prepaid_fee: null },
  payments: { cod: true, razorpay: false },
  // GST invoices. Leave gstin empty to print a plain "Invoice" without tax lines.
  invoice: { legal_name: '', gstin: '', address: '', state: '', hsn: '3406', gst_rate: 5, prefix: 'GM' },
  notify: { customer_whatsapp: true, customer_email: true, admin_whatsapp: [], admin_emails: [] },
  templates: DEFAULT_TEMPLATES,
  otp: { whatsapp_first: true, sms_fallback: true, daily_sms_cap: 300, message: DEFAULT_OTP_MESSAGE, turnstile_site_key: '' },
  sms: { provider: 'none', sender_id: '', template_id: '', var_name: 'otp', custom: { url: '', method: 'POST', headers: '', body: '', success_match: '' } },
};

export const SMS_PROVIDER_IDS = ['none', 'msg91', 'fast2sms', '2factor', 'custom'];

const KEYS = Object.keys(DEFAULT_SETTINGS);

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined ? base : over;
}

export async function getSettings(env) {
  const stored = (await db(env).get('settings')) || {};
  const s = {};
  for (const k of KEYS) s[k] = merge(DEFAULT_SETTINGS[k], stored[k]);
  if (!s.store.shop_url && env.SHOP_URL) s.store.shop_url = env.SHOP_URL;
  if (s.shipping.free_above === -1) s.shipping.free_above = null;
  return s;
}

export function integrations(env) {
  return {
    postal: Boolean(env.POSTAL_URL && env.POSTAL_API_KEY && env.MAIL_FROM),
    openwa: Boolean(env.OPENWA_URL),
    razorpay: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    razorpay_webhook: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
    sms_key: Boolean(env.SMS_API_KEY),
    otp_secret: Boolean(env.OTP_SECRET),
    turnstile: Boolean(env.TURNSTILE_SECRET),
    s3: Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
    s3_public: Boolean(env.S3_PUBLIC_URL),
  };
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate an admin settings update; returns {key: value} for the keys supplied. */
export function validateSettingsInput(body, env, current) {
  const fields = {};
  const out = {};

  if (body.store) {
    const st = body.store;
    const whatsapp = String(st.whatsapp ?? '').replace(/\D/g, '');
    if (whatsapp && !/^\d{10,15}$/.test(whatsapp)) fields['store.whatsapp'] = 'Use country code + number, e.g. 919876543210.';
    const email = str(st.email, 254);
    if (email && !isValidEmail(email)) fields['store.email'] = 'Invalid email.';
    const shop_url = str(st.shop_url, 200).replace(/\/+$/, '');
    if (shop_url && !/^https?:\/\/[^\s]+$/.test(shop_url)) fields['store.shop_url'] = 'Must start with https://';
    out.store = { name: str(st.name, 80) || DEFAULT_SETTINGS.store.name, whatsapp, email, shop_url };
  }

  if (body.shipping) {
    const fa = body.shipping.free_above;
    const free_above = fa === '' || fa == null ? null : Number(fa);
    const fee = Number(body.shipping.fee);
    if (free_above != null && (!Number.isInteger(free_above) || free_above < 0)) fields['shipping.free_above'] = 'Whole rupees, 0 or more, or empty.';
    if (!Number.isInteger(fee) || fee < 0 || fee > 5000) fields['shipping.fee'] = 'Whole rupees, 0–5000.';
    const pf = body.shipping.prepaid_fee;
    const prepaid_fee = pf === '' || pf == null ? null : Number(pf);
    if (prepaid_fee != null && (!Number.isInteger(prepaid_fee) || prepaid_fee < 0 || prepaid_fee > 5000)) fields['shipping.prepaid_fee'] = 'Whole rupees, 0–5000, or empty.';
    // the database drops nulls (and the default would come back), so "never free" is stored as -1
    out.shipping = { free_above: free_above ?? -1, fee, include_equal: Boolean(body.shipping.include_equal), prepaid_fee };
  }

  if (body.payments) {
    const cod = Boolean(body.payments.cod);
    const razorpay = Boolean(body.payments.razorpay);
    if (razorpay && !integrations(env).razorpay) fields['payments.razorpay'] = 'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as Worker secrets first.';
    if (!cod && !razorpay) fields['payments.cod'] = 'Keep at least one payment method on.';
    out.payments = { cod, razorpay };
  }

  if (body.invoice) {
    const iv = body.invoice;
    const gstin = str(iv.gstin, 15).toUpperCase();
    if (gstin && !GSTIN_RE.test(gstin)) fields['invoice.gstin'] = 'Enter a valid 15-character GSTIN, e.g. 19ABCDE1234F1Z5.';
    const state = str(iv.state, 60);
    const stateOk = !state || INDIAN_STATES.includes(state);
    if (!stateOk) fields['invoice.state'] = 'Choose a state from the list.';
    if (gstin && !state) fields['invoice.state'] = 'Needed with a GSTIN, to choose CGST + SGST or IGST.';
    const address = str(iv.address, 300);
    if (gstin && !address) fields['invoice.address'] = 'Needed on a tax invoice.';
    const hsn = str(String(iv.hsn ?? ''), 8);
    if (!/^\d{4,8}$/.test(hsn)) fields['invoice.hsn'] = '4 to 8 digits, e.g. 3406.';
    const gst_rate = Number(iv.gst_rate);
    if (!Number.isFinite(gst_rate) || gst_rate < 0 || gst_rate > 40 || Math.round(gst_rate * 100) !== gst_rate * 100) fields['invoice.gst_rate'] = 'A percentage from 0 to 40, e.g. 5.';
    const prefix = str(iv.prefix, 8).toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(prefix)) fields['invoice.prefix'] = '1–8 letters or digits, e.g. GM.';
    out.invoice = { legal_name: str(iv.legal_name, 120), gstin, address, state: stateOk ? state : '', hsn, gst_rate, prefix };
  }

  if (body.notify) {
    const n = body.notify;
    const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
    const admin_emails = toList(n.admin_emails).map((e) => e.toLowerCase());
    if (admin_emails.some((e) => !isValidEmail(e))) fields['notify.admin_emails'] = 'One of the emails is invalid.';
    const admin_whatsapp = toList(n.admin_whatsapp).map((p) => {
      const d = p.replace(/\D/g, '');
      const ten = normalizePhone(d);
      return ten ? '91' + ten : d;
    });
    if (admin_whatsapp.some((p) => !/^\d{10,15}$/.test(p))) fields['notify.admin_whatsapp'] = 'Use numbers with country code.';
    out.notify = {
      customer_whatsapp: Boolean(n.customer_whatsapp),
      customer_email: Boolean(n.customer_email),
      admin_whatsapp,
      admin_emails,
    };
  }

  if (body.templates) {
    const t = {};
    for (const ev of EVENTS) {
      const src = body.templates[ev] || {};
      const cur = current.templates[ev] || DEFAULT_TEMPLATES[ev];
      t[ev] = {
        whatsapp: str(src.whatsapp ?? cur.whatsapp, 2000) || DEFAULT_TEMPLATES[ev].whatsapp,
        email_subject: str(src.email_subject ?? cur.email_subject, 200) || DEFAULT_TEMPLATES[ev].email_subject,
        email_intro: str(src.email_intro ?? cur.email_intro, 2000) || DEFAULT_TEMPLATES[ev].email_intro,
      };
    }
    out.templates = t;
  }

  if (body.otp) {
    const o = body.otp;
    const cap = Number(o.daily_sms_cap);
    if (!Number.isInteger(cap) || cap < 0 || cap > 100000) fields['otp.daily_sms_cap'] = 'Whole number, 0–100000.';
    const message = str(o.message, 300) || DEFAULT_OTP_MESSAGE;
    if (!message.includes('{{code}}')) fields['otp.message'] = 'The message must contain {{code}}.';
    const site = str(o.turnstile_site_key, 100);
    if (site && !env.TURNSTILE_SECRET) fields['otp.turnstile_site_key'] = 'Add the TURNSTILE_SECRET Worker secret first.';
    out.otp = { whatsapp_first: Boolean(o.whatsapp_first), sms_fallback: Boolean(o.sms_fallback), daily_sms_cap: cap, message, turnstile_site_key: site };
  }

  if (body.sms) {
    const s = body.sms;
    const provider = SMS_PROVIDER_IDS.includes(s.provider) ? s.provider : 'none';
    const c = s.custom || {};
    const custom = {
      url: str(c.url, 500), method: ['GET', 'POST', 'PUT'].includes(String(c.method).toUpperCase()) ? String(c.method).toUpperCase() : 'POST',
      headers: str(c.headers, 1000), body: str(c.body, 2000), success_match: str(c.success_match, 100),
    };
    if (provider !== 'none' && !env.SMS_API_KEY) fields['sms.provider'] = 'Add the SMS_API_KEY Worker secret first.';
    if (provider === 'msg91' && !str(s.template_id, 64)) fields['sms.template_id'] = 'MSG91 needs the Flow / template id.';
    if (provider === 'fast2sms' && str(s.template_id, 64) && !str(s.sender_id, 11)) fields['sms.sender_id'] = 'The DLT route needs your sender id.';
    if (provider === 'custom') {
      if (!/^https:\/\//i.test(custom.url)) fields['sms.custom.url'] = 'Must start with https://';
      if (custom.headers) { try { JSON.parse(custom.headers.replace(/\{\{\s*\w+\s*\}\}/g, 'x')); } catch { fields['sms.custom.headers'] = 'Must be a JSON object, e.g. {"Authorization":"{{api_key}}"}'; } }
      if (!/\{\{\s*code\s*\}\}|\{\{\s*message\s*\}\}/.test(custom.url + custom.body)) fields['sms.custom.body'] = 'Use {{code}} or {{message}} in the URL or body.';
    }
    out.sms = {
      provider, sender_id: str(s.sender_id, 11), template_id: str(s.template_id, 64),
      var_name: (str(s.var_name, 30) || 'otp').replace(/[^\w]/g, ''), custom,
    };
  }

  if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the highlighted settings.', { fields });
  return out;
}

export async function saveSettings(env, values) {
  if (Object.keys(values).length) await db(env).patch('settings', values);
}
