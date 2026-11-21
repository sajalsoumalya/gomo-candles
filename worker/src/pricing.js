// Pure pricing helpers — shared by catalog, checkout and tests. Amounts are whole rupees.

export const MAX_QTY = 20;
export const MAX_LINES = 20;

export function isOfferLive(offer, now = Date.now()) {
  if (!offer || !offer.published) return false;
  if (offer.starts_at && Date.parse(offer.starts_at) > now) return false;
  if (offer.ends_at && Date.parse(offer.ends_at) < now) return false;
  return true;
}

/** What the offer's items are worth at MRP (falls back to the selling price for items with no MRP). Savings = this − offer price. */
export function offerCompareAt(offer, productsById) {
  return (offer.items || []).reduce((sum, it) => {
    const p = productsById[it.product_id];
    return sum + Math.max(p?.mrp || 0, p?.price || 0) * it.qty;
  }, 0);
}

export function offerTax(offer, productsById) {
  const ps = (offer.items || []).map((it) => productsById[it.product_id]).filter(Boolean);
  const main = ps.slice().sort((a, b) => (b.price || 0) - (a.price || 0))[0];
  const rates = ps.map((p) => p.gst_rate).filter((r) => r != null);
  return { hsn: main?.hsn || null, gst_rate: rates.length ? Math.max(...rates) : null };
}

export function offerContents(offer, productsById) {
  return (offer.items || []).map((it) => `${it.qty} × ${productsById[it.product_id]?.name || it.product_id}`).join(', ');
}

/** Shipping rule for a payment method. shipping.prepaid_fee: null = same as COD, 0 = free for online payment, n = that fee. */
export function shippingRuleFor(rule, method) {
  if (!rule || method !== 'razorpay' || rule.prepaid_fee == null) return rule;
  return { ...rule, fee: rule.prepaid_fee };
}

export function shippingFor(subtotal, rule) {
  if (!rule || subtotal <= 0) return 0;
  const fee = Math.max(0, Math.round(Number(rule.fee) || 0));
  if (rule.free_above == null || rule.free_above === '') return fee; // no free-shipping amount
  const above = Number(rule.free_above) || 0;
  const free = rule.include_equal ? subtotal >= above : subtotal > above;
  return free ? 0 : fee;
}

/**
 * Price a cart on the server. `catalog` = { products: {id: product}, offers: {id: offer} } containing
 * ALL rows (published or not) so we can give precise errors. Client prices are never trusted.
 */
export function priceCart(items, catalog, shippingRule, now = Date.now()) {
  const errors = [];
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, errors: ['Your cart is empty.'] };
  }
  if (items.length > MAX_LINES) return { ok: false, errors: ['Too many items in one order.'] };

  // merge duplicates
  const merged = new Map();
  for (const raw of items) {
    const type = raw?.type === 'offer' ? 'offer' : raw?.type === 'product' ? 'product' : null;
    const id = typeof raw?.id === 'string' ? raw.id.slice(0, 64) : '';
    const qty = Math.floor(Number(raw?.qty));
    if (!type || !id || !Number.isFinite(qty) || qty < 1) {
      errors.push('An item in your cart is invalid.');
      continue;
    }
    const key = `${type}:${id}`;
    merged.set(key, { type, id, qty: (merged.get(key)?.qty || 0) + qty });
  }

  const lines = [];
  for (const { type, id, qty } of merged.values()) {
    if (qty > MAX_QTY) {
      errors.push(`You can order up to ${MAX_QTY} of each item.`);
      continue;
    }
    if (type === 'product') {
      const p = catalog.products[id];
      if (!p || !p.published) { errors.push('An item in your cart is no longer available.'); continue; }
      if (!p.orderable || !(p.price > 0)) { errors.push(`${p.name} can't be ordered online — please message us on WhatsApp.`); continue; }
      if (!p.in_stock) { errors.push(`${p.name} is out of stock.`); continue; }
      if (p.stock != null && qty > p.stock) { errors.push(`Only ${p.stock} ${p.name} left — please reduce the quantity.`); continue; }
      lines.push({
        kind: 'product', ref_id: p.id, name: p.name, contents: null,
        unit_price: p.price, compare_unit_price: p.price, qty, line_total: p.price * qty,
        hsn: p.hsn || null, gst_rate: p.gst_rate ?? null,
      });
    } else {
      const o = catalog.offers[id];
      if (!o || !isOfferLive(o, now)) { errors.push('An offer in your cart has ended.'); continue; }
      const missing = o.items.find((it) => {
        const p = catalog.products[it.product_id];
        return !p || !p.published || !p.in_stock;
      });
      if (missing) { errors.push(`${o.name} is currently unavailable.`); continue; }
      const compare = offerCompareAt(o, catalog.products);
      lines.push({
        kind: 'offer', ref_id: o.id, name: o.name, contents: offerContents(o, catalog.products),
        unit_price: o.price, compare_unit_price: compare, qty, line_total: o.price * qty,
        // A combo is billed as one supply: HSN of its main (most expensive) product, highest GST rate among its products.
        ...offerTax(o, catalog.products),
      });
    }
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };

  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const compare_total = lines.reduce((s, l) => s + l.compare_unit_price * l.qty, 0);
  const savings = Math.max(0, compare_total - subtotal);
  const shipping = shippingFor(subtotal, shippingRule);
  return { ok: true, lines, subtotal, compare_total, savings, shipping, total: subtotal + shipping };
}
