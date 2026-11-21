// Coupons. One code per order.
// coupons/{CODE} = { code, description, type: percent|flat|free_shipping, value, max_discount, min_order,
//                    starts_at, ends_at, active, usage_limit, per_customer_limit, first_order_only, used_count,
//                    created_at, updated_at }
// coupon_uses/{CODE}/{order_no} = { uid, phone, at, discount, status: 'used'|'released' }
// Discount comes off the item subtotal; free shipping is then judged on the discounted subtotal.

import { HttpError, json, nowIso, readJson, inr } from './util.js';
import { db, values } from './db.js';
import { shippingFor } from './pricing.js';

export const CODE_RE = /^[A-Z0-9-]{3,20}$/;
export const normCode = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');

const num = (v) => (v === '' || v == null ? null : Number(v));

export function validateCouponInput(body, { creating }) {
  const fields = {};
  const code = normCode(body.code);
  if (creating && !CODE_RE.test(code)) fields.code = '3–20 letters, numbers or dashes, e.g. DIWALI20.';
  const type = ['percent', 'flat', 'free_shipping'].includes(body.type) ? body.type : '';
  if (!type) fields.type = 'Choose a discount type.';
  const value = type === 'free_shipping' ? 0 : num(body.value);
  if (type === 'percent' && !(Number.isInteger(value) && value >= 1 && value <= 90)) fields.value = 'A whole percentage from 1 to 90.';
  if (type === 'flat' && !(Number.isInteger(value) && value >= 1 && value <= 100000)) fields.value = 'Whole rupees, 1 or more.';
  const max_discount = num(body.max_discount);
  if (max_discount != null && !(Number.isInteger(max_discount) && max_discount >= 1)) fields.max_discount = 'Whole rupees, or leave empty.';
  const min_order = num(body.min_order) ?? 0;
  if (!(Number.isInteger(min_order) && min_order >= 0)) fields.min_order = 'Whole rupees, 0 or more.';
  const usage_limit = num(body.usage_limit);
  if (usage_limit != null && !(Number.isInteger(usage_limit) && usage_limit >= 1)) fields.usage_limit = 'A whole number, or leave empty for no limit.';
  const per_customer_limit = num(body.per_customer_limit);
  if (per_customer_limit != null && !(Number.isInteger(per_customer_limit) && per_customer_limit >= 1)) fields.per_customer_limit = 'A whole number, or leave empty.';
  const iso = (v, k) => { if (!v) return null; const t = Date.parse(v); if (Number.isNaN(t)) { fields[k] = 'Invalid date.'; return null; } return new Date(t).toISOString(); };
  const starts_at = iso(body.starts_at, 'starts_at');
  const ends_at = iso(body.ends_at, 'ends_at');
  if (starts_at && ends_at && ends_at <= starts_at) fields.ends_at = 'End must be after start.';
  if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the coupon details.', { fields });
  return {
    code, type, value, max_discount, min_order, usage_limit, per_customer_limit, starts_at, ends_at,
    description: String(body.description || '').trim().slice(0, 140),
    active: body.active !== false, first_order_only: body.first_order_only === true,
  };
}

/** Discount in rupees for a subtotal (pure). */
export function couponDiscount(c, subtotal) {
  if (c.type === 'percent') {
    const d = Math.floor((subtotal * c.value) / 100);
    return Math.min(d, c.max_discount || d, subtotal);
  }
  if (c.type === 'flat') return Math.min(c.value, subtotal);
  return 0;
}

/** Customer-facing summary, e.g. "20% off (up to ₹200) on orders above ₹499". */
export function couponSummary(c) {
  const what = c.type === 'percent' ? `${c.value}% off${c.max_discount ? ` (up to ${inr(c.max_discount)})` : ''}`
    : c.type === 'flat' ? `${inr(c.value)} off` : 'Free shipping';
  return `${what}${c.min_order ? ` on orders of ${inr(c.min_order)} or more` : ''}${c.first_order_only ? ' · first order only' : ''}`;
}

/**
 * Check a coupon against a priced cart and the customer. Returns { ok, code, discount, shipping, total, message } or { ok:false, error }.
 * ctx: { uid, phone, settings, now }
 */
export async function evaluateCoupon(env, rawCode, priced, ctx) {
  const code = normCode(rawCode);
  if (!CODE_RE.test(code)) return { ok: false, error: 'That code doesn’t look right.' };
  const d = db(env);
  const c = await d.get(`coupons/${code}`);
  const now = ctx.now ?? Date.now();
  if (!c || !c.active) return { ok: false, error: 'This code isn’t valid.' };
  if (c.starts_at && Date.parse(c.starts_at) > now) return { ok: false, error: 'This code isn’t active yet.' };
  if (c.ends_at && Date.parse(c.ends_at) < now) return { ok: false, error: 'This code has expired.' };
  if (c.min_order && priced.subtotal < c.min_order) return { ok: false, error: `Add ${inr(c.min_order - priced.subtotal)} more to use this code (minimum order ${inr(c.min_order)}).` };
  if (c.usage_limit && (c.used_count || 0) >= c.usage_limit) return { ok: false, error: 'This code has been fully used.' };

  if (c.per_customer_limit || c.first_order_only) {
    const uses = values(await d.get(`coupon_uses/${code}`)).filter((u) => u.status === 'used' && (u.uid === ctx.uid || (ctx.phone && u.phone === ctx.phone)));
    if (c.per_customer_limit && uses.length >= c.per_customer_limit) return { ok: false, error: 'You’ve already used this code.' };
    if (c.first_order_only) {
      const mine = Object.keys((await d.get(`user_orders/${ctx.uid}`, { shallow: true })) || {});
      const byPhone = ctx.phone ? Object.keys((await d.get(`order_index/phone/${ctx.phone}`, { shallow: true })) || {}) : [];
      const prior = [...new Set([...mine, ...byPhone])];
      for (const no of prior.slice(0, 20)) {
        const st = await d.get(`orders/${no}/status`);
        if (st && st !== 'cancelled') return { ok: false, error: 'This code is for your first order only.' };
      }
    }
  }

  const discount = couponDiscount(c, priced.subtotal);
  const after = priced.subtotal - discount;
  const shipping = c.type === 'free_shipping' ? 0 : shippingFor(after, ctx.settings.shipping);
  if (c.type !== 'free_shipping' && discount <= 0) return { ok: false, error: 'This code doesn’t apply to your cart.' };
  if (c.type === 'free_shipping' && shippingFor(after, ctx.settings.shipping) === 0) return { ok: false, error: 'Your order already ships free.' };
  return {
    ok: true, code, type: c.type, discount, shipping, total: after + shipping,
    message: c.type === 'free_shipping' ? 'Free shipping applied!' : `You save ${inr(discount)} with ${code}!`,
    summary: couponSummary(c),
  };
}

/** Atomically count one use. Returns false if the usage limit was hit in the meantime. */
export async function claimCoupon(env, code, orderNo, { uid, phone, discount }) {
  const d = db(env);
  for (let i = 0; i < 5; i++) {
    const { value: c, etag } = await d.getWithEtag(`coupons/${code}`);
    if (!c) return false;
    if (c.usage_limit && (c.used_count || 0) >= c.usage_limit) return false;
    if (await d.putIfMatch(`coupons/${code}`, { ...c, used_count: (c.used_count || 0) + 1 }, etag)) {
      await d.put(`coupon_uses/${code}/${orderNo}`, { uid, phone, at: nowIso(), discount, status: 'used' });
      return true;
    }
  }
  return false;
}

/** Give a use back (order cancelled). Safe to call twice. */
export async function releaseCoupon(env, code, orderNo) {
  const d = db(env);
  const use = await d.get(`coupon_uses/${code}/${orderNo}`);
  if (!use || use.status !== 'used') return;
  await d.patch(`coupon_uses/${code}/${orderNo}`, { status: 'released', released_at: nowIso() });
  for (let i = 0; i < 5; i++) {
    const { value: c, etag } = await d.getWithEtag(`coupons/${code}`);
    if (!c) return;
    if (await d.putIfMatch(`coupons/${code}`, { ...c, used_count: Math.max(0, (c.used_count || 0) - 1) }, etag)) return;
  }
}

// ------------------------------------------------------------------ admin

const pub = (c) => ({ ...c, summary: couponSummary(c) });

export async function adminListCoupons(env) {
  const list = values(await db(env).get('coupons')).filter((c) => c?.code).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return json({ coupons: list.map(pub) });
}

export async function adminCreateCoupon(request, env) {
  const v = validateCouponInput(await readJson(request), { creating: true });
  const d = db(env);
  const { value: existing, etag } = await d.getWithEtag(`coupons/${v.code}`);
  if (existing) throw new HttpError(409, 'A coupon with this code already exists.', { fields: { code: 'Already exists.' } });
  const now = nowIso();
  const row = { ...v, used_count: 0, created_at: now, updated_at: now };
  if (!(await d.putIfMatch(`coupons/${v.code}`, row, etag))) throw new HttpError(409, 'A coupon with this code already exists.');
  return json({ coupon: pub(row) }, 201);
}

export async function adminUpdateCoupon(request, env, code) {
  const d = db(env);
  const cur = await d.get(`coupons/${normCode(code)}`);
  if (!cur) throw new HttpError(404, 'Coupon not found.');
  const v = validateCouponInput({ ...(await readJson(request)), code: cur.code }, { creating: false });
  const row = { ...cur, ...v, code: cur.code, used_count: cur.used_count || 0, updated_at: nowIso() };
  await d.put(`coupons/${cur.code}`, row);
  return json({ coupon: pub(row) });
}

export async function adminDeleteCoupon(env, code) {
  const c = normCode(code);
  const d = db(env);
  const cur = await d.get(`coupons/${c}`);
  if (!cur) throw new HttpError(404, 'Coupon not found.');
  if (cur.used_count) {
    await d.patch(`coupons/${c}`, { active: false, updated_at: nowIso() }); // keep history on used codes
    return json({ ok: true, archived: true });
  }
  await d.remove(`coupons/${c}`);
  return json({ ok: true });
}
