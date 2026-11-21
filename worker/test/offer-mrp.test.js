import { it, expect } from 'vitest';
import { offerCompareAt, priceCart } from '../src/pricing.js';

it('combo savings are MRP total minus offer price (selling price used when no MRP)', () => {
  const products = { candle: { id: 'candle', name: 'Candle', price: 449, mrp: 999, published: true, orderable: true, in_stock: true },
    sachet: { id: 'sachet', name: 'Sachet', price: 199, mrp: 0, published: true, orderable: true, in_stock: true } };
  const offer = { id: 'c', name: 'Combo', price: 500, published: true, items: [{ product_id: 'candle', qty: 1 }, { product_id: 'sachet', qty: 1 }] };
  expect(offerCompareAt(offer, products)).toBe(999 + 199);
  const r = priceCart([{ type: 'offer', id: 'c', qty: 2 }], { products, offers: { c: offer } }, { free_above: 0, fee: 0 });
  expect(r.savings).toBe((1198 - 500) * 2);
});
