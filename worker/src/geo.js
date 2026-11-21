// "Use my location" → address. Reverse geocoding via OpenStreetMap Nominatim (usage policy: ≤1 req/s, identified
// User-Agent, caching), then the PIN code is checked against India Post data to correct district / state.
// Results are cached in RTDB (geo_cache/*) because the Cache API is not available on *.workers.dev.

import { HttpError, json, nowIso } from './util.js';
import { db, rateLimit } from './db.js';
import { INDIAN_STATES, inIndia } from './validate.js';

const REV_TTL = 30 * 86400_000;
const PIN_TTL = 90 * 86400_000;

const ALIASES = {
  'nct of delhi': 'Delhi', 'national capital territory of delhi': 'Delhi', 'new delhi': 'Delhi',
  orissa: 'Odisha', pondicherry: 'Puducherry', uttaranchal: 'Uttarakhand',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu', 'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'andaman and nicobar': 'Andaman and Nicobar Islands', 'jammu kashmir': 'Jammu and Kashmir',
};

export function normalizeState(s) {
  const k = String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!k) return '';
  const direct = INDIAN_STATES.find((st) => st.toLowerCase() === k);
  if (direct) return direct;
  if (ALIASES[k]) return ALIASES[k];
  return INDIAN_STATES.find((st) => k.includes(st.toLowerCase())) || '';
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const uniq = (arr) => arr.filter((v, i) => v && arr.findIndex((x) => String(x).toLowerCase() === String(v).toLowerCase()) === i);

/** Map a Nominatim jsonv2 `address` object onto the shop's address fields. */
export function mapNominatim(a = {}) {
  const house = a.house_number || a.house_name || '';
  const building = a.building || a.amenity || a.shop || a.office || '';
  const road = a.road || a.pedestrian || a.street || a.footway || a.residential || '';
  const line1 = uniq([house, building, road]).join(', ');
  const line2 = uniq([a.neighbourhood, a.suburb || a.quarter, a.city_district, a.village && (a.town || a.city) ? a.village : '']).join(', ');
  const city = a.city || a.town || a.municipality || a.village || a.county || a.state_district || '';
  const pin = String(a.postcode || '').replace(/\s/g, '');
  return {
    line1, line2, city, district: a.state_district || a.county || '', state: normalizeState(a.state || a['ISO3166-2-lvl4'] || ''),
    pincode: /^[1-9]\d{5}$/.test(pin) ? pin : '',
    confidence: house && road ? 'high' : road ? 'medium' : 'low',
  };
}

async function timedFetch(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

/** Keep Nominatim calls ≥1.1 s apart across all Worker instances (compare-and-set on a timestamp). */
async function throttle(env) {
  const d = db(env);
  for (let i = 0; i < 4; i++) {
    const { value, etag } = await d.getWithEtag('geo_throttle/nominatim');
    const now = Date.now();
    const wait = value ? value + 1100 - now : 0;
    if (wait > 2500) throw new HttpError(503, 'Location lookup is busy, please try again in a moment.');
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (await d.putIfMatch('geo_throttle/nominatim', Math.max(now, (value || 0) + 1100), etag)) return;
  }
}

function userAgent(env) {
  return `GoMoCandles/1.0 (+${env.SHOP_URL || 'https://gomocandle.web.app'}; ${env.GEO_CONTACT_EMAIL || 'hello@gomocandles.in'})`;
}

export async function lookupPincode(env, pin) {
  const d = db(env);
  const cached = await d.get(`geo_cache/pin/${pin}`);
  if (cached && cached.at > Date.now() - PIN_TTL) return cached.data;
  let data = null;
  try {
    const res = await timedFetch(`https://api.postalpincode.in/pincode/${pin}`, { headers: { accept: 'application/json', 'user-agent': userAgent(env) } }, 6000);
    const body = await res.json().catch(() => null);
    const r = Array.isArray(body) ? body[0] : null;
    if (r?.Status === 'Success' && Array.isArray(r.PostOffice) && r.PostOffice.length) {
      const po = r.PostOffice;
      const district = po[0].District || '';
      data = { pincode: pin, city: titleCase(district), district: titleCase(district), state: normalizeState(po[0].State), areas: uniq(po.map((p) => p.Name)).slice(0, 15) };
    } else if (r?.Status === 'Error') {
      data = { pincode: pin, invalid: true };
    }
  } catch (e) {
    console.error('pincode lookup failed', e?.message || e);
  }
  if (data) await d.put(`geo_cache/pin/${pin}`, { at: Date.now(), data });
  return data;
}

export async function reverseGeocode(env, lat, lng) {
  const d = db(env);
  const key = `${lat.toFixed(4)}_${lng.toFixed(4)}`.replace(/\./g, 'p').replace(/-/g, 'm');
  const cached = await d.get(`geo_cache/rev/${key}`);
  if (cached && cached.at > Date.now() - REV_TTL) return cached.data;

  await throttle(env);
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`;
  let res;
  try {
    res = await timedFetch(url, { headers: { 'user-agent': userAgent(env), referer: env.SHOP_URL || '', accept: 'application/json' } }, 8000);
  } catch {
    throw new HttpError(503, 'Could not look up your location right now. Please type your address.');
  }
  if (!res.ok) throw new HttpError(503, 'Could not look up your location right now. Please type your address.');
  const body = await res.json().catch(() => ({}));
  if (body.error || !body.address) throw new HttpError(404, 'We could not find an address here. Please type it in.');
  if (body.address.country_code && body.address.country_code !== 'in') throw new HttpError(422, 'We deliver only within India.');

  const data = { ...mapNominatim(body.address), display: body.display_name || '' };
  if (data.pincode) {
    const pin = await lookupPincode(env, data.pincode);
    if (pin && !pin.invalid) {
      if (pin.state) data.state = pin.state;
      if (!data.city) data.city = pin.city;
      data.district = pin.district || data.district;
    }
  }
  await d.put(`geo_cache/rev/${key}`, { at: Date.now(), data });
  return data;
}

// ---- routes (signed-in customers only; requireCustomer is done by the caller)

export async function geoReverse(request, env, uid) {
  if (!(await rateLimit(env, `geo:rev:${uid}`, 30, 3600))) throw new HttpError(429, 'Too many location lookups. Please type your address.');
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!inIndia(lat, lng)) throw new HttpError(422, 'We deliver only within India. Please type your address.', { code: 'outside_india' });
  const data = await reverseGeocode(env, lat, lng);
  return json({ address: { ...data, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }, at: nowIso() });
}

export async function geoPincode(request, env, uid, pin) {
  if (!(await rateLimit(env, `geo:pin:${uid}`, 60, 3600))) throw new HttpError(429, 'Too many lookups, please try again later.');
  const data = await lookupPincode(env, pin);
  if (!data) throw new HttpError(503, 'PIN code lookup is unavailable right now.');
  if (data.invalid) throw new HttpError(404, 'This PIN code was not found. Please check it.', { code: 'pin_not_found' });
  return json({ pincode: data });
}
