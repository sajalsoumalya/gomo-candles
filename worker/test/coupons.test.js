import { describe, it, expect } from 'vitest';
import { couponDiscount, validateCouponInput, evaluateCoupon, claimCoupon, releaseCoupon } from '../src/coupons.js';
import { computeInvoice } from '../src/invoice.js';

function memDb(seed = {}) {
  const root = structuredClone(seed);
  const walk = (p, mk) => { let o = root; const ks = p.split('/').filter(Boolean); for (const k of ks.slice(0, -1)) { if (o[k] == null) { if (!mk) return [null]; o[k] = {}; } o = o[k]; } return [o, ks.at(-1)]; };
  const get = (p) => { const [o, k] = walk(p); return o ? o[k] ?? null : null; };
  const put = (p, v) => { const [o, k] = walk(p, true); if (v === null) delete o[k]; else o[k] = structuredClone(v); };
  return { root, get: async (p) => structuredClone(get(p)), put: async (p, v) => put(p, v), patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(`${p}/${k}`, x); },
    remove: async (p) => put(p, null), getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: '1' }), putIfMatch: async (p, v) => { put(p, v); return true; } };
}
const settings = { shipping: { free_above: 999, include_equal: false, fee: 60 } };
const priced = (subtotal) => ({ subtotal, shipping: subtotal > 999 ? 0 : 60, total: subtotal + (subtotal > 999 ? 0 : 60) });

describe('coupons', () => {
  it('computes percent, capped percent and flat discounts', () => {
    expect(couponDiscount({ type: 'percent', value: 20 }, 799)).toBe(159);
    expect(couponDiscount({ type: 'percent', value: 50, max_discount: 200 }, 799)).toBe(200);
    expect(couponDiscount({ type: 'flat', value: 1000 }, 799)).toBe(799);
  });
  it('validates input', () => {
    expect(() => validateCouponInput({ code: 'x', type: 'percent', value: 10 }, { creating: true })).toThrow();
    expect(() => validateCouponInput({ code: 'DIWALI', type: 'percent', value: 95 }, { creating: true })).toThrow();
    expect(validateCouponInput({ code: ' diwali20 ', type: 'percent', value: 20 }, { creating: true }).code).toBe('DIWALI20');
  });
  it('applies min order, expiry and recomputes shipping on the discounted total', async () => {
    const env = { __db: memDb({ coupons: {
      SAVE100: { code: 'SAVE100', type: 'flat', value: 100, min_order: 500, active: true },
      OLD: { code: 'OLD', type: 'flat', value: 50, active: true, ends_at: '2020-01-01T00:00:00Z' },
      SHIPFREE: { code: 'SHIPFREE', type: 'free_shipping', value: 0, active: true },
    } }) };
    const ctx = { uid: 'u1', phone: '9876543210', settings };
    expect((await evaluateCoupon(env, 'save100', priced(400), ctx)).error).toMatch(/minimum/);
    expect((await evaluateCoupon(env, 'OLD', priced(800), ctx)).error).toMatch(/expired/);
    const r = await evaluateCoupon(env, 'SAVE100', priced(1050), ctx); // 1050 → 950 is no longer free shipping
    expect(r).toMatchObject({ ok: true, discount: 100, shipping: 60, total: 1010 });
    expect(await evaluateCoupon(env, 'SHIPFREE', priced(500), ctx)).toMatchObject({ ok: true, shipping: 0, total: 500 });
  });
  it('enforces usage limits and gives uses back on cancel', async () => {
    const env = { __db: memDb({ coupons: { ONE: { code: 'ONE', type: 'flat', value: 50, active: true, usage_limit: 1, per_customer_limit: 1, used_count: 0 } } }) };
    const ctx = { uid: 'u1', phone: '9876543210', settings };
    expect(await claimCoupon(env, 'ONE', 'GM-1', { uid: 'u1', phone: '9876543210', discount: 50 })).toBe(true);
    expect((await evaluateCoupon(env, 'ONE', priced(800), ctx)).ok).toBe(false);
    expect(await claimCoupon(env, 'ONE', 'GM-2', { uid: 'u2', phone: '9000000000', discount: 50 })).toBe(false);
    await releaseCoupon(env, 'ONE', 'GM-1');
    expect(env.__db.root.coupons.ONE.used_count).toBe(0);
    expect((await evaluateCoupon(env, 'ONE', priced(800), ctx)).ok).toBe(true);
  });
  it('invoice totals include the discount', () => {
    const inv = computeInvoice({ order_no: 'GM-1', created_at: '2026-11-18T00:00:00Z', state: 'West Bengal', shipping: 0, discount: 100, coupon_code: 'SAVE100' },
      [{ name: 'Combo', qty: 1, unit_price: 799, line_total: 799 }], { number: 'n', mode: 'plain', rate: 0, hsn: '3406', seller: {} });
    expect(inv.totals.gross).toBe(699);
  });
});
