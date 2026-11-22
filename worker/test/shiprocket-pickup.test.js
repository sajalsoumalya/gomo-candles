import { describe, it, expect, vi } from 'vitest';
import { bookShipment, prepareBooking, shippingIssues } from '../src/shiprocket.js';
import { areaFor } from '../src/staff.js';

function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => { const ks = seg(p), last = ks.pop(); if (last === undefined) return; const parent = ks.reduce((o, k) => (o[k] ??= {}), root); if (v == null) delete parent[last]; else parent[last] = structuredClone(v); };
  return {
    root,
    __db: {
      get: async (p) => structuredClone(get(p)), put: async (p, v) => put(p, v),
      patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); }, remove: async (p) => put(p, null),
      getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
      putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
    },
  };
}
const NO = 'GM-261122-0031';
const order = (extra = {}) => ({
  order_no: NO, created_at: '2026-11-22T10:00:00.000Z', status: 'packed', customer_name: 'Rishi Sahu', phone: '9988733577', email: 'r@x.in',
  address_line1: '3 Rastraguru Avenue', address_line2: 'South Dumdum', city: 'Kolkata', state: 'West Bengal', pincode: '700028',
  subtotal: 248, shipping: 0, discount: 0, total: 248, payment_method: 'cod', payment_status: 'pending',
  items: [{ kind: 'product', ref_id: 'sachet', name: 'Evil Eye Sachets', qty: 1, unit_price: 248, line_total: 248 }], events: {}, ...extra,
});
const KEYS = { SHIPROCKET_EMAIL: 'api@gomo.in', SHIPROCKET_PASSWORD: 'pw' };
const setup = (o = order(), extra = {}) => { const m = memDb({ orders: { [NO]: o }, settings: { store: { email: 's@gomo.in' } } }); return { m, env: { ...m, ...KEYS, ...extra } }; };
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function shiprocket() {
  const calls = [];
  const f = vi.fn(async (url, init = {}) => {
    const u = url.replace('https://apiv2.shiprocket.in/v1/external', '');
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u === '/auth/login') return res(200, { token: 't' });
    if (u === '/settings/company/pickup') return res(200, { data: { shipping_address: [
      { pickup_location: 'Home', status: 2, phone_verified: 1, is_primary_location: 1, city: 'Kolkata', pin_code: '700029', address: '1 Lake Rd' },
      { pickup_location: 'Warehouse', status: 2, phone_verified: 1, is_primary_location: 0, city: 'Howrah', pin_code: '711101', address: '9 GT Rd' },
      { pickup_location: 'Old', status: 0, phone_verified: 1, is_primary_location: 0 },
    ] } });
    if (u === '/orders/create/adhoc') return res(200, { order_id: 5001, shipment_id: 6001 });
    if (/^\/orders\/show\//.test(u)) return res(200, { data: { total: 248 } });
    if (u === '/courier/assign/awb') return res(200, { awb_assign_status: 1, response: { data: { awb_code: 'AWB9', courier_name: 'Delhivery' } } });
    if (u === '/courier/generate/pickup') return res(200, { pickup_status: 1, response: {} });
    if (u === '/courier/generate/label') return res(200, { label_created: 1, label_url: 'https://sr/l.pdf' });
    if (u === '/manifests/generate') return res(200, { status: 1, manifest_url: 'https://sr/m.pdf' });
    return res(404, {});
  });
  return { f, calls, created: () => calls.find((c) => c.url === '/orders/create/adhoc')?.body };
}
const admin = { email: 'packer@gomo.in' };
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

describe('Shiprocket booking: pickup address', () => {
  it('uses the pickup address chosen on the order page', async () => {
    const { env } = setup(); const sr = shiprocket();
    await bookShipment(env, NO, { pickup_location: 'Warehouse' }, admin, sr.f);
    expect(sr.created().pickup_location).toBe('Warehouse');
  });
  it('falls back to the primary address when none is chosen', async () => {
    const { env } = setup(); const sr = shiprocket();
    await bookShipment(env, NO, {}, admin, sr.f);
    expect(sr.created().pickup_location).toBe('Home');
  });
  it('refuses an address that is not active (or not in the account) before creating anything', async () => {
    for (const name of ['Old', 'Nowhere']) {
      const { env } = setup(); const sr = shiprocket();
      const e = await err(bookShipment(env, NO, { pickup_location: name }, admin, sr.f));
      expect(e.status).toBe(422);
      expect(e.details.fields.pickup_location).toBeTruthy();
      expect(sr.created()).toBeUndefined();
    }
  });
  it('SHIPROCKET_PICKUP_LOCATION is only the default: staff can still choose another confirmed address', async () => {
    const { env } = setup(order(), { SHIPROCKET_PICKUP_LOCATION: 'Home' }); const sr = shiprocket();
    await bookShipment(env, NO, { pickup_location: 'Warehouse' }, admin, sr.f);
    expect(sr.created().pickup_location).toBe('Warehouse');
    const p = await prepareBooking(env, NO, shiprocket().f);
    expect(p).toMatchObject({ default_pickup: 'Home', pickup_locked: false });
    const { env: env2 } = setup(order(), { SHIPROCKET_PICKUP_LOCATION: 'Warehouse' }); const sr2 = shiprocket();
    await bookShipment(env2, NO, {}, admin, sr2.f);
    expect(sr2.created().pickup_location).toBe('Warehouse');
  });
});

describe('Shiprocket booking: fields Shiprocket needs', () => {
  it('weight in kg is required and checked before anything is sent', async () => {
    const { env } = setup(); const sr = shiprocket();
    const e = await err(bookShipment(env, NO, { weight_kg: '0' }, admin, sr.f));
    expect(e.status).toBe(422);
    expect(e.details.fields.weight_kg).toMatch(/kg/);
    expect(sr.calls.length).toBe(0);
    await bookShipment(env, NO, { weight_kg: '0.8' }, admin, sr.f);
    expect(sr.created().weight).toBe(0.8);
  });
  it('a bad PIN code / short address stops the booking and says which field', async () => {
    const { env } = setup(order({ pincode: '70002', address_line1: '3' })); const sr = shiprocket();
    const e = await err(bookShipment(env, NO, {}, admin, sr.f));
    expect(e.status).toBe(422);
    expect(e.details.code).toBe('shiprocket_details');
    expect(Object.keys(e.details.fields).sort()).toEqual(['address_line1', 'pincode']);
    expect(sr.calls.length).toBe(0);
  });
  it('corrections typed in the form are saved on the order and sent to Shiprocket', async () => {
    const { env, m } = setup(order({ pincode: '70002', city: 'KKolkata' })); const sr = shiprocket();
    await bookShipment(env, NO, { fix: { pincode: ' 700 028 ', city: 'Kolkata', phone: '+91 99887 33577' } }, admin, sr.f);
    expect(sr.created().billing_pincode).toBe(700028);
    expect(sr.created().billing_city).toBe('Kolkata');
    const saved = m.root.orders[NO];
    expect(saved.pincode).toBe('700028');
    expect(saved.city).toBe('Kolkata');
    expect(saved.phone).toBe('9988733577');
    expect(Object.values(saved.events).some((x) => x.type === 'note' && /corrected/.test(x.note) && x.actor === 'packer@gomo.in')).toBe(true);
  });
  it('corrections that are still wrong are refused', async () => {
    const { env } = setup(order({ pincode: '70002' })); const sr = shiprocket();
    const e = await err(bookShipment(env, NO, { fix: { pincode: '12' } }, admin, sr.f));
    expect(e.status).toBe(422);
    expect(e.details.fields.pincode).toBeTruthy();
    expect(sr.calls.length).toBe(0);
  });
  it('shippingIssues: a complete order has none', () => {
    expect(shippingIssues(order())).toEqual({});
    expect(Object.keys(shippingIssues(order({ phone: '12345', state: 'Bengal' }))).sort()).toEqual(['phone', 'state']);
  });
});

describe('prepare booking', () => {
  it('lists pickup addresses, picks the default and reports what to fix', async () => {
    const { env } = setup(order({ pincode: '7000' })); const sr = shiprocket();
    const p = await prepareBooking(env, NO, sr.f);
    expect(p.pickups.map((x) => [x.name, x.active])).toEqual([['Home', true], ['Warehouse', true], ['Old', false]]);
    expect(p.default_pickup).toBe('Home');
    expect(p.issues).toEqual({ pincode: expect.any(String) });
    expect(p.parcel).toHaveProperty('weight_kg');
  });
  it('a Shiprocket error still returns the form (with the message)', async () => {
    const { env } = setup(); const f = vi.fn(async () => res(500, { message: 'down' }));
    const p = await prepareBooking(env, NO, f);
    expect(p.pickups).toEqual([]);
    expect(p.pickups_error).toBeTruthy();
  });
  it('packers (orders permission) can open it', () => {
    expect(areaFor('GET', `/api/admin/orders/${NO}/shiprocket/prepare`)).toBe('orders');
  });
});
