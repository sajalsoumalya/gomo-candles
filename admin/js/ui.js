// Small UI toolkit for the admin panel. Everything user-provided goes through esc().

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

export function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', withTime
    ? { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso, false);
}

// Offer times are always entered and shown in India time (IST, UTC+05:30), whatever timezone this computer is set to.
const IST_MS = 330 * 60000;
/** ISO string → value for <input type="datetime-local">, in IST */
export function toLocalInput(iso) {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 16);
}
/** <input type="datetime-local"> value, read as IST → ISO string */
export const fromLocalInput = (v) => (v ? new Date(Date.parse(v + ':00Z') - IST_MS).toISOString() : null);
/** "18 Nov, 11:59 pm IST" */
export const fmtIst = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + ' IST' : '');

export const STATUSES = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
export const STATUS_LABELS = {
  placed: 'New', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled',
};
export const EVENT_LABELS = {
  order_placed: 'Order placed', payment_received: 'Payment received', confirmed: 'Confirmed', packed: 'Packed',
  shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled',
  admin_new_order: 'Admin: new order alert', test: 'Test message',
  otp_login: 'Sign-in code', otp_verify_phone: 'Mobile verification code', otp_verify_whatsapp: 'WhatsApp confirmation code', otp_verify_email: 'Email confirmation code',
};
export const CHANNEL_LABELS = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };

export const statusPill = (s) => `<span class="pill ${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;
export function paymentPill(o) {
  const rf = o.payment_status === 'paid' ? o.refund?.status : null;
  if (rf === 'review') return '<span class="pill failed" title="The order was cancelled after an online payment. Open it and press Process refund.">Refund: awaiting review</span>';
  if (rf === 'processing') return '<span class="pill placed" title="Razorpay is sending the money back (5–7 working days).">Refund initiated</span>';
  if (rf === 'failed') return '<span class="pill failed">Refund failed</span>';
  if (o.payment_status === 'paid') return '<span class="pill paid">Paid</span>';
  if (o.payment_status === 'refunded') return '<span class="pill refunded">Refunded</span>';
  if (o.payment_status === 'failed') return '<span class="pill failed">Failed</span>';
  return o.payment_method === 'cod' ? '<span class="pill pending">COD due</span>' : '<span class="pill pending">Unpaid</span>';
}

export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

/** Order row used on phones (dashboard + orders list) */
export function orderCard(o) {
  const n = o.item_count;
  return `<a class="o-card st-${esc(o.status)}" href="#/orders/${esc(o.order_no)}">
    <span class="o-av" aria-hidden="true">${esc(initials(o.customer_name))}</span>
    <span class="o-main"><b>${esc(o.customer_name)}</b><small><span class="mono">${esc(o.order_no)}</span>${o.city ? ' · ' + esc(o.city) : ''}</small></span>
    <span class="o-amt"><b>${inr(o.total)}</b><small>${esc(timeAgo(o.created_at))}</small></span>
    <span class="o-tags">${statusPill(o.status)}${paymentPill(o)}${n ? `<span class="o-n">${n} item${n === 1 ? '' : 's'}</span>` : ''}</span></a>`;
}

export const ART = { candle: '#i-candle', sachet: '#i-sachet', spray: '#i-spray', gift: '#i-gift' };
export const artSvg = (art) => `<svg aria-hidden="true"><use href="${ART[art] || ART.candle}"/></svg>`;

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  orders: '<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  offers: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  products: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  wa: '<path d="M3 21l1.6-4.7A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.4-1.8-1-1 .8c-1-.5-1.8-1.3-2.3-2.3l.8-1-1-1.8z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  dup: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  ext: '<path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.9-3.4 3.4-5.2 6.5-5.2s5.6 1.8 6.5 5.2"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.9c1.5.8 2.6 2.5 3 5.1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.6"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ------------------------------------------------------------------ toasts
export function toast(message, type = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3200);
}

// ------------------------------------------------------------------ dialogs
export function openDialog({ title, body, foot = '', size = '', onMount, onBeforeClose, onClose }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="dialog ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dialog-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-dismiss aria-label="Close">${icon('x')}</button></div>
    <div class="dialog-body">${body}</div>${foot ? `<div class="dialog-foot">${foot}</div>` : ''}</div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('open'));
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    ov.classList.remove('open'); setTimeout(() => ov.remove(), 200); document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  // close() asks onBeforeClose (which may show a confirmation); close(true) skips it, e.g. after a successful save.
  const close = async (force = false) => {
    if (closed) return;
    if (!force && onBeforeClose && (await onBeforeClose()) === false) return;
    finish();
  };
  const onKey = (e) => { if (e.key === 'Escape' && [...document.querySelectorAll('.overlay')].pop() === ov) close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-dismiss]')?.closest('.overlay') === ov) close(); });
  const handle = { el: ov, close };
  onMount?.(handle);
  setTimeout(() => ov.querySelector('input:not([type=file]), select, textarea')?.focus(), 80);
  return handle;
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const d = openDialog({
      title, size: 'sm', body: `<p style="line-height:1.6">${esc(message)}</p>`,
      foot: `<button type="button" class="btn btn-line" data-dismiss>Cancel</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
      onMount: ({ el, close }) => {
        el.querySelector('[data-ok]').addEventListener('click', () => { done = true; close(); resolve(true); });
        el.addEventListener('click', (e) => { if (!done && (e.target === el || e.target.closest('[data-dismiss]'))) resolve(false); });
      },
    });
    return d;
  });
}

/** Mark invalid fields from an API 422 response: { fields: { name: 'msg' } } */
export function showFieldErrors(root, fields = {}) {
  root.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  for (const [name, msg] of Object.entries(fields)) {
    const wrap = root.querySelector(`[data-field="${CSS.escape(name)}"]`);
    if (!wrap) continue;
    wrap.classList.add('invalid');
    let err = wrap.querySelector('.err');
    if (!err) { err = document.createElement('div'); err.className = 'err'; wrap.appendChild(err); }
    err.textContent = msg;
  }
  root.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea')?.focus();
}

export function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${esc(label || 'Saving…')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const loading = (text = 'Loading…') => `<div class="loading"><span class="spinner"></span> ${esc(text)}</div>`;

/**
 * Phones: instead of Previous/Next, fetch the next page when the end of the card list scrolls near and append it.
 * `d` is the first page ({ total, page, page_size }); items(d) gives its rows, key(row) de-duplicates rows that shift
 * between pages when new ones arrive, card(row) is the row's HTML and wire(nodes) binds buttons on appended cards.
 */
export function moreOnScroll(res, { d, noun, items, key, card, fetchPage, wire }) {
  const list = res.querySelector('.list-cards'), pager = res.querySelector('.pager');
  if (!list || !pager || !matchMedia('(max-width:720px)').matches) return;
  pager.classList.add('auto');
  const label = pager.querySelector('span');
  const seen = new Set(items(d).map(key));
  let total = d.total, next = d.page + 1, busy = false;
  const show = () => { label.textContent = `Showing ${list.children.length} of ${total} ${noun}`; };
  show();
  if (d.page * d.page_size >= total) return;
  const foot = document.createElement('button');
  foot.type = 'button'; foot.className = 'more-foot'; foot.textContent = 'Load more';
  list.after(foot);
  const near = () => foot.isConnected && foot.getBoundingClientRect().top < innerHeight + 600;
  const run = async () => {
    if (busy || !foot.isConnected) return;
    busy = true; foot.innerHTML = '<span class="spinner"></span> Loading more…';
    try {
      const p = await fetchPage(next);
      if (!foot.isConnected) return;
      const fresh = items(p).filter((x) => !seen.has(key(x)));
      fresh.forEach((x) => seen.add(key(x)));
      const before = list.children.length;
      list.insertAdjacentHTML('beforeend', fresh.map(card).join(''));
      wire?.([...list.children].slice(before));
      total = p.total; next = p.page + 1; show();
      if (p.page * p.page_size >= p.total || !items(p).length) { io.disconnect(); foot.remove(); return; }
      foot.textContent = 'Load more';
    } catch { foot.textContent = 'Couldn’t load more — tap to try again'; busy = false; return; }
    busy = false;
    if (near()) run(); // a short page may leave the end of the list on screen
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) run(); }, { rootMargin: '0px 0px 600px 0px' });
  io.observe(foot);
  foot.addEventListener('click', run);
}
export const errorBox = (e) => `<div class="alert err">${esc(e.message || e)}</div>`;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { toast('Copy failed — select and copy manually', 'err'); }
}
