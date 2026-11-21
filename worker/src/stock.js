// Stock quantities. products/{id}/stock = number (tracked) or null/absent (not tracked).
// Reserved when an order is placed, returned when it is cancelled. Uses compare-and-set so two orders can't oversell.

import { db } from './db.js';

/** How many of each tracked product an order needs (offers expand to their products). */
export function stockNeeds(lines, catalog) {
  const need = {};
  for (const l of lines) {
    if (l.kind === 'product') need[l.ref_id] = (need[l.ref_id] || 0) + l.qty;
    else for (const it of catalog.offersById[l.ref_id]?.items || []) need[it.product_id] = (need[it.product_id] || 0) + it.qty * l.qty;
  }
  for (const id of Object.keys(need)) if (catalog.productsById[id]?.stock == null) delete need[id];
  return need;
}

async function adjust(env, id, delta) {
  const d = db(env);
  for (let i = 0; i < 8; i++) {
    const { value, etag } = await d.getWithEtag(`products/${id}/stock`);
    if (value == null) return true; // stopped tracking meanwhile
    const next = Number(value) + delta;
    if (next < 0) return false;
    if (await d.putIfMatch(`products/${id}/stock`, next, etag)) return true;
  }
  return false;
}

/** Take stock for an order. Returns { ok, failed } and rolls back on failure. */
export async function reserveStock(env, need) {
  const done = [];
  for (const [id, qty] of Object.entries(need)) {
    if (!(await adjust(env, id, -qty))) {
      for (const [rid, rq] of done) await adjust(env, rid, rq);
      return { ok: false, failed: id };
    }
    done.push([id, qty]);
  }
  return { ok: true };
}

export async function releaseStock(env, need) {
  for (const [id, qty] of Object.entries(need || {})) await adjust(env, id, qty);
}
