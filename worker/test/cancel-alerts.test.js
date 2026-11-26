import { describe, it, expect, vi } from 'vitest';

const sent = [];
vi.mock('../src/account.js', async (orig) => ({ ...(await orig()), requireCustomer: async () => ({ uid: 'u1', profile: {} }) }));
vi.mock('../src/notify.js', async (orig) => ({ ...(await orig()), notifyOrderEvent: async (env, order, items, event, opts) => { sent.push({ event, opts }); return []; } }));
const shipCalls = [];
vi.mock('../src/shiprocket.js', async (orig) => ({ ...(await orig()), cancelShipmentForCancelledOrder: async (env, no, actor) => { shipCalls.push({ no, actor }); return null; } }));

const { customerCancelOrder } = await import('../src/orders.js');
const real = await vi.importActual('../src/notify.js');

function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => { const ks = seg(p), last = ks.pop(); if (last === undefined) return; const par = ks.reduce((o, k) => (o[k] ??= {}), root); if (v == null) delete par[last]; else par[last] = structuredClone(v); };
  return { root, __db: {
    get: async (p) => structuredClone(get(p)), put: async (p, v) => put(p, v),
    patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); }, remove: async (p) => put(p, null),
    getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
    putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
  } };
}
const NO = 'GM-261126-0001';
const order = (extra = {}) => ({ order_no: NO, uid: 'u1', status: 'packed', payment_method: 'cod', payment_status: 'pending', total: 499, items: { a: { name: 'Candle', qty: 1 } }, events: {}, ...extra });
const ctx = { waitUntil(p) { return p; } };

describe('customer cancel', () => {
  it('cancels the Shiprocket booking and sends the owner a "cancelled" alert, not "new order"', async () => {
    const m = memDb({ orders: { [NO]: order({ shiprocket: { sr_order_id: 1, awb: 'AWB1' } }) } });
    await customerCancelOrder(new Request('https://x', { method: 'POST', body: '{}' }), m, ctx, NO);
    expect(shipCalls.map((c) => c.no)).toContain(NO);
    const last = sent.at(-1);
    expect(last.event).toBe('cancelled');
    expect(last.opts.admin).toBe(true);
  });
});

describe('admin alert text', () => {
  it('a cancel alert never uses the "New order" template', async () => {
    const out = [];
    const env = { __db: { get: async (p) => (p === 'settings' ? { notify: { admin_whatsapp: ['919000000000'], admin_emails: [], customer_whatsapp: false, customer_email: false } } : null),
      patch: async (p, v) => { out.push(v); }, put: async (p, v) => { out.push(v); } } };
    await real.notifyOrderEvent(env, { order_no: NO, total: 499, payment_method: 'cod', cancelled_by: 'customer', items: {} }, [], 'cancelled', { whatsapp: false, email: false, admin: true }).catch((e) => out.push(String(e)));
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/New order/i);
    expect(text).toMatch(/cancelled by the customer/);
  });
});
