import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/account.js', async (orig) => ({ ...(await orig()), requireCustomer: async () => ({ uid: 'u1', profile: {} }) }));
vi.mock('../src/notify.js', async (orig) => ({ ...(await orig()), notifyOrderEvent: async () => [] }));

const { shippingFor, shippingRuleFor } = await import('../src/pricing.js');
const { validateSettingsInput } = await import('../src/settings.js');
const { customerCancelOrder } = await import('../src/orders.js');

describe('prepaid delivery fee', () => {
  const rule = { fee: 60, free_above: 999, include_equal: false, prepaid_fee: 0 };
  it('0 = free delivery for online payment, COD keeps the fee', () => {
    expect(shippingFor(500, shippingRuleFor(rule, 'razorpay'))).toBe(0);
    expect(shippingFor(500, shippingRuleFor(rule, 'cod'))).toBe(60);
  });
  it('a value = that fee for online payment; empty = same as COD', () => {
    expect(shippingFor(500, shippingRuleFor({ ...rule, prepaid_fee: 30 }, 'razorpay'))).toBe(30);
    expect(shippingFor(500, shippingRuleFor({ ...rule, prepaid_fee: null }, 'razorpay'))).toBe(60);
    expect(shippingFor(1200, shippingRuleFor({ ...rule, prepaid_fee: 30 }, 'razorpay'))).toBe(0); // still free above the threshold
  });
  it('admin input: empty is saved as null, bad values are rejected', () => {
    expect(validateSettingsInput({ shipping: { fee: 60, free_above: 999, prepaid_fee: '' } }, {}, {}).shipping.prepaid_fee).toBe(null);
    expect(validateSettingsInput({ shipping: { fee: 60, free_above: 999, prepaid_fee: 0 } }, {}, {}).shipping.prepaid_fee).toBe(0);
    expect(() => validateSettingsInput({ shipping: { fee: 60, free_above: 999, prepaid_fee: -5 } }, {}, {})).toThrow();
  });
});

function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => { const ks = seg(p), last = ks.pop(); const par = ks.reduce((o, k) => (o[k] ??= {}), root); if (v == null) delete par[last]; else par[last] = structuredClone(v); };
  return { root, __db: {
    get: async (p) => structuredClone(get(p)),
    put: async (p, v) => put(p, v),
    patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); },
    remove: async (p) => put(p, null),
    getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
    putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
  } };
}
const order = (status, extra = {}) => ({ order_no: 'GM-261121-0001', uid: 'u1', status, payment_method: 'cod', payment_status: 'pending',
  total: 499, items: { a: { name: 'Sachet', qty: 1 } }, events: {}, stock_held: { candle: 2 }, ...extra });
const req = () => new Request('https://x/api', { method: 'POST', body: '{}' });
const ctx = { waitUntil() {} };

describe('customer cancel', () => {
  it('cancels before shipping and gives the stock back once', async () => {
    const m = memDb({ products: { candle: { stock: 1 } }, orders: { 'GM-261121-0001': order('packed') } });
    const r = await (await customerCancelOrder(req(), m, ctx, 'GM-261121-0001')).json();
    expect(m.root.orders['GM-261121-0001'].status).toBe('cancelled');
    expect(m.root.products.candle.stock).toBe(3);
    expect(r.refund_due).toBe(false);
    await expect(customerCancelOrder(req(), m, ctx, 'GM-261121-0001')).rejects.toMatchObject({ status: 409 });
    expect(m.root.products.candle.stock).toBe(3);
  });
  it('flags a refund for a paid online order', async () => {
    const m = memDb({ products: { candle: { stock: 1 } }, orders: { 'GM-261121-0001': order('placed', { payment_method: 'razorpay', payment_status: 'paid' }) } });
    const r = await (await customerCancelOrder(req(), m, ctx, 'GM-261121-0001')).json();
    expect(r.refund_due).toBe(true);
    expect(m.root.orders['GM-261121-0001'].refund_due).toBe(true);
  });
  it('refuses once shipped, and refuses other customers', async () => {
    for (const st of ['shipped', 'out_for_delivery', 'delivered']) {
      const m = memDb({ orders: { 'GM-261121-0001': order(st) } });
      await expect(customerCancelOrder(req(), m, ctx, 'GM-261121-0001')).rejects.toMatchObject({ status: 409 });
      expect(m.root.orders['GM-261121-0001'].status).toBe(st);
    }
    const m = memDb({ orders: { 'GM-261121-0001': order('placed', { uid: 'someone-else' }) } });
    await expect(customerCancelOrder(req(), m, ctx, 'GM-261121-0001')).rejects.toMatchObject({ status: 404 });
  });
});

describe('shipping without a free-delivery amount', () => {
  it('empty free_above = always charge (COD), prepaid 0 still free', () => {
    const rule = { fee: 49, free_above: null, prepaid_fee: 0 };
    expect(shippingFor(5000, shippingRuleFor(rule, 'cod'))).toBe(49);
    expect(shippingFor(5000, shippingRuleFor(rule, 'razorpay'))).toBe(0);
    expect(validateSettingsInput({ shipping: { fee: 49, free_above: '', prepaid_fee: 0 } }, {}, {}).shipping.free_above).toBe(-1); // stored as -1, read back as null
  });
});

describe('empty free-delivery amount survives saving', () => {
  it('is read back as empty, not the 999 default', async () => {
    const { getSettings } = await import('../src/settings.js');
    const env = { __db: { get: async () => ({ shipping: { fee: 49, free_above: -1, include_equal: false } }) } };
    expect((await getSettings(env)).shipping.free_above).toBe(null);
  });
});
