// Branded HTML email layout for GoMo Candles. Table-based with inline styles so it renders in Gmail, Outlook,
// Apple Mail and phone clients. Images load from the shop domain (settings.store.shop_url).

import { escapeHtml as esc, inr } from './util.js';

const C = {
  bg: '#efe7dd', card: '#fbf8f4', ink: '#1d1915', ink2: '#3a332c', muted: '#7a7067', line: '#e9dfd3',
  rust: '#9c5530', rustSoft: '#f4e6db', ok: '#2f7a4f', okSoft: '#e5f2ea',
};
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

/** Order progress shown in every customer order email. */
const STEPS = [['placed', 'Placed'], ['confirmed', 'Confirmed'], ['packed', 'Packed'], ['shipped', 'Shipped'], ['delivered', 'Delivered']];
function progress(status) {
  if (status === 'cancelled') return '';
  const at = status === 'out_for_delivery' ? 3 : Math.max(0, STEPS.findIndex(([k]) => k === status));
  const cells = STEPS.map(([, label], i) => {
    const done = i <= at;
    return `<td align="center" width="20%" style="padding:0 2px">
      <div style="height:6px;border-radius:6px;background:${done ? C.rust : C.line}"></div>
      <div style="margin-top:7px;font:600 11px/1.2 ${SANS};letter-spacing:.3px;color:${done ? C.ink : C.muted}">${label}</div></td>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr>${cells}</tr></table>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 4px"><tr>
    <td style="border-radius:999px;background:${C.rust}"><a href="${esc(href)}" style="display:inline-block;padding:14px 30px;font:700 14px/1 ${SANS};letter-spacing:.4px;color:#fff;text-decoration:none;border-radius:999px">${esc(label)}</a></td></tr></table>`;
}

/** Wraps content in the branded frame: logo header, card, footer with contact + policy links. */
export function layout({ settings, preheader = '', eyebrow = '', title = '', body = '' }) {
  const shop = String(settings.store.shop_url || '').replace(/\/+$/, '');
  const name = settings.store.name || 'GoMo Candles';
  const logo = shop
    ? `<img src="${esc(shop)}/assets/brand/icon-192.png" width="56" height="56" alt="${esc(name)}" style="display:block;margin:0 auto;border-radius:14px;border:0">`
    : `<div style="font:700 22px/1 ${SANS};letter-spacing:4px;color:${C.ink}">${esc(name.toUpperCase())}</div>`;
  const wa = settings.store.whatsapp ? `+${settings.store.whatsapp}` : '';
  const contact = [wa && `WhatsApp ${esc(wa)}`, settings.store.email && `<a href="mailto:${esc(settings.store.email)}" style="color:${C.muted}">${esc(settings.store.email)}</a>`].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const links = shop ? [['Shop', '/shop'], ['Track order', '/#track'], ['Returns', '/returns-policy'], ['Privacy', '/privacy-policy'], ['Terms', '/terms']]
    .map(([l, p]) => `<a href="${esc(shop + p)}" style="color:${C.muted};text-decoration:underline">${l}</a>`).join(' &nbsp;·&nbsp; ') : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title || name)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 12px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
    <tr><td align="center" style="padding:0 0 18px">${logo}
      <div style="margin-top:10px;font:italic 13px/1.4 ${SERIF};color:${C.muted}">More than a candle. A moment of peace.</div></td></tr>
    <tr><td style="background:${C.card};border-radius:22px;border:1px solid ${C.line};overflow:hidden">
      <div style="height:6px;background:${C.rust};background-image:linear-gradient(90deg,#7d3f1f,${C.rust},#c27a4b)"></div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:34px 34px 30px">
        ${eyebrow ? `<div style="font:700 11px/1 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.rust}">${esc(eyebrow)}</div>` : ''}
        ${title ? `<h1 style="margin:12px 0 0;font:400 28px/1.2 ${SERIF};color:${C.ink}">${esc(title)}</h1>` : ''}
        ${body}
      </td></tr></table>
    </td></tr>
    <tr><td align="center" style="padding:22px 20px 0;font:13px/1.7 ${SANS};color:${C.muted}">
      ${contact ? `<div>Questions? We're here to help — ${contact}</div>` : ''}
      ${links ? `<div style="margin-top:8px;font-size:12px">${links}</div>` : ''}
      <div style="margin-top:12px;font-size:11px;color:#a29789">Handcrafted in Kolkata, India · © ${new Date().getFullYear()} ${esc(name)}</div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

const EYEBROW = {
  placed: 'Order received', confirmed: 'Order confirmed', packed: 'Packed with care', shipped: 'On its way',
  out_for_delivery: 'Arriving today', delivered: 'Delivered', cancelled: 'Order cancelled',
};
const TITLE = {
  placed: 'Thank you for your order', confirmed: 'Your order is confirmed', packed: 'Your order is packed',
  shipped: 'Your order has shipped', out_for_delivery: 'Out for delivery today', delivered: 'Enjoy your moment of peace',
  cancelled: 'Your order has been cancelled',
};

/** Order email (customer and admin). */
export function orderEmail({ intro, order, items, vars, settings, event, admin = false }) {
  const status = event === 'payment_received' ? order.status : (event === 'order_placed' ? 'placed' : order.status);
  const eyebrow = admin ? 'New order' : event === 'payment_received' ? 'Payment received' : (EYEBROW[status] || 'Order update');
  const title = admin ? `${vars.full_name} placed an order` : event === 'payment_received' ? 'Thank you for your payment' : (TITLE[status] || 'Order update');

  const rows = items.map((i) => `<tr>
      <td style="padding:14px 0;border-bottom:1px solid ${C.line};font:15px/1.45 ${SANS};color:${C.ink}">
        <span style="display:inline-block;min-width:26px;font-weight:700;color:${C.rust}">${esc(i.qty)}×</span>${esc(i.name)}
        ${i.contents ? `<div style="padding-left:26px;font-size:12px;color:${C.muted}">${esc(i.contents)}</div>` : ''}</td>
      <td align="right" style="padding:14px 0;border-bottom:1px solid ${C.line};font:600 15px/1.45 ${SANS};color:${C.ink};white-space:nowrap">${esc(inr(i.line_total))}</td></tr>`).join('');
  const line = (label, value, o = {}) => `<tr>
      <td style="padding:5px 0;font:${o.strong ? '700 17px' : '14px'}/1.4 ${SANS};color:${o.strong ? C.ink : C.muted}">${label}</td>
      <td align="right" style="padding:5px 0;font:${o.strong ? '700 19px' : '14px'}/1.4 ${o.strong ? SERIF : SANS};color:${o.color || (o.strong ? C.rust : C.ink2)}">${esc(value)}</td></tr>`;

  const tracking = (order.courier || order.tracking_no || order.tracking_url) && ['shipped', 'out_for_delivery'].includes(order.status)
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:${C.rustSoft};border-radius:14px"><tr><td style="padding:16px 18px;font:14px/1.6 ${SANS};color:${C.ink2}">
        <div style="font:700 11px/1 ${SANS};letter-spacing:1.5px;text-transform:uppercase;color:${C.rust};margin-bottom:8px">Shipment details</div>
        ${order.courier ? `Courier: <b>${esc(order.courier)}</b><br>` : ''}${order.tracking_no ? `Tracking number: <b>${esc(order.tracking_no)}</b><br>` : ''}
        ${order.tracking_url ? `<a href="${esc(order.tracking_url)}" style="color:${C.rust};font-weight:700">Track with the courier →</a>` : ''}</td></tr></table>` : '';

  const cod = order.payment_method === 'cod' && order.payment_status !== 'paid' && !admin && order.status !== 'cancelled'
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.okSoft};border-radius:14px"><tr><td style="padding:14px 18px;font:14px/1.5 ${SANS};color:${C.ok}">
        💵 <b>Cash on Delivery</b> — please keep <b>${esc(vars.total)}</b> ready when your parcel arrives.</td></tr></table>` : '';

  const body = `
    <p style="margin:16px 0 0;font:16px/1.7 ${SANS};color:${C.ink2}">${nl2br(intro)}</p>
    ${admin ? '' : progress(order.status)}
    ${tracking}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;border:1px solid ${C.line};border-radius:16px;background:#fff"><tr><td style="padding:6px 20px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:14px 0 6px;font:700 11px/1 ${SANS};letter-spacing:1.5px;text-transform:uppercase;color:${C.muted}">Order ${esc(order.order_no)}</td>
        <td align="right" style="padding:14px 0 6px;font:12px/1 ${SANS};color:${C.muted}">${esc(new Date(order.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }))}</td></tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px">
        ${line('Subtotal', vars.subtotal)}
        ${order.savings ? line('You saved', `− ${vars.savings}`, { color: C.ok }) : ''}
        ${order.discount ? line(`Coupon ${esc(order.coupon_code || '')}`, `− ${vars.discount}`, { color: C.ok }) : ''}
        ${line('Shipping', vars.shipping)}
        <tr><td colspan="2" style="padding:6px 0 0"><div style="border-top:1px dashed ${C.line}"></div></td></tr>
        ${line('Total', vars.total, { strong: true })}
        ${line('Payment', vars.payment)}
      </table></td></tr></table>
    ${cod}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr><td style="font:14px/1.65 ${SANS};color:${C.ink2}">
      <div style="font:700 11px/1 ${SANS};letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};margin-bottom:8px">Delivering to</div>
      <b style="color:${C.ink}">${esc(order.customer_name)}</b> · +91 ${esc(order.phone)}<br>${esc(vars.address)}</td></tr></table>
    ${vars.track_link.startsWith('http') && !admin ? button(vars.track_link, order.status === 'delivered' ? 'View your order' : 'Track your order') : ''}
    ${order.status === 'delivered' && !admin ? `<p style="margin:22px 0 0;text-align:center;font:italic 15px/1.6 ${SERIF};color:${C.muted}">“Light a candle, take a breath — the Evil Eye watches over you.”</p>` : ''}
    ${admin ? '' : `<p style="margin:28px 0 0;font:15px/1.6 ${SANS};color:${C.ink2}">Warm regards,<br><b style="color:${C.ink}">Team ${esc(settings.store.name)}</b></p>`}`;

  return layout({ settings, preheader: `${eyebrow} · Order ${order.order_no} · ${vars.total}`, eyebrow, title, body });
}

/** Sign-in / verification code email. */
export function codeEmail({ settings, code, minutes, purpose }) {
  const signIn = purpose === 'login_email';
  const digits = String(code).split('').map((d) => `<td align="center" style="width:44px;height:56px;background:#fff;border:1px solid ${C.line};border-radius:12px;font:700 28px/56px ${SANS};color:${C.ink}">${d}</td>`).join('<td style="width:8px"></td>');
  const body = `
    <p style="margin:16px 0 0;font:16px/1.7 ${SANS};color:${C.ink2}">${signIn ? 'Use this code to sign in to your account:' : 'Use this code to confirm your email address:'}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto"><tr>${digits}</tr></table>
    <p style="margin:0;text-align:center;font:14px/1.6 ${SANS};color:${C.muted}">This code expires in <b style="color:${C.ink}">${minutes} minutes</b>.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;background:${C.rustSoft};border-radius:14px"><tr><td style="padding:14px 18px;font:13px/1.6 ${SANS};color:${C.ink2}">
      🔒 For your security, never share this code — our team will never ask you for it. If you didn't request it, you can safely ignore this email.</td></tr></table>`;
  return layout({ settings, preheader: `${code} is your ${settings.store.name} code`, eyebrow: signIn ? 'Sign in' : 'Confirm your email', title: signIn ? 'Your sign-in code' : 'Confirm your email', body });
}
