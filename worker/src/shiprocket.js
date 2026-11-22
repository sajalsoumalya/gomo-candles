// Shiprocket: book the courier pickup for an order from the admin panel, and keep its status in sync.
// API docs: https://apidocs.shiprocket.in  (secrets: SHIPROCKET_EMAIL + SHIPROCKET_PASSWORD of an "API user",
// created in Shiprocket → Settings → API; optional SHIPROCKET_WEBHOOK_TOKEN for the tracking webhook).
//
// Booking runs these steps; each result is saved on the order (order.shiprocket) as soon as it succeeds, so
// pressing the button again after a failure (e.g. low wallet balance) continues where it stopped:
//   1. create order (orders/create/adhoc) and check Shiprocket's total matches ours (it is what COD collects)
//   2. assign courier + AWB (courier/assign/awb)          3. request pickup (courier/generate/pickup)
//   4. label + manifest PDFs (not fatal if they fail; they can be fetched again)

import { HttpError, json, nowIso, readJson, STATUS_LABELS } from './util.js';
import { db, pushKey } from './db.js';
import { getSettings } from './settings.js';
import { notifyOrderEvent } from './notify.js';
import { INDIAN_STATES, normalizePhone } from './validate.js';

const API = 'https://apiv2.shiprocket.in/v1/external';
const TOKEN_PATH = 'shiprocket/token';
const TOKEN_DAYS = 9; // Shiprocket tokens last 10 days (240 h); renew a day early
const ACTIVE = 'shiprocket/active'; // {order_no: true} shipments still moving, polled by the cron
const AWB_INDEX = 'shiprocket/awb'; // {awb: order_no} so webhook calls can find the order
const FLOW = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];

export const shiprocketReady = (env) => Boolean(env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD);

const short = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const event = (type, status, note, actor) => ({ created_at: nowIso(), type, status: status ?? null, note: note ?? null, actor: actor ?? null });

// ------------------------------------------------------------------ HTTP

/** Readable message from a Shiprocket error body ({message}, {errors: {field: [..]}}, ...). */
export function srError(data, status) {
  if (!data || typeof data !== 'object') return `Shiprocket replied HTTP ${status}`;
  const errs = data.errors && typeof data.errors === 'object'
    ? Object.entries(data.errors).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('; ') : '';
  return short([data.message, errs].filter(Boolean).join(' — ') || `Shiprocket replied HTTP ${status}`);
}

async function login(env, f) {
  const res = await f(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.token) {
    throw new HttpError(502, `Shiprocket sign-in failed: ${srError(data, res.status)}. Check SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD (use an API user from Shiprocket → Settings → API).`, { code: 'shiprocket_auth' });
  }
  const token = { token: data.token, expires_at: Date.now() + TOKEN_DAYS * 864e5 };
  await db(env).put(TOKEN_PATH, token).catch((e) => console.error('save shiprocket token', e));
  return token.token;
}

async function token(env, f, fresh) {
  if (!fresh) {
    const saved = await db(env).get(TOKEN_PATH).catch(() => null);
    if (saved?.token && saved.expires_at > Date.now()) return saved.token;
  }
  return login(env, f);
}

/** Call the Shiprocket API. Returns { ok, status, data }; renews the token once on 401. */
export async function srCall(env, method, path, body, f = fetch) {
  if (!shiprocketReady(env)) throw new HttpError(503, 'Shiprocket is not connected. Add SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD to the server.', { code: 'shiprocket_not_set' });
  let res, data;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(env, f, attempt > 0);
    res = await f(API + path, {
      method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status !== 401) break;
  }
  data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ------------------------------------------------------------------ building the Shiprocket order

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Parcel size/weight for an order: values typed on the order page, else the defaults from Settings → Shipping. */
export function parcelFor(body, cfg) {
  const num = (v, fallback) => (v === '' || v == null || !Number.isFinite(Number(v)) ? fallback : Number(v));
  const p = {
    weight: num(body?.weight_kg, cfg.weight_kg),
    length: num(body?.length_cm, cfg.length_cm),
    breadth: num(body?.breadth_cm, cfg.breadth_cm),
    height: num(body?.height_cm, cfg.height_cm),
  };
  const fields = {};
  if (!(p.weight > 0 && p.weight <= 50)) fields.weight_kg = 'Weight in kg, more than 0 and up to 50.';
  for (const k of ['length', 'breadth', 'height']) if (!(p[k] >= 0.5 && p[k] <= 300)) fields[`${k}_cm`] = 'Centimetres, 0.5 to 300.';
  if (Object.keys(fields).length) throw new HttpError(422, 'Check the parcel size and weight.', { fields });
  return { weight: Math.round(p.weight * 1000) / 1000, length: p.length, breadth: p.breadth, height: p.height };
}

/** Is cash collected at the door? Only for unpaid Cash on Delivery orders. */
export const collectsCash = (order) => order.payment_method === 'cod' && order.payment_status !== 'paid';

/**
 * The orders/create/adhoc body. Amounts are whole rupees, GST-inclusive (Shiprocket's selling_price is
 * "inclusive of GST"). sub_total is "after deductions", so sub_total + shipping_charges = what the customer owes.
 */
export function buildShiprocketOrder(order, items, settings, parcel, srOrderId, pickupLocation) {
  const name = short(order.customer_name, 80) || 'Customer';
  const sp = name.indexOf(' ');
  const first = sp > 0 ? name.slice(0, sp) : name;
  const last = sp > 0 ? name.slice(sp + 1) : '';
  const line1 = [order.address_line1, order.landmark && `Landmark: ${order.landmark}`].filter(Boolean).join(', ');
  return {
    order_id: srOrderId,
    order_date: (order.created_at ? new Date(order.created_at) : new Date()).toISOString().slice(0, 16).replace('T', ' '),
    pickup_location: pickupLocation,
    billing_customer_name: first,
    billing_last_name: last,
    billing_address: short(line1, 190),
    billing_address_2: short(order.address_line2 || '', 190),
    billing_city: short(order.city, 30),
    billing_pincode: Number(order.pincode),
    billing_state: order.state,
    billing_country: 'India',
    billing_email: order.email || settings.store.email || 'orders@example.com',
    billing_phone: Number(order.phone),
    shipping_is_billing: true,
    order_items: items.map((i) => ({
      name: short(i.name + (i.contents ? ` (${i.contents})` : ''), 190),
      sku: short(`${i.kind || 'product'}-${i.ref_id || i.name}`, 50),
      units: Number(i.qty),
      selling_price: Number(i.unit_price),
      discount: 0,
      tax: i.gst_rate ?? settings.invoice.gst_rate ?? '',
      hsn: Number(String(i.hsn || settings.invoice.hsn || '').replace(/\D/g, '')) || '',
    })),
    payment_method: collectsCash(order) ? 'COD' : 'Prepaid',
    shipping_charges: Number(order.shipping) || 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: Number(order.discount) || 0,
    sub_total: Number(order.total) - (Number(order.shipping) || 0),
    length: parcel.length,
    breadth: parcel.breadth,
    height: parcel.height,
    weight: parcel.weight,
    ...(order.invoice?.number ? { invoice_number: order.invoice.number } : {}),
  };
}

// ------------------------------------------------------------------ status mapping

/** Our order status for a Shiprocket / courier status text, or null to leave the order as it is. */
export function mapCourierStatus(text) {
  const t = String(text || '').toUpperCase();
  if (!t) return null;
  if (/RTO|UNDELIVERED|LOST|DAMAGED|DESTROYED|CANCEL|EXCEPTION|ERROR|NOT PICKED|DISPOSED/.test(t)) return null; // needs a person
  if (/OUT FOR DELIVERY/.test(t)) return 'out_for_delivery';
  if (/DELIVERED/.test(t)) return 'delivered';
  if (/PICKED UP|SHIPPED|IN TRANSIT|REACHED|DELAYED|MISROUTED|DESTINATION HUB/.test(t)) return 'shipped';
  return null;
}
/** Statuses that need the admin's attention (shown on the order page). */
export const needsAttention = (text) => /RTO|UNDELIVERED|LOST|DAMAGED|DESTROYED|EXCEPTION|ERROR|NOT PICKED|DISPOSED/i.test(String(text || ''));
const pickedUp = (sr) => Boolean(sr?.picked_up) || FLOW.indexOf(mapCourierStatus(sr?.status)) >= FLOW.indexOf('shipped');

// ------------------------------------------------------------------ helpers

async function pickupLocation(env, cfg, f) {
  // Worker variable SHIPROCKET_PICKUP_LOCATION (the exact "Pickup Location" name in Shiprocket) wins,
  // then the choice in Admin → Settings → Shipping, then the account's primary address.
  const fromEnv = String(env.SHIPROCKET_PICKUP_LOCATION || '').trim();
  if (fromEnv) return fromEnv;
  if (cfg?.pickup_location) return cfg.pickup_location;
  const list = await listPickups(env, f);
  const pick = defaultPickup(list);
  if (!pick) {
    throw new HttpError(422, list.length
      ? 'Choose the pickup address in Settings → Shipping → Shiprocket (your account has more than one).'
      : 'Add a pickup address in your Shiprocket account (Settings → Pickup Addresses) first.', { code: 'shiprocket_pickup' });
  }
  return pick;
}
const defaultPickup = (list) => {
  const usable = list.filter((p) => p.active);
  return (usable.find((p) => p.primary) || (usable.length === 1 ? usable[0] : null))?.name || null;
};

/** The pickup address for a booking: the one staff picked on the order page (must be active in Shiprocket), else the default. */
async function chosenPickup(env, cfg, wanted, f) {
  const name = String(wanted || '').trim();
  if (!name) return pickupLocation(env, cfg, f); // none picked: SHIPROCKET_PICKUP_LOCATION, Settings, then the primary address
  const list = await listPickups(env, f);
  const hit = list.find((p) => p.name === name);
  if (!hit) throw new HttpError(422, `“${name}” is not a pickup address in your Shiprocket account.`, { fields: { pickup_location: 'Pick one of your Shiprocket pickup addresses.' } });
  if (!hit.active) throw new HttpError(422, `“${name}” is not active in Shiprocket yet (its phone must be verified there).`, { fields: { pickup_location: 'This address is not confirmed in Shiprocket.' } });
  return hit.name;
}

// Delivery details Shiprocket rejects when missing or malformed. Field names match the order record.
const FIX_FIELDS = ['customer_name', 'phone', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode'];
export function shippingIssues(o) {
  const f = {};
  const s = (v) => String(v ?? '').trim();
  if (s(o.customer_name).length < 2) f.customer_name = 'Enter the customer’s name.';
  if (!normalizePhone(o.phone)) f.phone = 'A 10-digit Indian mobile number.';
  if (s(o.address_line1).length < 5) f.address_line1 = 'House / flat and street, at least 5 characters.';
  if (s(o.city).length < 2) f.city = 'Enter the city.';
  if (!INDIAN_STATES.some((x) => x.toLowerCase() === s(o.state).toLowerCase())) f.state = 'Choose the state.';
  if (!/^[1-9]\d{5}$/.test(s(o.pincode))) f.pincode = 'A 6-digit PIN code.';
  return f;
}
/** Corrections typed on the order page → cleaned order fields (only the ones sent), or 422 with what is still wrong. */
function cleanFix(order, fix) {
  if (!fix || typeof fix !== 'object') return {};
  const out = {};
  for (const k of FIX_FIELDS) {
    if (!(k in fix)) continue;
    let v = String(fix[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, k === 'landmark' ? 100 : 160);
    if (k === 'phone') v = normalizePhone(v) || v;
    if (k === 'pincode') v = v.replace(/\s/g, '');
    if (k === 'state') v = INDIAN_STATES.find((x) => x.toLowerCase() === v.toLowerCase()) || v;
    if (v !== String(order[k] ?? '')) out[k] = v || null;
  }
  const issues = shippingIssues({ ...order, ...out });
  if (Object.keys(issues).length) throw new HttpError(422, 'Some delivery details still need fixing before Shiprocket accepts them.', { fields: issues });
  return out;
}

export async function listPickups(env, f = fetch) {
  const r = await srCall(env, 'GET', '/settings/company/pickup', undefined, f);
  if (!r.ok) throw new HttpError(502, `Couldn't load pickup addresses: ${srError(r.data, r.status)}`);
  return (r.data?.data?.shipping_address || []).map((a) => ({
    name: a.pickup_location, address: [a.address, a.address_2].filter(Boolean).join(', '), city: a.city, state: a.state,
    pincode: a.pin_code, phone: a.phone, primary: a.is_primary_location === 1, active: a.status !== 0 && a.phone_verified !== 0,
  }));
}

async function loadOrderRaw(env, orderNo) {
  if (!/^GM-\d{6}-\d{4}$/.test(orderNo)) throw new HttpError(404, 'Order not found.');
  const rec = await db(env).get(`orders/${orderNo}`);
  if (!rec) throw new HttpError(404, 'Order not found.');
  const { items, events, ...order } = rec;
  return { order, items: Object.values(items || {}) };
}

async function saveSr(env, orderNo, sr, extra = {}) {
  await db(env).patch(`orders/${orderNo}`, { shiprocket: sr, updated_at: nowIso(), ...extra });
}

/** One booking at a time per order (double clicks, two people). Returns a release function. */
async function lock(env, orderNo) {
  const path = `shiprocket/locks/${orderNo}`;
  const { value, etag } = await db(env).getWithEtag(path);
  if (value && value > Date.now()) throw new HttpError(409, 'This order is already being booked. Wait a few seconds and refresh.');
  const ok = await db(env).putIfMatch(path, Date.now() + 90_000, etag);
  if (!ok) throw new HttpError(409, 'This order is already being booked. Wait a few seconds and refresh.');
  return () => db(env).remove(path).catch(() => {});
}

// ------------------------------------------------------------------ book pickup

export async function bookShipment(env, orderNo, body, admin, f = fetch) {
  const settings = await getSettings(env);
  const cfg = settings.shiprocket;
  const { order, items } = await loadOrderRaw(env, orderNo);
  if (order.status === 'cancelled') throw new HttpError(409, 'This order is cancelled.');
  if (order.status === 'delivered') throw new HttpError(409, 'This order is already delivered.');
  if (order.payment_method === 'razorpay' && order.payment_status !== 'paid') {
    throw new HttpError(409, 'The online payment for this order has not been received, so it can\'t be shipped yet.');
  }
  if (!items.length) throw new HttpError(409, 'This order has no items.');

  // Checks Shiprocket would fail on come first, before anything is created or locked.
  let fixed = {};
  if (!order.shiprocket?.shipment_id) {
    fixed = cleanFix(order, body?.fix);
    if (!Object.keys(fixed).length) {
      const issues = shippingIssues(order);
      if (Object.keys(issues).length) throw new HttpError(422, 'Some delivery details need fixing before Shiprocket accepts them.', { fields: issues, code: 'shiprocket_details' });
    }
    parcelFor(body, cfg);
  }

  const release = await lock(env, orderNo);
  const sr = { ...(order.shiprocket || {}) };
  const steps = [];
  const fail = async (step, message) => {
    sr.error = { step, message: short(message), at: nowIso() };
    await saveSr(env, orderNo, sr);
    throw new HttpError(502, message, { code: 'shiprocket_step', step, shiprocket: sr });
  };
  try {
    // 1. create the order in Shiprocket
    if (!sr.shipment_id) {
      const parcel = parcelFor(body, cfg);
      const location = await chosenPickup(env, cfg, body?.pickup_location, f);
      if (Object.keys(fixed).length) {
        // corrected details are kept on the order too, so the label, slip and invoice all match
        const changed = Object.keys(fixed).map((k) => `${k.replace(/_/g, ' ')}: ${fixed[k] ?? '—'}`).join(' · ');
        await db(env).patch(`orders/${orderNo}`, { ...fixed, updated_at: nowIso(), [`events/${pushKey()}`]: event('note', null, `Delivery details corrected for Shiprocket — ${changed}`, admin?.email || null) });
        Object.assign(order, fixed);
      }
      sr.attempt = (sr.attempt || 0) + 1;
      // Shiprocket never reuses an order id (not even a cancelled one), so a re-booking adds a suffix.
      sr.sr_order_ref = orderNo.replace(/^GM-/, '') + (sr.attempt > 1 ? `-${sr.attempt}` : '');
      const payload = buildShiprocketOrder(order, items, settings, parcel, sr.sr_order_ref, location);
      const r = await srCall(env, 'POST', '/orders/create/adhoc', payload, f);
      if (!r.ok || !r.data?.shipment_id) return await fail('create', `Shiprocket didn't accept the order: ${srError(r.data, r.status)}`);
      Object.assign(sr, {
        sr_order_id: r.data.order_id, shipment_id: r.data.shipment_id, pickup_location: location, parcel,
        payment_method: payload.payment_method, cod_amount: payload.payment_method === 'COD' ? Number(order.total) : 0,
        created_at: nowIso(), created_by: admin?.email || null,
      });
      await saveSr(env, orderNo, sr);
      steps.push('create');

      // What the courier collects comes from Shiprocket's copy of the order, so it must equal our total.
      const shown = await srCall(env, 'GET', `/orders/show/${sr.sr_order_id}`, undefined, f).catch(() => null);
      const srTotal = Number(shown?.data?.data?.total);
      if (shown?.ok && Number.isFinite(srTotal) && srTotal !== Number(order.total)) {
        await srCall(env, 'POST', '/orders/cancel', { ids: [sr.sr_order_id] }, f).catch(() => null);
        const msg = `Shiprocket worked out ₹${srTotal} but this order's total is ₹${order.total}, so the booking was cancelled to avoid the courier collecting the wrong amount. Please book this one in the Shiprocket panel and tell us.`;
        Object.assign(sr, { shipment_id: null, sr_order_id: null, cancelled_mismatch: { shiprocket_total: srTotal, order_total: order.total, at: nowIso() } });
        return await fail('create', msg);
      }
    }

    // 2. courier + AWB
    if (!sr.awb) {
      const courierId = Number(body?.courier_id) || Number(cfg.courier_id) || undefined;
      const r = await srCall(env, 'POST', '/courier/assign/awb', { shipment_id: sr.shipment_id, ...(courierId ? { courier_id: courierId } : {}) }, f);
      const a = r.data?.response?.data;
      if (!r.ok || r.data?.awb_assign_status !== 1 || !a?.awb_code) {
        return await fail('awb', `No courier was assigned: ${srError(r.data?.response?.data?.awb_assign_error ? { message: r.data.response.data.awb_assign_error } : r.data, r.status)}`);
      }
      Object.assign(sr, { awb: String(a.awb_code), courier_id: a.courier_company_id || null, courier_name: a.courier_name || null, awb_at: nowIso() });
      if (a.pickup_scheduled_date) sr.pickup_scheduled_date = a.pickup_scheduled_date;
      await saveSr(env, orderNo, sr);
      await db(env).patch(AWB_INDEX, { [sr.awb]: orderNo }).catch((e) => console.error('awb index', e));
      steps.push('awb');
    }

    // 3. pickup
    if (!sr.pickup_requested) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.pickup_date || '') ? [body.pickup_date] : undefined;
      const r = await srCall(env, 'POST', '/courier/generate/pickup', { shipment_id: [sr.shipment_id], ...(date ? { pickup_date: date } : {}) }, f);
      const already = /already/i.test(srError(r.data, r.status));
      if (!(r.ok && r.data?.pickup_status === 1) && !already) return await fail('pickup', `Pickup wasn't booked: ${srError(r.data, r.status)}`);
      const p = r.data?.response || {};
      Object.assign(sr, {
        pickup_requested: true, pickup_requested_at: nowIso(),
        pickup_scheduled_date: p.pickup_scheduled_date || sr.pickup_scheduled_date || null,
        pickup_token: p.pickup_token_number || sr.pickup_token || null,
      });
      steps.push('pickup');
    }

    // 4. label + manifest (optional extras)
    if (!sr.label_url) {
      const r = await srCall(env, 'POST', '/courier/generate/label', { shipment_id: [sr.shipment_id] }, f).catch(() => null);
      if (r?.data?.label_url) sr.label_url = r.data.label_url;
    }
    if (!sr.manifest_url) {
      const r = await srCall(env, 'POST', '/manifests/generate', { shipment_id: [sr.shipment_id] }, f).catch(() => null);
      if (r?.data?.manifest_url) sr.manifest_url = r.data.manifest_url;
    }
    sr.error = null;
    sr.booked_at = sr.booked_at || nowIso();
    sr.status = sr.status || 'PICKUP SCHEDULED';

    // The order now carries the courier details the customer sees on the tracking page and in messages.
    const patch = {
      shiprocket: sr, courier: short(sr.courier_name || 'Shiprocket', 80), tracking_no: sr.awb,
      tracking_url: `https://shiprocket.co/tracking/${encodeURIComponent(sr.awb)}`, updated_at: nowIso(),
    };
    const base = Date.now();
    patch[`events/${pushKey(base)}`] = event('tracking', null, `Shiprocket pickup booked · ${sr.courier_name || 'courier'} · AWB ${sr.awb}${sr.pickup_scheduled_date ? ` · pickup ${sr.pickup_scheduled_date}` : ''}`, admin?.email || 'Shiprocket');
    let moved = null;
    if (FLOW.indexOf(order.status) < FLOW.indexOf('packed')) {
      patch.status = 'packed';
      patch[`events/${pushKey(base + 1)}`] = event('status', 'packed', 'Pickup booked with Shiprocket', admin?.email || 'Shiprocket');
      moved = 'packed';
    }
    await db(env).patch(`orders/${orderNo}`, patch);
    await db(env).patch(ACTIVE, { [orderNo]: true }).catch((e) => console.error('active index', e));
    return { shiprocket: sr, steps, moved };
  } finally {
    await release();
  }
}

// ------------------------------------------------------------------ tracking

/** Fetch tracking from Shiprocket and move the order forward (never back, never to cancelled). */
export async function syncShipment(env, orderNo, { actor = 'Shiprocket', notify } = {}, f = fetch) {
  const settings = await getSettings(env);
  const cfg = settings.shiprocket;
  const { order } = await loadOrderRaw(env, orderNo);
  const sr = { ...(order.shiprocket || {}) };
  if (!sr.shipment_id && !sr.awb) throw new HttpError(409, 'This order has no Shiprocket shipment yet.');
  const r = await srCall(env, 'GET', sr.awb ? `/courier/track/awb/${encodeURIComponent(sr.awb)}` : `/courier/track/shipment/${sr.shipment_id}`, undefined, f);
  const td = r.data?.tracking_data || (r.data && Object.values(r.data)[0]?.tracking_data) || null;
  sr.last_sync = nowIso();
  if (!r.ok || !td) {
    sr.sync_error = short(srError(r.data, r.status), 200);
    await saveSr(env, orderNo, sr);
    return { shiprocket: sr, moved: null };
  }
  if (td.error) {
    sr.sync_error = short(td.error, 200); // e.g. "Awb not yet picked" right after booking
    await saveSr(env, orderNo, sr);
    return { shiprocket: sr, moved: null };
  }
  const track = (td.shipment_track || [])[0] || {};
  const activities = (td.shipment_track_activities || []).slice(0, 12).map((a) => ({
    date: a.date || null, activity: short(a.activity || a['sr-status-label'] || a.status, 140), location: short(a.location || '', 100),
  }));
  sr.sync_error = null;
  sr.status = short(track.current_status || sr.status || '', 60) || null;
  sr.etd = td.etd || track.edd || sr.etd || null;
  if (track.delivered_date) sr.delivered_date = track.delivered_date;
  if (activities.length) sr.activities = activities;
  if (td.track_url) sr.track_url = td.track_url;
  sr.attention = needsAttention(sr.status) ? sr.status : null;

  const extra = {};
  if (td.track_url && /^https?:\/\//.test(td.track_url) && td.track_url !== order.tracking_url) extra.tracking_url = short(td.track_url, 300);
  const next = mapCourierStatus(sr.status);
  let moved = null;
  if (cfg.auto_status && next && order.status !== 'cancelled' && FLOW.indexOf(next) > FLOW.indexOf(order.status)) {
    extra.status = next;
    extra[`events/${pushKey()}`] = event('status', next, `Courier update: ${sr.status}`, actor);
    moved = next;
  }
  if (FLOW.indexOf(next) >= FLOW.indexOf('shipped')) sr.picked_up = true;
  await saveSr(env, orderNo, sr, extra);
  if (next === 'delivered' || order.status === 'cancelled') await db(env).remove(`${ACTIVE}/${orderNo}`).catch(() => {});

  if (moved && (notify ?? cfg.notify_customer)) {
    const fresh = await loadOrderRaw(env, orderNo);
    await notifyOrderEvent(env, fresh.order, fresh.items, moved, { whatsapp: true, email: true }).catch((e) => console.error('courier notify', e));
  }
  return { shiprocket: sr, moved };
}

// ------------------------------------------------------------------ cancel

export async function cancelShipment(env, orderNo, admin, f = fetch) {
  const { order } = await loadOrderRaw(env, orderNo);
  const sr = { ...(order.shiprocket || {}) };
  if (!sr.sr_order_id) throw new HttpError(409, 'There is no Shiprocket booking to cancel.');
  if (pickedUp(sr) || ['shipped', 'out_for_delivery', 'delivered'].includes(order.status)) {
    throw new HttpError(409, 'The courier has already picked this up, so it can\'t be cancelled here. Use the Shiprocket panel (return / RTO).');
  }
  const r = await srCall(env, 'POST', '/orders/cancel', { ids: [sr.sr_order_id] }, f);
  if (!r.ok) throw new HttpError(502, `Shiprocket couldn't cancel it: ${srError(r.data, r.status)}`);
  const history = [...(sr.history || []), { sr_order_id: sr.sr_order_id, awb: sr.awb || null, courier: sr.courier_name || null, cancelled_at: nowIso(), by: admin?.email || null }].slice(-5);
  const next = { attempt: sr.attempt || 1, history };
  const patch = { shiprocket: next, updated_at: nowIso() };
  // Clear the courier details only if they came from this booking.
  if (sr.awb && order.tracking_no === sr.awb) Object.assign(patch, { courier: null, tracking_no: null, tracking_url: null });
  patch[`events/${pushKey()}`] = event('tracking', null, `Shiprocket booking cancelled${sr.awb ? ` (AWB ${sr.awb})` : ''}`, admin?.email || null);
  await db(env).patch(`orders/${orderNo}`, patch);
  await db(env).remove(`${ACTIVE}/${orderNo}`).catch(() => {});
  if (sr.awb) await db(env).remove(`${AWB_INDEX}/${sr.awb}`).catch(() => {});
  return { shiprocket: next };
}

// ------------------------------------------------------------------ routes

export async function adminBookShipment(request, env, orderNo, admin) {
  const body = await readJson(request).catch(() => ({}));
  const res = await bookShipment(env, orderNo, body || {}, admin);
  return json(res);
}
export async function adminSyncShipment(env, orderNo, admin) {
  return json(await syncShipment(env, orderNo, { actor: admin?.email || 'Shiprocket' }));
}
export async function adminCancelShipment(env, orderNo, admin) {
  return json(await cancelShipment(env, orderNo, admin));
}
export async function adminListPickups(env) {
  return json({ pickups: await listPickups(env) });
}

/** Everything the order page's booking form needs: pickup addresses, the default one, parcel defaults and fields to fix. */
export async function prepareBooking(env, orderNo, f = fetch) {
  const [{ order }, settings] = await Promise.all([loadOrderRaw(env, orderNo), getSettings(env)]);
  const cfg = settings.shiprocket;
  let pickups = [], pickups_error = null;
  try { pickups = await listPickups(env, f); } catch (e) { pickups_error = e.message; }
  // SHIPROCKET_PICKUP_LOCATION / Settings only choose the default; staff can pick any confirmed address
  const serverDefault = String(env.SHIPROCKET_PICKUP_LOCATION || '').trim() || null;
  return {
    pickups,
    pickups_error,
    default_pickup: serverDefault || cfg.pickup_location || defaultPickup(pickups),
    pickup_locked: false,
    parcel: { weight_kg: cfg.weight_kg, length_cm: cfg.length_cm, breadth_cm: cfg.breadth_cm, height_cm: cfg.height_cm },
    issues: shippingIssues(order),
    states: INDIAN_STATES,
  };
}
export async function adminPrepareBooking(env, orderNo) {
  return json(await prepareBooking(env, orderNo));
}

/**
 * Tracking webhook (Shiprocket → Settings → API → Webhooks). The body only tells us which AWB changed;
 * the status itself is re-read from the Shiprocket API, so a forged call can't change an order.
 * Shiprocket expects HTTP 200 every time.
 */
export async function courierWebhook(request, env, ctx) {
  const ok = json({ ok: true });
  if (env.SHIPROCKET_WEBHOOK_TOKEN && request.headers.get('x-api-key') !== env.SHIPROCKET_WEBHOOK_TOKEN) return json({ ok: false }, 401);
  if (!shiprocketReady(env)) return ok;
  const body = await readJson(request).catch(() => null);
  const awb = String(body?.awb || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (!awb) return ok;
  const orderNo = await db(env).get(`${AWB_INDEX}/${awb}`).catch(() => null);
  if (typeof orderNo !== 'string') return ok;
  const work = syncShipment(env, orderNo).catch((e) => console.error('webhook sync', orderNo, e?.message || e));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return ok;
}

/** Cron: refresh shipments that haven't been updated for a while (in case the webhook isn't set up). */
export async function pollShipments(env, { max = 15, staleMinutes = 120 } = {}) {
  if (!shiprocketReady(env)) return { checked: 0, moved: [] };
  const active = Object.keys((await db(env).get(ACTIVE)) || {});
  const moved = [];
  let checked = 0;
  for (const orderNo of active) {
    if (checked >= max) break;
    const sr = await db(env).get(`orders/${orderNo}/shiprocket`).catch(() => null);
    if (!sr?.awb) { await db(env).remove(`${ACTIVE}/${orderNo}`).catch(() => {}); continue; }
    if (sr.last_sync && Date.now() - Date.parse(sr.last_sync) < staleMinutes * 60e3) continue;
    checked++;
    const r = await syncShipment(env, orderNo).catch((e) => { console.error('poll sync', orderNo, e?.message || e); return null; });
    if (r?.moved) moved.push(`${orderNo}→${r.moved}`);
  }
  return { checked, moved };
}

export const SHIPROCKET_STATUS_HELP = STATUS_LABELS;
