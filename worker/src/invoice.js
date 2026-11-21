// Invoices. Prices are GST-inclusive, so taxable value and tax are worked out backwards from each line total.
// Without a GSTIN in Settings the invoice is a plain "Invoice" (no tax lines); with one it is a "Tax Invoice"
// (CGST + SGST when the buyer is in the seller's state, otherwise IGST).
// Numbers are sequential per Indian financial year (Apr–Mar, IST), e.g. GM/26-27/0001, assigned once and never changed.

import { HttpError, json, nowIso } from './util.js';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { loadOrder } from './orders.js';

/** Financial-year code in IST, e.g. "26-27" for 2026-11-18. */
export function fyCode(iso) {
  const ist = new Date(Date.parse(iso) + 330 * 60000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1; // April = month 3
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const invoiceNumber = (prefix, fy, n) => `${prefix}/${fy}/${String(n).padStart(4, '0')}`;

const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
const rupees = (p) => p / 100;

/** Split a GST-inclusive amount (paise) into taxable value and tax parts. */
export function splitTax(grossPaise, rate, intra) {
  const taxable = Math.round((grossPaise * 100) / (100 + rate));
  const tax = grossPaise - taxable;
  if (!intra) return { taxable, igst: tax, cgst: 0, sgst: 0, tax };
  const cgst = Math.floor(tax / 2);
  return { taxable, igst: 0, cgst, sgst: tax - cgst, tax };
}

/** Build the invoice document from an order and its stored invoice record (pure, testable). */
export function computeInvoice(order, items, inv) {
  const tax = inv.mode === 'tax';
  const intra = tax && Boolean(inv.seller.state) && inv.seller.state.toLowerCase() === String(order.state || '').toLowerCase();
  const rate = Number(inv.rate) || 0;
  const rows = items.map((i) => ({ name: i.name, contents: i.contents ?? null, hsn: inv.hsn, qty: i.qty, unit_price: i.unit_price, gross: paise(i.line_total) }));
  if (order.discount) rows.push({ name: `Discount${order.coupon_code ? ` (coupon ${order.coupon_code})` : ''}`, contents: null, hsn: inv.hsn, qty: 1, unit_price: -order.discount, gross: -paise(order.discount) });
  if (order.shipping) rows.push({ name: 'Shipping charges', contents: null, hsn: '9965', qty: 1, unit_price: order.shipping, gross: paise(order.shipping) });

  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, gross: 0 };
  const lines = rows.map((r) => {
    const t = tax ? splitTax(r.gross, rate, intra) : { taxable: r.gross, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'tax']) totals[k] += t[k];
    totals.gross += r.gross;
    return { name: r.name, contents: r.contents, hsn: r.hsn, qty: r.qty, unit_price: r.unit_price, amount: rupees(r.gross),
      taxable: rupees(t.taxable), cgst: rupees(t.cgst), sgst: rupees(t.sgst), igst: rupees(t.igst) };
  });

  return {
    title: tax ? 'Tax Invoice' : 'Invoice',
    number: inv.number, issued_at: inv.issued_at, mode: inv.mode, rate, tax_type: tax ? (intra ? 'cgst_sgst' : 'igst') : null,
    seller: inv.seller,
    buyer: {
      name: order.customer_name, phone: order.phone, email: order.email || null,
      address: [order.address_line1, order.address_line2, order.landmark].filter(Boolean).join(', '),
      city: order.city, state: order.state, pincode: order.pincode,
    },
    order: { order_no: order.order_no, created_at: order.created_at, status: order.status, payment_method: order.payment_method, payment_status: order.payment_status },
    lines,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, rupees(v)])),
    savings: order.savings || 0,
    cancelled: order.status === 'cancelled',
  };
}

/** Increment invoice_counters/{fy} with compare-and-set; returns the new number. */
async function nextCounter(env, fy) {
  const d = db(env);
  for (let i = 0; i < 8; i++) {
    const { value, etag } = await d.getWithEtag(`invoice_counters/${fy}`);
    const n = (Number(value) || 0) + 1;
    if (await d.putIfMatch(`invoice_counters/${fy}`, n, etag)) return n;
  }
  throw new HttpError(503, 'Could not assign an invoice number, please try again.');
}

/** Return the invoice for an order, assigning its number the first time. */
export async function getInvoice(env, orderNo) {
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const { order, items } = found;
  if (order.invoice?.number) return computeInvoice(order, items, order.invoice);
  if (order.status === 'cancelled') throw new HttpError(409, 'A cancelled order cannot get a new invoice.');

  const { invoice: s, store } = await getSettings(env);
  const issued_at = nowIso();
  const fy = fyCode(issued_at);
  const d = db(env);
  const { value: existing, etag } = await d.getWithEtag(`orders/${orderNo}/invoice`);
  if (existing?.number) return computeInvoice(order, items, existing);

  const n = await nextCounter(env, fy);
  const inv = {
    number: invoiceNumber(s.prefix, fy, n), fy, seq: n, issued_at,
    mode: s.gstin ? 'tax' : 'plain', rate: s.gstin ? s.gst_rate : 0, hsn: s.hsn,
    seller: {
      name: s.legal_name || store.name, gstin: s.gstin || null, address: s.address || '', state: s.state || '',
      email: store.email || '', phone: store.whatsapp || '',
    },
  };
  if (!(await d.putIfMatch(`orders/${orderNo}/invoice`, inv, etag))) {
    // Someone else issued it a moment ago; use theirs.
    const again = await d.get(`orders/${orderNo}/invoice`);
    if (again?.number) return computeInvoice(order, items, again);
    throw new HttpError(503, 'Could not save the invoice, please try again.');
  }
  return computeInvoice(order, items, inv);
}

export async function adminGetInvoice(env, orderNo) {
  return json({ invoice: await getInvoice(env, orderNo) });
}
