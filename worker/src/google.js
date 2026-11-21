// Google service-account helpers for Cloudflare Workers (no Admin SDK).
// - accessToken(): OAuth2 access token via the RS256 JWT-bearer grant, cached per scope set
// - createCustomToken(): Firebase Auth custom token, for signInWithCustomToken() after a verified OTP
// - authAdmin(): Firebase Auth user management via the Identity Toolkit REST API

import { HttpError } from './util.js';

export const SCOPES = {
  db: ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email'],
  auth: ['https://www.googleapis.com/auth/identitytoolkit', 'https://www.googleapis.com/auth/cloud-platform'],
};

const tokenCache = new Map(); // scopeKey -> { token, exp, key }
export function resetTokenCache() { tokenCache.clear(); }

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export const b64url = (input) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function serviceAccount(env) {
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (!sa.client_email || !sa.private_key) throw new Error('incomplete');
    return sa;
  } catch {
    throw new HttpError(500, 'FIREBASE_SERVICE_ACCOUNT secret is missing or not valid JSON.');
  }
}

const keyCache = new Map();
async function signingKey(sa) {
  if (!keyCache.has(sa.private_key)) {
    keyCache.set(sa.private_key, crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']));
  }
  return keyCache.get(sa.private_key);
}

export async function signJwt(sa, claims) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa), new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function accessToken(env, scopes, fetchImpl = fetch) {
  const scopeKey = scopes.join(' ');
  const now = Date.now();
  const hit = tokenCache.get(scopeKey);
  if (hit && now < hit.exp - 60_000 && hit.key === env.FIREBASE_SERVICE_ACCOUNT) return hit.token;
  const sa = serviceAccount(env);
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(sa, { iss: sa.client_email, scope: scopeKey, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('google token error', res.status, JSON.stringify(data).slice(0, 200));
    throw new HttpError(503, 'Service temporarily unavailable, please try again.');
  }
  tokenCache.set(scopeKey, { token: data.access_token, exp: now + (data.expires_in || 3600) * 1000, key: env.FIREBASE_SERVICE_ACCOUNT });
  return data.access_token;
}

export function dropToken(scopes) { tokenCache.delete(scopes.join(' ')); }

/** Firebase custom token (valid 1 hour) — https://firebase.google.com/docs/auth/admin/create-custom-tokens */
export async function createCustomToken(env, uid, claims) {
  if (!uid || String(uid).length > 128) throw new Error('invalid uid');
  const sa = serviceAccount(env);
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat, exp: iat + 3600, uid: String(uid),
  };
  if (claims && Object.keys(claims).length) payload.claims = claims;
  return signJwt(sa, payload);
}

export class AuthAdminError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/** Firebase Auth admin (Identity Toolkit v1). */
export function authAdmin(env, fetchImpl = fetch) {
  if (env.__auth) return env.__auth; // test hook
  const project = env.FIREBASE_PROJECT_ID;
  const base = `https://identitytoolkit.googleapis.com/v1/projects/${project}`;

  async function call(path, body) {
    let token = await accessToken(env, SCOPES.auth, fetchImpl);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (res.status === 401 && attempt === 0) { dropToken(SCOPES.auth); token = await accessToken(env, SCOPES.auth, fetchImpl); continue; }
      const code = String(data?.error?.message || `HTTP_${res.status}`).split(' ')[0];
      throw new AuthAdminError(code, res.status);
    }
    throw new AuthAdminError('UNAUTHORIZED', 401);
  }

  const toUser = (u) => u && ({
    uid: u.localId,
    email: u.email ? String(u.email).toLowerCase() : null,
    email_verified: !!u.emailVerified,
    phone: u.phoneNumber || null,
    name: u.displayName || null,
    disabled: !!u.disabled,
    providers: (u.providerUserInfo || []).map((p) => p.providerId),
    google_email: (u.providerUserInfo || []).find((p) => p.providerId === 'google.com')?.email?.toLowerCase() || null,
    password_updated_at: u.passwordUpdatedAt ? Number(u.passwordUpdatedAt) : null,
    created_at: u.createdAt ? Number(u.createdAt) : null,
  });

  return {
    async lookup(uid) {
      const data = await call('/accounts:lookup', { localId: [uid] });
      return toUser(data.users?.[0]) || null;
    },
    async lookupByPhone(e164) {
      const data = await call('/accounts:lookup', { phoneNumber: [e164] });
      return toUser(data.users?.[0]) || null;
    },
    async lookupByEmail(email) {
      const data = await call('/accounts:lookup', { email: [email] });
      return toUser(data.users?.[0]) || null;
    },
    /** Create a user with a chosen uid (used for mobile- and email-code sign-up). */
    async create({ uid, phone, name, email, email_verified }) {
      const body = { localId: uid };
      if (phone) body.phoneNumber = phone;
      if (email) { body.email = email; body.emailVerified = !!email_verified; }
      if (name) body.displayName = name;
      return toUser(await call('/accounts', body));
    },
    /** fields: { phone (E.164 or null to remove), email_verified, disabled, name } */
    async update(uid, fields) {
      const body = { localId: uid };
      if ('phone' in fields) {
        if (fields.phone) body.phoneNumber = fields.phone;
        else body.deleteProvider = ['phone'];
      }
      if ('email_verified' in fields) body.emailVerified = !!fields.email_verified;
      if ('disabled' in fields) body.disableUser = !!fields.disabled;
      if ('name' in fields && fields.name) body.displayName = fields.name;
      await call('/accounts:update', body);
    },
    async remove(uid) { await call('/accounts:delete', { localId: uid }); },
  };
}
