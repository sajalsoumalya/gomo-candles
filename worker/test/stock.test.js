import { describe, it, expect } from 'vitest';
import { stockNeeds, reserveStock, releaseStock } from '../src/stock.js';
import { priceCart } from '../src/pricing.js';

const catalog = {
  productsById: { candle: { id: 'candle', stock: 3 }, sachet: { id: 'sachet', stock: null }, spray: { id: 'spray', stock: 10 } },
  offersById: { trio: { id: 'trio', items: [{ product_id: 'candle', qty: 1 }, { product_id: 'sachet', qty: 1 }, { product_id: 'spray', qty: 1 }] } },
};
function memDb(stock) {
  const s = { ...stock };
  return { s, __db: {
    getWithEtag: async (p) => ({ value: s[p.split('/')[1]] ?? null, etag: '1' }),
    putIfMatch: async (p, v) => { s[p.split('/')[1]] = v; return true; },
  } };
}

describe('stock', () => {
  it('expands combos and skips untracked products', () => {
    expect(stockNeeds([{ kind: 'offer', ref_id: 'trio', qty: 2 }, { kind: 'product', ref_id: 'candle', qty: 1 }], catalog)).toEqual({ candle: 3, spray: 2 });
  });
  it('reserves, refuses overselling with rollback, and releases', async () => {
    const m = memDb({ candle: 3, spray: 1 });
    expect((await reserveStock(m, { candle: 2 })).ok).toBe(true);
    expect(m.s.candle).toBe(1);
    expect(await reserveStock(m, { candle: 1, spray: 2 })).toMatchObject({ ok: false, failed: 'spray' });
    expect(m.s.candle).toBe(1); // rolled back
    await releaseStock(m, { candle: 2 });
    expect(m.s.candle).toBe(3);
  });
  it('blocks a cart that asks for more than is left', () => {
    const products = { candle: { id: 'candle', name: 'Evil Eye Candle', published: true, orderable: true, in_stock: true, price: 449, stock: 2 } };
    const r = priceCart([{ type: 'product', id: 'candle', qty: 3 }], { products, offers: {} }, { free_above: 999, fee: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/Only 2/);
  });
});
