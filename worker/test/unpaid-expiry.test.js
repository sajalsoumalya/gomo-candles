import { describe, it, expect } from 'vitest';
import { expireUnpaidOrders, releaseHeldStock } from '../src/orders.js';

// Tiny in-memory RTDB: nested object, path get/put/patch, etag = JSON of the value.
function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => {
    const ks = seg(p), last = ks.pop();
    const parent = ks.reduce((o, k) => (o[k] ??= {}), root);
    if (v == null) delete parent[last]; else parent[last] = structuredClone(v);
  };
  return {
    root,
    __db: {
      get: async (p, q) => {
        const v = get(p);
        if (q?.orderBy === 'created_at' && v) return Object.fromEntries(Object.entries(v).filter(([, o]) => o.created_at >= q.startAt && o.created_at <= q.endAt));
        return structuredClone(v);
      },
      put: async (p, v) => put(p, v),
      patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(`${p}/${k}`, x); },
      remove: async (p) => put(p, null),
      getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
      putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
    },
  };
}

const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const order = (no, min, extra = {}) => ({ order_no: no, created_at: ago(min), updated_at: ago(min), status: 'placed',
  payment_method: 'razorpay', payment_status: 'pending', stock_held: { candle: 2 }, coupon_code: null, ...extra });

describe('unpaid online orders', () => {
  it('cancels only old, unpaid online orders and gives their stock back', async () => {
    const m = memDb({
      products: { candle: { stock: 4 } },
      orders: {
        OLD: order('OLD', 45),
        NEW: order('NEW', 10),
        RETRIED: order('RETRIED', 60, { updated_at: ago(5) }),
        PAID: order('PAID', 60, { payment_status: 'paid' }),
        COD: order('COD', 60, { payment_method: 'cod' }),
      },
    });
    const r = await expireUnpaidOrders(m, { now: NOW });
    expect(r.expired).toEqual(['OLD']);
    expect(m.root.orders.OLD.status).toBe('cancelled');
    expect(m.root.orders.OLD.stock_held).toBeUndefined();
    expect(m.root.orders.OLD.stock_released).toEqual({ candle: 2 });
    expect(m.root.products.candle.stock).toBe(6);
    for (const k of ['NEW', 'RETRIED', 'PAID', 'COD']) expect(m.root.orders[k].status).toBe('placed');
    // running again changes nothing
    expect((await expireUnpaidOrders(m, { now: NOW })).expired).toEqual([]);
    expect(m.root.products.candle.stock).toBe(6);
  });

  it('releases held stock only once, even if called twice', async () => {
    const m = memDb({ products: { candle: { stock: 1 } }, orders: { A: order('A', 5) } });
    await Promise.all([releaseHeldStock(m, 'A'), releaseHeldStock(m, 'A')]);
    expect(m.root.products.candle.stock).toBe(3);
  });
});
