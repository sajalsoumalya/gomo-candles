// Firebase Realtime Database REST client for Cloudflare Workers.
// Auth: Google service account (FIREBASE_SERVICE_ACCOUNT secret, JSON) → OAuth2 access token (see google.js).
// Local testing: if RTDB_URL points at localhost (the mock in test/rtdb-mock.mjs), no credentials are needed.

import { HttpError } from './util.js';
import { accessToken, dropToken, SCOPES } from './google.js';

const isLocal = (url) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url || '');
const JSON_PARAMS = new Set(['orderBy', 'equalTo', 'startAt', 'endAt', 'startAfter', 'endBefore']);

/** RTDB keys may not contain . $ # [ ] / */
export const safeKey = (s) => String(s).replace(/[.$#[\]/]/g, '_').slice(0, 700);

/** Sortable, unique key (like Firebase push ids): time-ordered base36 + random. */
export function pushKey(now = Date.now()) {
  const rand = new Uint8Array(6);
  crypto.getRandomValues(rand);
  return now.toString(36).padStart(9, '0') + Array.from(rand, (b) => (b % 36).toString(36)).join('');
}

export function db(env, fetchImpl = fetch) {
  if (env.__db) return env.__db; // test hook
  const base = String(env.RTDB_URL || '').replace(/\/+$/, '');
  if (!base) throw new HttpError(500, 'RTDB_URL is not configured on the Worker.');
  if (!isLocal(base) && !env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(500, 'FIREBASE_SERVICE_ACCOUNT secret is not set on the Worker.');

  async function request(method, path, { body, query, headers = {} } = {}) {
    const qs = new URLSearchParams();
    // Filter values (orderBy/equalTo/startAt/endAt) are JSON; print/shallow/limit* are plain.
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined) continue;
      qs.set(k, JSON_PARAMS.has(k) && typeof v === 'string' ? JSON.stringify(v) : String(v));
    }
    const url = `${base}/${String(path).replace(/^\/+/, '')}.json${qs.toString() ? '?' + qs : ''}`;
    const h = { ...headers };
    if (!isLocal(base)) h.authorization = `Bearer ${await accessToken(env, SCOPES.db, fetchImpl)}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetchImpl(url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (res.status !== 401 || isLocal(base)) break;
      dropToken(SCOPES.db);
      h.authorization = `Bearer ${await accessToken(env, SCOPES.db, fetchImpl)}`;
    }
    return res;
  }

  async function ok(res, what) {
    if (res.ok) return res.status === 204 ? null : res.json();
    const text = await res.text().catch(() => '');
    console.error(`rtdb ${what} failed`, res.status, text.slice(0, 300));
    throw new HttpError(503, 'Database error, please try again.');
  }

  return {
    /** GET a path. query: { orderBy, equalTo, startAt, endAt, limitToFirst, limitToLast, shallow } */
    async get(path, query) { return ok(await request('GET', path, { query }), `GET ${path}`); },
    async put(path, value) { return ok(await request('PUT', path, { body: value, query: { print: 'silent' } }), `PUT ${path}`); },
    async patch(path, value) { return ok(await request('PATCH', path, { body: value, query: { print: 'silent' } }), `PATCH ${path}`); },
    async remove(path) { return ok(await request('DELETE', path, { query: { print: 'silent' } }), `DELETE ${path}`); },
    /** Read value + ETag, for compare-and-set. */
    async getWithEtag(path) {
      const res = await request('GET', path, { headers: { 'x-firebase-etag': 'true' } });
      const value = await ok(res, `GET ${path}`);
      return { value, etag: res.headers.get('etag') };
    },
    /** Conditional write. Returns false if someone else changed the value first. (RTDB rejects print=silent with if-match.) */
    async putIfMatch(path, value, etag) {
      const res = await request('PUT', path, { body: value, headers: { 'if-match': etag } });
      if (res.status === 412) return false;
      await ok(res, `PUT(if-match) ${path}`);
      return true;
    },
  };
}

/** Object map → array (RTDB returns null for empty, objects for maps). */
export const values = (obj) => (obj && typeof obj === 'object' ? Object.values(obj) : []);

/** Fixed-window rate limit using a compare-and-set counter. Returns true if allowed. Fails open on contention. */
export async function rateLimit(env, key, limit, windowSec) {
  const d = db(env);
  const path = `rate_limits/${safeKey(key)}`;
  const now = Math.floor(Date.now() / 1000);
  let seen = 0;
  for (let i = 0; i < 5; i++) {
    const { value, etag } = await d.getWithEtag(path);
    const fresh = !value || value.window_start <= now - windowSec;
    const next = fresh ? { window_start: now, count: 1 } : { window_start: value.window_start, count: value.count + 1 };
    seen = next.count;
    if (await d.putIfMatch(path, next, etag)) return next.count <= limit;
  }
  // Still contended after 5 tries = many requests on one key at once. Never fail open: judge by the last count seen.
  return seen <= limit;
}
