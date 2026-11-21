import { HttpError } from './util.js';

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
];

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

export const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Normalise an Indian mobile number to 10 digits, or return '' if invalid. */
export function normalizePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

export function isValidEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/** Validate a delivery address. Returns { address, fields }. Coordinates are optional (from "Use my location"). */
export function validateAddress(a = {}) {
  const fields = {};
  const line1 = clean(a.line1, 160);
  if (line1.length < 5) fields.line1 = 'Enter your house / flat and street.';
  const line2 = clean(a.line2, 160);
  const landmark = clean(a.landmark, 100);
  const city = clean(a.city, 60);
  if (city.length < 2) fields.city = 'Enter your city.';
  const state = INDIAN_STATES.find((s) => s.toLowerCase() === clean(a.state, 60).toLowerCase()) || '';
  if (!state) fields.state = 'Choose your state.';
  const pincode = String(a.pincode ?? '').replace(/\s/g, '');
  if (!/^[1-9]\d{5}$/.test(pincode)) fields.pincode = 'Enter a valid 6-digit PIN code.';
  const address = { line1, line2: line2 || null, landmark: landmark || null, city, state, pincode };
  const lat = Number(a.lat), lng = Number(a.lng);
  if (a.lat != null && a.lng != null && inIndia(lat, lng)) {
    address.lat = Math.round(lat * 1e6) / 1e6;
    address.lng = Math.round(lng * 1e6) / 1e6;
    const acc = Number(a.accuracy);
    if (Number.isFinite(acc) && acc >= 0) address.accuracy = Math.min(100000, Math.round(acc));
  }
  return { address, fields };
}

/** Rough bounding box for India (incl. islands). */
export const inIndia = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 6 && lat <= 37.6 && lng >= 68 && lng <= 97.6;

/**
 * Validate checkout input. The signed-in customer's verified mobile (and verified email) come from their account,
 * so the browser only sends name, address, notes, payment and items.
 */
export function validateOrderInput(body) {
  const fields = {};
  const c = body.customer || {};

  const name = clean(c.name, 80);
  if (name.length < 2) fields.name = 'Please enter your full name.';

  const { address, fields: af } = validateAddress(body.address || {});
  Object.assign(fields, af);

  const notes = clean(body.notes, 300);
  const payment_method = body.payment_method === 'razorpay' ? 'razorpay' : body.payment_method === 'cod' ? 'cod' : '';
  if (!payment_method) fields.payment_method = 'Choose a payment method.';

  const idem = typeof body.idempotency_key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.idempotency_key) ? body.idempotency_key : null;

  if (!Array.isArray(body.items) || body.items.length === 0) fields.items = 'Your cart is empty.';

  if (Object.keys(fields).length) throw new HttpError(422, 'Please check the highlighted fields.', { fields });

  return {
    customer: { name },
    address,
    notes: notes || null,
    payment_method,
    idempotency_key: idem,
    items: body.items,
    save_address: body.save_address === true,
    coupon: typeof body.coupon === 'string' && body.coupon.trim() ? body.coupon.trim().slice(0, 24) : null,
    address_label: clean(body.address_label, 30) || null,
  };
}

// ---- admin inputs -------------------------------------------------------------

const ARTS = ['candle', 'sachet', 'spray', 'gift'];

function int(v, { min = 0, max = 1e7, field, fields }) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    fields[field] = `Must be a whole number between ${min} and ${max}.`;
    return null;
  }
  return n;
}

const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

export function validateProductInput(body, { partial = false } = {}) {
  const fields = {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    out.name = clean(body.name, 80);
    if (out.name.length < 2) fields.name = 'Name is required.';
  }
  for (const [k, max] of [['category', 60], ['tag', 30]]) if (has(k)) out[k] = clean(body[k], max);
  if (has('description')) out.description = clean(body.description, 1000);
  if (has('chips')) {
    const chips = Array.isArray(body.chips) ? body.chips : String(body.chips || '').split(',');
    out.chips = JSON.stringify(chips.map((s) => clean(String(s), 30)).filter(Boolean).slice(0, 6));
  }
  if (!partial || has('price')) out.price = int(body.price ?? 0, { min: 0, max: 100000, field: 'price', fields });
  // MRP is display-only (shown struck through); orders are always priced from `price`. 0 = no MRP.
  if (has('mrp')) out.mrp = body.mrp == null || body.mrp === '' ? 0 : int(body.mrp, { min: 0, max: 100000, field: 'mrp', fields });
  if (out.mrp > 0 && out.price > 0 && out.mrp < out.price) fields.mrp = 'MRP can’t be lower than the selling price.';
  if (has('details')) {
    // Product facts shown as a table: [{label, value}] or text lines "Label: value".
    const raw = Array.isArray(body.details) ? body.details : String(body.details || '').split('\n');
    const rows = [];
    for (const r of raw) {
      let label, value;
      if (r && typeof r === 'object') ({ label, value } = r);
      else {
        const s = String(r || '');
        const i = s.indexOf(':');
        if (i < 0) { label = ''; value = s; } else { label = s.slice(0, i); value = s.slice(i + 1); }
      }
      label = clean(String(label ?? ''), 30);
      value = clean(String(value ?? ''), 160);
      if (value) rows.push({ label, value });
    }
    if (rows.length > 10) fields.details = 'Up to 10 detail lines.';
    else if (rows.some((r) => !r.label)) fields.details = 'Write each line as “Label: value”, e.g. “Expiry: 1 year”.';
    out.details = JSON.stringify(rows);
  }
  if (has('art')) {
    out.art = ARTS.includes(body.art) ? body.art : null;
    if (!out.art) fields.art = 'Choose an illustration.';
  }
  for (const k of ['in_stock', 'orderable', 'published']) if (has(k)) out[k] = flag(body[k]);
  // Stock quantity: empty / null = not tracked (only the In stock switch is used).
  if (has('stock')) out.stock = body.stock == null || body.stock === '' ? null : int(body.stock, { min: 0, max: 100000, field: 'stock', fields });
  if (has('low_stock_at')) out.low_stock_at = body.low_stock_at == null || body.low_stock_at === '' ? 5 : int(body.low_stock_at, { min: 0, max: 1000, field: 'low_stock_at', fields });
  if (has('sort')) out.sort = int(body.sort, { min: 0, max: 100000, field: 'sort', fields });

  if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the product details.', { fields });
  return out;
}

function isoOrNull(v, field, fields) {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) { fields[field] = 'Invalid date.'; return null; }
  return new Date(t).toISOString();
}

export function validateOfferInput(body, productIds) {
  const fields = {};
  const type = body.type === 'pack' ? 'pack' : body.type === 'combo' ? 'combo' : '';
  if (!type) fields.type = 'Choose Combo or Pack.';
  const name = clean(body.name, 100);
  if (name.length < 2) fields.name = 'Name is required.';
  const description = clean(body.description, 500);
  const badge = clean(body.badge, 30);
  const price = int(body.price, { min: 1, max: 1000000, field: 'price', fields });
  const sort = body.sort == null || body.sort === '' ? 0 : int(body.sort, { min: 0, max: 100000, field: 'sort', fields });
  const starts_at = isoOrNull(body.starts_at, 'starts_at', fields);
  const ends_at = isoOrNull(body.ends_at, 'ends_at', fields);
  if (starts_at && ends_at && Date.parse(ends_at) <= Date.parse(starts_at)) fields.ends_at = 'End must be after start.';

  const seen = new Set();
  const items = [];
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const pid = String(it?.product_id || '');
    const qty = Number(it?.qty);
    if (!productIds.has(pid)) { fields.items = 'Pick valid products.'; continue; }
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) { fields.items = 'Quantities must be 1–50.'; continue; }
    if (seen.has(pid)) { fields.items = 'Each product can appear only once.'; continue; }
    seen.add(pid);
    items.push({ product_id: pid, qty });
  }
  if (!fields.items) {
    if (type === 'pack' && (items.length !== 1 || items[0].qty < 2)) fields.items = 'A pack is one product with quantity 2 or more.';
    if (type === 'combo' && (items.length < 2)) fields.items = 'A combo needs at least two different products.';
  }

  if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the offer details.', { fields });
  return { type, name, description, badge, price, published: flag(body.published), starts_at, ends_at, countdown: body.countdown !== false, sort, items };
}
