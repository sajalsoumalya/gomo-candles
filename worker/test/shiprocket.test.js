import { describe, it, expect, vi, afterEach } from 'vitest';
import { bookShipment, syncShipment, cancelShipment, courierWebhook, mapCourierStatus, buildShiprocketOrder } from '../src/shiprocket.js';
import { areaFor } from '../src/staff.js';

function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => {
    const ks = seg(p), last = ks.pop();
    if (last === undefined) return;
    const parent = ks.reduce((o, k) => (o[k] ??= {}), root);
    if (v == null) delete parent[last]; else parent[last] = structuredClone(v);
  };
  return {
    root,
    __db: {
      get: async (p) => structuredClone(get(p)),
      put: async (p, v) => put(p, v),
      patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); },
      remove: async (p) => put(p, null),
      getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
      putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
    },
  };
}

const NO = 'GM-261121-0007';
const order = (extra = {}) => ({
  order_no: NO, created_at: '2026-11-21T10:00:00.000Z', status: 'confirmed', customer_name: 'Asha Roy Sen', phone: '9876543210', email: null,
  address_line1: '12 Lake Road', address_line2: 'Flat 3B', landmark: 'Near the park', city: 'Kolkata', state: 'West Bengal', pincode: '700029',
  subtotal: 898, shipping: 60, discount: 100, total: 858, payment_method: 'cod', payment_status: 'pending',
  items: [
    { kind: 'product', ref_id: 'candle', name: 'Evil Eye Candle', qty: 1, unit_price: 449, line_total: 449, hsn: '3406', gst_rate: 5 },
    { kind: 'product', ref_id: 'sachet', name: 'Evil Eye Sachets', qty: 1, unit_price: 449, line_total: 449, hsn: '3307', gst_rate: 18 },
  ],
  events: {}, ...extra,
});
const KEYS = { SHIPROCKET_EMAIL: 'api@gomo.in', SHIPROCKET_PASSWORD: 'pw' };
const setup = (o = order(), extra = {}) => {
  const m = memDb({ orders: { [NO]: o }, settings: { store: { email: 'support@gomo.in' } } });
  return { m, env: { ...m, ...KEYS, ...extra } };
};
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const admin = { email: 'packer@gomo.in' };

/** Pretend Shiprocket. `over` replaces any endpoint's reply: { 'create': fn | Response, ... } */
function shiprocket(over = {}) {
  const calls = [];
  const reply = (name, dflt, url, init) => { const o = over[name]; return typeof o === 'function' ? o(url, init) : o ?? dflt; };
  const f = vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: url.replace('https://apiv2.shiprocket.in/v1/external', ''), body, auth: init.headers?.authorization });
    if (url.endsWith('/auth/login')) return reply('login', res(200, { token: 'tok1' }), url, init);
    if (url.endsWith('/settings/company/pickup')) return reply('pickups', res(200, { data: { shipping_address: [
      { pickup_location: 'Home', status: 2, phone_verified: 1, is_primary_location: 1, city: 'Kolkata', pin_code: '700029' },
      { pickup_location: 'Old', status: 0, phone_verified: 1, is_primary_location: 0 } ] } }), url, init);
    if (url.endsWith('/orders/create/adhoc')) return reply('create', res(200, { order_id: 5001, shipment_id: 6001, status: 'NEW' }), url, init);
    if (/\/orders\/show\/\d+$/.test(url)) return reply('show', res(200, { data: { id: 5001, total: 858 } }), url, init);
    if (url.endsWith('/courier/assign/awb')) return reply('awb', res(200, { awb_assign_status: 1, response: { data: { awb_code: 'AWB123', courier_company_id: 43, courier_name: 'Delhivery Surface' } } }), url, init);
    if (url.endsWith('/courier/generate/pickup')) return reply('pickup', res(200, { pickup_status: 1, response: { pickup_scheduled_date: '2026-11-22 12:00:00', pickup_token_number: 'Ref 1' } }), url, init);
    if (url.endsWith('/courier/generate/label')) return reply('label', res(200, { label_created: 1, label_url: 'https://sr/label.pdf' }), url, init);
    if (url.endsWith('/manifests/generate')) return reply('manifest', res(200, { status: 1, manifest_url: 'https://sr/manifest.pdf' }), url, init);
    if (url.endsWith('/orders/cancel')) return reply('cancel', res(200, { message: 'Order cancelled' }), url, init);
    if (/\/courier\/track\/awb\//.test(url)) return reply('track', res(200, { tracking_data: { track_status: 1, shipment_track: [{ current_status: 'IN TRANSIT' }], track_url: 'https://shiprocket.co/tracking/AWB123' } }), url, init);
    return res(404, { message: 'unknown' });
  });
  return { f, calls, called: (path) => calls.filter((c) => c.url.startsWith(path)) };
}
afterEach(() => vi.unstubAllGlobals());

describe('Shiprocket order payload', () => {
  it('collects exactly the order total on COD and sends GST/HSN per item', () => {
    const o = order();
    const p = buildShiprocketOrder(o, o.items, { store: { email: 'support@gomo.in' }, invoice: { hsn: '3406', gst_rate: 5 } }, { weight: 0.6, length: 15, breadth: 12, height: 10 }, '261121-0007', 'Home');
    expect(p).toMatchObject({ order_id: '261121-0007', pickup_location: 'Home', payment_method: 'COD', shipping_charges: 60, total_discount: 100, sub_total: 798,
      billing_customer_name: 'Asha', billing_last_name: 'Roy Sen', billing_pincode: 700029, billing_phone: 9876543210, billing_email: 'support@gomo.in', billing_country: 'India' });
    expect(p.sub_total + p.shipping_charges).toBe(o.total);
    expect(p.billing_address).toContain('Landmark: Near the park');
    expect(p.order_items[1]).toMatchObject({ units: 1, selling_price: 449, tax: 18, hsn: 3307 });
  });
  it('prepaid (paid online) orders collect nothing', () => {
    const o = order({ payment_method: 'razorpay', payment_status: 'paid' });
    expect(buildShiprocketOrder(o, o.items, { store: {}, invoice: {} }, { weight: 1, length: 1, breadth: 1, height: 1 }, 'x', 'Home').payment_method).toBe('Prepaid');
  });
});

describe('Book pickup', () => {
  it('runs every step, fills the courier details and moves the order to Packed', async () => {
    const { m, env } = setup();
    const sr = shiprocket();
    const r = await bookShipment(env, NO, { weight_kg: 0.6 }, admin, sr.f);
    expect(r.steps).toEqual(['create', 'awb', 'pickup']);
    expect(r.moved).toBe('packed');
    const create = sr.called('/orders/create/adhoc')[0];
    expect(create.body).toMatchObject({ order_id: '261121-0007', pickup_location: 'Home', weight: 0.6, payment_method: 'COD' });
    expect(create.auth).toBe('Bearer tok1');
    const o = m.root.orders[NO];
    expect(o).toMatchObject({ status: 'packed', courier: 'Delhivery Surface', tracking_no: 'AWB123', tracking_url: 'https://shiprocket.co/tracking/AWB123' });
    expect(o.shiprocket).toMatchObject({ shipment_id: 6001, sr_order_id: 5001, awb: 'AWB123', pickup_requested: true, label_url: 'https://sr/label.pdf', manifest_url: 'https://sr/manifest.pdf', cod_amount: 858, error: null });
    expect(m.root.shiprocket.awb.AWB123).toBe(NO);
    expect(m.root.shiprocket.active[NO]).toBe(true);
    expect(m.root.shiprocket.token.token).toBe('tok1');
  });

  it('a failed step is saved and pressing again continues without creating a second Shiprocket order', async () => {
    const { m, env } = setup();
    const sr = shiprocket({ awb: res(200, { awb_assign_status: 0, response: { data: { awb_assign_error: 'Insufficient wallet balance' } } }) });
    await expect(bookShipment(env, NO, {}, admin, sr.f)).rejects.toThrow(/Insufficient wallet balance/);
    expect(m.root.orders[NO].shiprocket).toMatchObject({ shipment_id: 6001, error: { step: 'awb' } });
    expect(m.root.orders[NO].status).toBe('confirmed');
    const sr2 = shiprocket();
    const r = await bookShipment(env, NO, {}, admin, sr2.f);
    expect(r.steps).toEqual(['awb', 'pickup']);
    expect(sr2.called('/orders/create/adhoc')).toHaveLength(0);
    expect(m.root.orders[NO].tracking_no).toBe('AWB123');
  });

  it("cancels the Shiprocket order if its total differs from ours (the courier would collect the wrong cash)", async () => {
    const { m, env } = setup();
    const sr = shiprocket({ show: res(200, { data: { id: 5001, total: 918 } }) });
    await expect(bookShipment(env, NO, {}, admin, sr.f)).rejects.toThrow(/₹918.*₹858/);
    expect(sr.called('/orders/cancel')[0].body).toEqual({ ids: [5001] });
    expect(sr.called('/courier/assign/awb')).toHaveLength(0);
    expect(m.root.orders[NO].shiprocket.shipment_id).toBeNull();
    // next try uses a new Shiprocket order id (Shiprocket never reuses one)
    const sr2 = shiprocket();
    await bookShipment(env, NO, {}, admin, sr2.f);
    expect(sr2.called('/orders/create/adhoc')[0].body.order_id).toBe('261121-0007-2');
  });

  it('refuses unpaid online orders, cancelled orders, and bad parcel sizes', async () => {
    await expect(bookShipment(setup(order({ payment_method: 'razorpay' })).env, NO, {}, admin, shiprocket().f)).rejects.toMatchObject({ status: 409 });
    await expect(bookShipment(setup(order({ status: 'cancelled' })).env, NO, {}, admin, shiprocket().f)).rejects.toMatchObject({ status: 409 });
    await expect(bookShipment(setup().env, NO, { weight_kg: 0 }, admin, shiprocket().f)).rejects.toMatchObject({ status: 422 });
  });

  it('asks for a pickup address when the account has several and none is chosen', async () => {
    const sr = shiprocket({ pickups: res(200, { data: { shipping_address: [
      { pickup_location: 'A', status: 2, phone_verified: 1, is_primary_location: 0 }, { pickup_location: 'B', status: 2, phone_verified: 1, is_primary_location: 0 }] } }) });
    await expect(bookShipment(setup().env, NO, {}, admin, sr.f)).rejects.toThrow(/Settings → Shipping/);
  });

  it('signs in again once when the saved token has expired at Shiprocket', async () => {
    const { m, env } = setup();
    m.root.shiprocket = { token: { token: 'old', expires_at: Date.now() + 1e6 } };
    let first = true;
    const sr = shiprocket({ pickups: (url, init) => {
      if (init.headers.authorization === 'Bearer old' && first) { first = false; return res(401, { message: 'Token expired' }); }
      return res(200, { data: { shipping_address: [{ pickup_location: 'Home', status: 2, phone_verified: 1, is_primary_location: 1 }] } });
    } });
    await bookShipment(env, NO, {}, admin, sr.f);
    expect(sr.called('/auth/login')).toHaveLength(1);
    expect(m.root.shiprocket.token.token).toBe('tok1');
  });

  it('is clear when Shiprocket is not connected', async () => {
    const m = memDb({ orders: { [NO]: order() }, settings: {} });
    await expect(bookShipment({ ...m }, NO, {}, admin, shiprocket().f)).rejects.toThrow(/SHIPROCKET_EMAIL/);
  });
});

describe('Tracking', () => {
  const booked = (extra = {}) => order({ status: 'packed', courier: 'Delhivery', tracking_no: 'AWB123', shiprocket: { sr_order_id: 5001, shipment_id: 6001, awb: 'AWB123', pickup_requested: true }, ...extra });

  it('maps courier statuses, never to cancelled', () => {
    expect(mapCourierStatus('PICKED UP')).toBe('shipped');
    expect(mapCourierStatus('IN TRANSIT')).toBe('shipped');
    expect(mapCourierStatus('OUT FOR DELIVERY')).toBe('out_for_delivery');
    expect(mapCourierStatus('DELIVERED')).toBe('delivered');
    expect(mapCourierStatus('RTO DELIVERED')).toBeNull();
    expect(mapCourierStatus('UNDELIVERED')).toBeNull();
    expect(mapCourierStatus('CANCELED')).toBeNull();
    expect(mapCourierStatus('PICKUP SCHEDULED')).toBeNull();
  });

  it('moves the order forward from the courier status', async () => {
    const { m, env } = setup(booked());
    const r = await syncShipment(env, NO, { notify: false }, shiprocket({ track: res(200, { tracking_data: { shipment_track: [{ current_status: 'OUT FOR DELIVERY' }], track_url: 'https://shiprocket.co/tracking/AWB123' } }) }).f);
    expect(r.moved).toBe('out_for_delivery');
    expect(m.root.orders[NO].status).toBe('out_for_delivery');
    expect(m.root.orders[NO].shiprocket.picked_up).toBe(true);
  });

  it('never moves an order back, and flags returns for a person', async () => {
    const { m, env } = setup(booked({ status: 'delivered' }));
    await syncShipment(env, NO, { notify: false }, shiprocket({ track: res(200, { tracking_data: { shipment_track: [{ current_status: 'IN TRANSIT' }] } }) }).f);
    expect(m.root.orders[NO].status).toBe('delivered');
    const t = setup(booked({ status: 'shipped' }));
    await syncShipment(t.env, NO, { notify: false }, shiprocket({ track: res(200, { tracking_data: { shipment_track: [{ current_status: 'RTO INITIATED' }] } }) }).f);
    expect(t.m.root.orders[NO].status).toBe('shipped');
    expect(t.m.root.orders[NO].shiprocket.attention).toBe('RTO INITIATED');
  });

  it('webhook: only re-reads Shiprocket for a known AWB, and checks the token', async () => {
    const { m, env } = setup(booked(), { SHIPROCKET_WEBHOOK_TOKEN: 'tok-xyz' });
    m.root.shiprocket = { awb: { AWB123: NO } };
    const sr = shiprocket({ track: res(200, { tracking_data: { shipment_track: [{ current_status: 'DELIVERED' }] } }) });
    vi.stubGlobal('fetch', sr.f);
    const call = (body, token) => courierWebhook(new Request('https://x/api/courier/webhook', { method: 'POST', body: JSON.stringify(body), headers: token ? { 'x-api-key': token } : {} }), env, null);
    expect((await call({ awb: 'AWB123', current_status: 'DELIVERED' }, 'wrong')).status).toBe(401);
    expect((await call({ awb: 'NOPE', current_status: 'DELIVERED' }, 'tok-xyz')).status).toBe(200);
    expect(sr.called('/courier/track')).toHaveLength(0);
    // the payload's status is ignored; Shiprocket's API is the source
    await call({ awb: 'AWB123', current_status: 'CANCELED' }, 'tok-xyz');
    expect(sr.called('/courier/track')).toHaveLength(1);
    expect(m.root.orders[NO].status).toBe('delivered');
  });
});

describe('Cancel shipment', () => {
  it('cancels before pickup and clears the courier details', async () => {
    const { m, env } = setup(order({ status: 'packed', courier: 'Delhivery', tracking_no: 'AWB123', tracking_url: 'https://shiprocket.co/tracking/AWB123', shiprocket: { sr_order_id: 5001, shipment_id: 6001, awb: 'AWB123', attempt: 1 } }));
    const sr = shiprocket();
    await cancelShipment(env, NO, admin, sr.f);
    expect(sr.called('/orders/cancel')[0].body).toEqual({ ids: [5001] });
    expect(m.root.orders[NO].courier).toBeUndefined();
    expect(m.root.orders[NO].tracking_no).toBeUndefined();
    expect(m.root.orders[NO].tracking_url).toBeUndefined();
    expect(m.root.orders[NO].shiprocket.history[0]).toMatchObject({ awb: 'AWB123' });
  });
  it('refuses once the courier has picked it up', async () => {
    const { env } = setup(order({ status: 'shipped', shiprocket: { sr_order_id: 5001, shipment_id: 6001, awb: 'AWB123', picked_up: true } }));
    await expect(cancelShipment(env, NO, admin, shiprocket().f)).rejects.toMatchObject({ status: 409 });
  });
});

describe('permissions', () => {
  it('packers can book pickups; pickup-address settings need the shipping settings permission', () => {
    expect(areaFor('POST', `/api/admin/orders/${NO}/shiprocket/book`)).toBe('orders');
    expect(areaFor('GET', '/api/admin/shiprocket/pickups')).toBe('set_shipping');
  });
});
