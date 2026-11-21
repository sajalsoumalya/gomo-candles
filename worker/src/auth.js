import { HttpError, timingSafeEqual } from './util.js';
import { staffRecord, touchStaff, areaFor, can, areasOf, savedRoles, roleLabel, recordAccessRequest } from './staff.js';

// Verifies Firebase Auth ID tokens without the Admin SDK (which doesn't run on Workers).
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library

export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let keyCache = { keys: null, expires: 0 };
export function resetKeyCache() { keyCache = { keys: null, expires: 0 }; }

async function getKeys(fetchImpl, now) {
  if (keyCache.keys && now < keyCache.expires) return keyCache.keys;
  const res = await fetchImpl(FIREBASE_JWKS_URL);
  if (!res.ok) throw new HttpError(503, 'Sign-in service unavailable, try again.');
  const data = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  keyCache = { keys: data.keys || [], expires: now + (maxAge ? Number(maxAge[1]) * 1000 : 3600 * 1000) };
  return keyCache.keys;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decodePart = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/**
 * Returns the token claims if valid, otherwise throws HttpError(401).
 * Checks: RS256 signature with Google's published keys, iss, aud, exp, iat, auth_time, sub.
 */
export async function verifyFirebaseToken(token, { projectId, fetchImpl = fetch, now = Date.now() } = {}) {
  const fail = (why) => { throw new HttpError(401, 'Please sign in again.', { reason: why }); };
  if (!projectId) throw new HttpError(500, 'FIREBASE_PROJECT_ID is not configured on the Worker.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) fail('malformed');

  let header, claims;
  try { header = decodePart(parts[0]); claims = decodePart(parts[1]); } catch { fail('malformed'); }
  if (header.alg !== 'RS256' || !header.kid) fail('bad header');

  const keys = await getKeys(fetchImpl, now);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) fail('unknown key');

  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) fail('bad signature');

  const sec = Math.floor(now / 1000);
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) fail('bad issuer');
  if (claims.aud !== projectId) fail('bad audience');
  if (!(claims.exp > sec)) fail('expired');
  if (!(claims.iat <= sec + 60)) fail('issued in future');
  if (claims.auth_time && claims.auth_time > sec + 60) fail('bad auth_time');
  if (!claims.sub || typeof claims.sub !== 'string') fail('no subject');
  return claims;
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Authenticate an admin request. Returns { uid, email, name }. */
export async function requireAdmin(request, env, opts = {}) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Please sign in.');

  // Local development only: `wrangler dev --var DEV_ADMIN_TOKEN:<secret>` lets the admin UI work before
  // Firebase is set up. Ignored unless the request is addressed to localhost, so it can't work once deployed.
  if (token.startsWith('dev:')) {
    const host = new URL(request.url).hostname;
    if (env.DEV_ADMIN_TOKEN && (host === 'localhost' || host === '127.0.0.1') && timingSafeEqual(token.slice(4), env.DEV_ADMIN_TOKEN)) {
      return { uid: 'dev', email: 'dev@localhost', name: 'Local dev', role: 'owner', role_label: 'Super admin', areas: ['*'], super: true };
    }
    throw new HttpError(401, 'Please sign in again.', { reason: 'dev token rejected' });
  }
  const claims = await verifyFirebaseToken(token, { projectId: env.FIREBASE_PROJECT_ID, ...opts });
  const email = String(claims.email || '').toLowerCase();
  const owner = !!email && adminEmails(env).includes(email);
  const staff = owner || !email ? null : await staffRecord(env, email);
  // Prevents someone registering an allowed email they don't own via Email/Password sign-up.
  if ((owner || staff || email) && claims.email_verified !== true) {
    throw new HttpError(403, 'Please verify your email address first.', { code: 'email_unverified', email });
  }
  if (!owner && !staff) {
    // Verified but not on the team: leave a request for the super admin to approve.
    const req = await recordAccessRequest(env, claims).catch(() => null);
    if (req?.status === 'declined') throw new HttpError(403, 'Your request for access was declined.', { code: 'access_declined', email });
    throw new HttpError(403, 'Your request is waiting for the super admin to approve it.', { code: 'access_pending', email });
  }
  const role = owner ? 'owner' : staff.role;
  if (staff) touchStaff(env, email);
  const saved = owner ? {} : await savedRoles(env);
  return { uid: claims.sub, email, name: claims.name || staff?.name || email, role, role_label: owner ? 'Super admin' : roleLabel(role, saved),
    areas: owner ? ['*'] : areasOf(staff.role, staff.areas, saved), super: owner };
}

/** Throws 403 unless this admin's role may use the given API path. */
export function requireArea(admin, method, path) {
  const area = areaFor(method, path);
  if (!can(admin.areas, area)) throw new HttpError(403, area === 'owner' ? 'Only the super admin can do this.' : 'You don’t have access to this page. Ask the super admin.', { code: 'forbidden', area });
}
