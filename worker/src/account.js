// Customer accounts: mobile-OTP sign-in, profile sync with Firebase Auth, verification of mobile / WhatsApp / email,
// one account per mobile (atomic index) and per email (Firebase), merging duplicates once ownership is proven,
// saved addresses and order history.
//
// RTDB layout
//   users/{uid}                    profile (see newProfile)
//   user_index/phone/{10 digits}   uid        user_index/email/{safeKey(email)}  uid
//   user_orders/{uid}/{order_no}   created_at  order_index/phone/{p}/{order_no}  created_at
//   orphaned_orders/{uid}/...      orders detached by the email-squatting guard
//   audit/{pushKey}                { at, uid, action, detail }

import { HttpError, json, readJson, clientIp, nowIso, STATUS_LABELS } from './util.js';
import { db, pushKey, rateLimit, safeKey, values } from './db.js';
import { verifyFirebaseToken } from './auth.js';
import { authAdmin, createCustomToken } from './google.js';
import { startOtp, verifyOtp, maskEmail, otpChannels } from './otp.js';
import { normalizePhone, validateAddress, clean, isValidEmail } from './validate.js';
import { getSettings, integrations } from './settings.js';
import { paymentLabel } from './notify.js';

const MAX_ADDRESSES = 5;
const userPath = (uid) => `users/${uid}`;
const e164 = (p) => `+91${p}`;

export function newUid() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const out = [];
  const buf = new Uint8Array(32);
  while (out.length < 27) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 252 && out.length < 27) out.push(alphabet[b % 36]);
  }
  return 'u' + out.join('');
}

async function audit(env, uid, action, detail = null) {
  try { await db(env).put(`audit/${pushKey()}`, { at: nowIso(), uid, action, detail }); } catch (e) { console.error('audit failed', e); }
}

/** Firebase Auth admin call that must not break the user flow (logged + audited on failure). */
async function bestEffort(env, uid, what, fn) {
  try { return await fn(); } catch (e) {
    console.error(`auth admin ${what} failed`, e?.code || e?.message || e);
    await audit(env, uid, 'auth_admin_error', `${what}: ${e?.code || e?.message || e}`);
    return null;
  }
}

function signInMethod(claims) {
  const p = claims?.firebase?.sign_in_provider;
  return p === 'custom' ? 'phone' : p === 'google.com' ? 'google' : p === 'password' ? 'password' : p || 'unknown';
}

export function pendingSteps(p) {
  const out = [];
  if (!p.phone_verified) out.push('phone');
  else if (p.whatsapp_status !== 'verified' && p.whatsapp_status !== 'unavailable') out.push('whatsapp');
  if (!p.email) out.push('email_add');
  else if (!p.email_verified) out.push('email');
  return out;
}

const addressList = (p) => Object.entries(p.addresses || {})
  .map(([id, a]) => ({ id, ...a, default: id === p.default_address_id }))
  .sort((a, b) => (b.default - a.default) || String(a.created_at).localeCompare(String(b.created_at)));

export function publicProfile(p) {
  return {
    uid: p.uid, name: p.name || '', email: p.email || null, email_verified: !!p.email_verified,
    phone: p.phone || null, phone_verified: !!p.phone_verified, phone_verified_via: p.phone_verified_via || null,
    whatsapp_status: p.whatsapp_status || 'unknown', created_via: p.created_via, providers: p.providers || [],
    addresses: addressList(p), default_address_id: p.default_address_id || null,
    pending: pendingSteps(p), created_at: p.created_at,
  };
}

export async function loadProfile(env, uid) {
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return null;
  return db(env).get(userPath(uid));
}

// --------------------------------------------------------------------------- auth

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/** Authenticate a customer request; creates/syncs the profile on first sight. Returns { uid, claims, profile }. */
export async function requireCustomer(request, env, opts = {}) {
  const token = bearer(request);
  if (!token || token.startsWith('dev:')) throw new HttpError(401, 'Please sign in.', { code: 'signin_required' });
  const claims = await verifyFirebaseToken(token, { projectId: env.FIREBASE_PROJECT_ID, ...opts });
  const uid = claims.sub;
  let profile = await loadProfile(env, uid);
  if (profile?.merged_into) throw new HttpError(401, 'Your accounts were combined. Please sign in again.', { code: 'account_merged' });
  if (profile?.disabled) throw new HttpError(403, 'This account has been disabled. Please contact us on WhatsApp.', { code: 'account_disabled' });
  if (!profile) profile = await syncProfile(env, claims, null);
  return { uid, claims, profile };
}

// --------------------------------------------------------------------------- profile sync

/**
 * Bring users/{uid} in line with Firebase Auth (email, verification, providers) and apply the email-squatting guard.
 * `existing` may be null (first sign-in with email/password or Google).
 */
export async function syncProfile(env, claims, existing) {
  const d = db(env);
  const uid = claims.sub;
  const fb = await bestEffort(env, uid, 'lookup', () => authAdmin(env).lookup(uid));
  const email = (fb?.email ?? claims.email ?? null)?.toLowerCase() || null;
  const fbVerified = fb ? fb.email_verified : claims.email_verified === true;
  const providers = fb?.providers ?? (claims.firebase?.sign_in_provider ? [claims.firebase.sign_in_provider] : []);
  const now = nowIso();

  if (!existing) {
    const profile = {
      uid, name: clean(fb?.name || claims.name || '', 80) || null, email, email_verified: !!(email && fbVerified),
      phone: null, phone_verified: false, phone_verified_via: null, whatsapp_status: 'unknown',
      created_via: signInMethod(claims), providers, password_updated_at: fb?.password_updated_at || null,
      created_at: now, updated_at: now, last_login_at: now,
    };
    const updates = { [userPath(uid)]: profile };
    if (email) updates[`user_index/email/${safeKey(email)}`] = uid;
    await d.patch('', updates);
    await audit(env, uid, `signup_${profile.created_via}`, email ? maskEmail(email) : null);
    return profile;
  }

  const p = { ...existing };
  const updates = {};
  const set = (k, v) => { if (p[k] !== v) { p[k] = v; updates[`${userPath(uid)}/${k}`] = v; } };

  // Email-squatting guard: an unverified password account whose email has since been proven by someone else.
  if (p.created_via === 'password' && !p.email_verified && fb) {
    const prevProviders = p.providers || [];
    const takenByGoogle = fb.providers.includes('google.com') && !prevProviders.includes('google.com') && !fb.providers.includes('password');
    const passwordReset = p.password_updated_at && fb.password_updated_at && fb.password_updated_at > p.password_updated_at;
    if (takenByGoogle || passwordReset) {
      await detachUnprovenData(env, p, takenByGoogle ? 'google_takeover' : 'password_reset');
      for (const k of ['phone', 'phone_verified_via', 'default_address_id']) p[k] = null;
      p.phone_verified = false;
      p.whatsapp_status = 'unknown';
      p.addresses = null;
    }
  }

  if (email !== (p.email || null)) {
    if (p.email) {
      const old = `user_index/email/${safeKey(p.email)}`;
      if ((await d.get(old)) === uid) updates[old] = null;
    }
    if (email) updates[`user_index/email/${safeKey(email)}`] = uid;
    set('email', email);
    set('email_verified', !!(email && fbVerified));
  } else if (email && fbVerified && !p.email_verified) {
    set('email_verified', true);
  }
  if (JSON.stringify(providers) !== JSON.stringify(p.providers || [])) { p.providers = providers; updates[`${userPath(uid)}/providers`] = providers; }
  if (fb?.password_updated_at && fb.password_updated_at !== p.password_updated_at) set('password_updated_at', fb.password_updated_at);
  if (!p.name && (fb?.name || claims.name)) set('name', clean(fb?.name || claims.name, 80));
  if (fb?.disabled && !p.disabled) set('disabled', true);
  updates[`${userPath(uid)}/last_login_at`] = now;
  updates[`${userPath(uid)}/updated_at`] = now;
  p.last_login_at = now;
  await d.patch('', updates);
  return p;
}

async function detachUnprovenData(env, p, reason) {
  const d = db(env);
  const updates = {};
  if (p.phone && (await d.get(`user_index/phone/${p.phone}`)) === p.uid) updates[`user_index/phone/${p.phone}`] = null;
  const orders = (await d.get(`user_orders/${p.uid}`)) || {};
  if (Object.keys(orders).length) {
    updates[`orphaned_orders/${p.uid}`] = { at: nowIso(), reason, orders };
    updates[`user_orders/${p.uid}`] = null;
  }
  for (const k of ['phone', 'phone_verified_via', 'addresses', 'default_address_id']) updates[`${userPath(p.uid)}/${k}`] = null;
  updates[`${userPath(p.uid)}/phone_verified`] = false;
  updates[`${userPath(p.uid)}/whatsapp_status`] = 'unknown';
  await d.patch('', updates);
  if (p.phone) await bestEffort(env, p.uid, 'remove phone', () => authAdmin(env).update(p.uid, { phone: null }));
  await audit(env, p.uid, 'squatting_guard', `${reason}; phone and addresses detached`);
}

/** Give a newly verified mobile its earlier orders (placed with that number). */
async function linkPhoneOrders(env, uid, phone) {
  const d = db(env);
  const idx = (await d.get(`order_index/phone/${phone}`)) || {};
  const nos = Object.keys(idx);
  if (!nos.length) return 0;
  const updates = {};
  for (const no of nos) {
    updates[`user_orders/${uid}/${no}`] = typeof idx[no] === 'string' ? idx[no] : nowIso();
    const owner = await d.get(`orders/${no}/uid`);
    if (!owner) updates[`orders/${no}/uid`] = uid;
  }
  await d.patch('', updates);
  return nos.length;
}

// --------------------------------------------------------------------------- mobile OTP sign-in (public)

function phoneFrom(body) {
  const p = normalizePhone(body.phone);
  if (!p) throw new HttpError(422, 'Enter a valid 10-digit Indian mobile number.', { fields: { phone: 'Enter a valid 10-digit mobile number.' } });
  return p;
}

export async function otpLoginStart(request, env) {
  const body = await readJson(request);
  const phone = phoneFrom(body);
  const out = await startOtp(env, { purpose: 'login', target: phone, channel: body.channel, ip: clientIp(request), request, turnstile: body.turnstile });
  return json(out);
}

export async function otpLoginVerify(request, env) {
  const body = await readJson(request);
  const phone = phoneFrom(body);
  if (!(await rateLimit(env, `otpv:ip:${clientIp(request)}`, 60, 3600))) throw new HttpError(429, 'Too many attempts. Please try again later.');
  const r = await verifyOtp(env, { purpose: 'login', target: phone, code: body.code });
  const d = db(env);
  const now = nowIso();

  let uid = await d.get(`user_index/phone/${phone}`);
  let profile = uid ? await loadProfile(env, uid) : null;
  if (profile?.merged_into) { uid = profile.merged_into; profile = await loadProfile(env, uid); }
  let isNew = false;

  if (!profile) {
    // Index lost but Firebase still knows the number? Reuse that user.
    const fbUser = await bestEffort(env, null, 'lookupByPhone', () => authAdmin(env).lookupByPhone(e164(phone)));
    uid = fbUser?.uid || newUid();
    const idx = `user_index/phone/${phone}`;
    const { value: owner, etag } = await d.getWithEtag(idx);
    if (owner && owner !== uid && (await loadProfile(env, owner))) {
      uid = owner; // someone (another tab) created it a moment ago
      profile = await loadProfile(env, uid);
    } else if (!(await d.putIfMatch(idx, uid, etag))) {
      throw new HttpError(409, 'Please try again.');
    }
    if (!profile) {
      if (!fbUser) {
        await bestEffort(env, uid, 'create', async () => {
          try { await authAdmin(env).create({ uid, phone: e164(phone) }); } catch (e) {
            if (e?.code === 'PHONE_NUMBER_EXISTS') await authAdmin(env).create({ uid });
            else if (e?.code !== 'DUPLICATE_LOCAL_ID') throw e;
          }
        });
      }
      profile = {
        uid, name: fbUser?.name || null, email: fbUser?.email || null, email_verified: !!fbUser?.email_verified,
        phone, phone_verified: true, phone_verified_via: r.channel,
        whatsapp_status: r.channel === 'whatsapp' ? 'verified' : r.whatsapp === false ? 'unavailable' : 'unknown',
        created_via: 'phone', providers: fbUser?.providers || [], created_at: now, updated_at: now, last_login_at: now,
      };
      await d.put(userPath(uid), profile);
      await linkPhoneOrders(env, uid, phone);
      await audit(env, uid, 'signup_phone', `via ${r.channel}`);
      isNew = true;
    }
  }
  if (!isNew) {
    if (profile.disabled) throw new HttpError(403, 'This account has been disabled. Please contact us on WhatsApp.', { code: 'account_disabled' });
    const upd = { last_login_at: now, updated_at: now, phone_verified: true };
    if (r.channel === 'whatsapp') upd.whatsapp_status = 'verified';
    await d.patch(userPath(uid), upd);
  }
  return json({ custom_token: await createCustomToken(env, uid), is_new: isNew });
}

// --------------------------------------------------------------------------- email-code sign-in (public)
// Used when the phone code cannot be delivered (OpenWA down, no SMS) or the customer prefers email. Sent with Postal.

function emailFrom(body) {
  const e = clean(body.email, 254).toLowerCase();
  if (!isValidEmail(e)) throw new HttpError(422, 'Enter a valid email address.', { fields: { email: 'Enter a valid email address.' } });
  return e;
}

export async function emailLoginStart(request, env) {
  const body = await readJson(request);
  const email = emailFrom(body);
  return json(await startOtp(env, { purpose: 'login_email', target: email, ip: clientIp(request), request, turnstile: body.turnstile }));
}

export async function emailLoginVerify(request, env) {
  const body = await readJson(request);
  const email = emailFrom(body);
  if (!(await rateLimit(env, `otpv:ip:${clientIp(request)}`, 60, 3600))) throw new HttpError(429, 'Too many attempts. Please try again later.');
  await verifyOtp(env, { purpose: 'login_email', target: email, code: body.code });
  const d = db(env);
  const now = nowIso();
  const idx = `user_index/email/${safeKey(email)}`;

  // The code proves the email, so an existing Firebase account with this email (password, Google or earlier code login) is theirs.
  const fbUser = await authAdmin(env).lookupByEmail(email);
  let uid = fbUser?.uid || null;
  if (!uid) {
    // The index key is shared by lookalike emails (a.b@ and a_b@): only use it if that account has exactly this email.
    const viaIndex = await d.get(idx);
    const p = viaIndex ? await loadProfile(env, viaIndex) : null;
    if (p && String(p.email || '').toLowerCase() === String(email).toLowerCase()) uid = viaIndex;
  }
  let profile = uid ? await loadProfile(env, uid) : null;
  if (profile?.merged_into) { uid = profile.merged_into; profile = await loadProfile(env, uid); }
  let isNew = false, fbCreated = false;

  if (!uid) {
    uid = newUid();
    fbCreated = true;
    try { await authAdmin(env).create({ uid, email, email_verified: true }); } catch (e) {
      if (e?.code === 'EMAIL_EXISTS') { // created a moment ago in another tab
        const again = await authAdmin(env).lookupByEmail(email);
        if (!again) throw new HttpError(409, 'Please try again.');
        uid = again.uid;
        profile = await loadProfile(env, uid);
      } else if (e?.code !== 'DUPLICATE_LOCAL_ID') throw e;
    }
  } else if (fbUser && !fbUser.email_verified) {
    // Someone may have registered this email with a password without owning it: drop what they added, then mark it proven.
    if (profile && !profile.email_verified && profile.created_via === 'password') await detachUnprovenData(env, profile, 'email_code_login');
    await authAdmin(env).update(uid, { email_verified: true });
  }
  if (!fbUser && !fbCreated && !profile) await bestEffort(env, uid, 'create', () => authAdmin(env).create({ uid, email, email_verified: true }));

  if (!profile) {
    profile = {
      uid, name: fbUser?.name || null, email, email_verified: true,
      phone: null, phone_verified: false, phone_verified_via: null, whatsapp_status: 'unknown',
      created_via: 'email_code', providers: fbUser?.providers || [], created_at: now, updated_at: now, last_login_at: now,
    };
    await d.patch('', { [userPath(uid)]: profile, [idx]: uid });
    await audit(env, uid, 'signup_email_code', maskEmail(email));
    isNew = true;
  } else {
    if (profile.disabled) throw new HttpError(403, 'This account has been disabled. Please contact us on WhatsApp.', { code: 'account_disabled' });
    await d.patch('', {
      [`${userPath(uid)}/email`]: email, [`${userPath(uid)}/email_verified`]: true,
      [`${userPath(uid)}/last_login_at`]: now, [`${userPath(uid)}/updated_at`]: now, [idx]: uid,
    });
  }
  return json({ custom_token: await createCustomToken(env, uid), is_new: isNew, needs_phone: !profile.phone_verified });
}

// --------------------------------------------------------------------------- account (signed in)

export async function getAccount(request, env) {
  const { claims, profile } = await requireCustomer(request, env);
  const synced = await syncProfile(env, claims, profile);
  const settings = await getSettings(env);
  return json({
    profile: publicProfile(synced),
    can: { otp_channels: otpChannels(env, settings), email_codes: integrations(env).postal },
  });
}

export async function updateAccount(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  const name = clean(body.name, 80);
  if (name.length < 2) throw new HttpError(422, 'Please enter your name.', { fields: { name: 'Please enter your name.' } });
  await db(env).patch(userPath(uid), { name, updated_at: nowIso() });
  await bestEffort(env, uid, 'update name', () => authAdmin(env).update(uid, { name }));
  return json({ profile: publicProfile({ ...profile, name }) });
}

// ---- mobile

export async function phoneStart(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  const phone = phoneFrom(body);
  if (profile.phone === phone && profile.phone_verified) throw new HttpError(409, 'This mobile number is already verified on your account.', { code: 'already_verified' });
  return json(await startOtp(env, { purpose: 'verify_phone', target: phone, channel: body.channel, uid, ip: clientIp(request), request }));
}

export async function phoneVerify(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  const phone = phoneFrom(body);
  const r = await verifyOtp(env, { purpose: 'verify_phone', target: phone, code: body.code, uid });
  const result = await claimPhone(env, profile, phone, r);
  const fresh = await loadProfile(env, uid);
  return json({ profile: publicProfile(fresh), merged: result.merged || null, orders_linked: result.orders_linked });
}

/** Attach a verified mobile to account A: claim, or merge the email-less account B that owns it, or refuse. */
export async function claimPhone(env, A, phone, r) {
  const d = db(env);
  const idx = `user_index/phone/${phone}`;
  let merged = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 3) throw new HttpError(409, 'Please try again.');
    const { value: owner, etag } = await d.getWithEtag(idx);
    if (owner === A.uid) break;
    const B = owner ? await loadProfile(env, owner) : null;
    if (B && !B.merged_into) {
      if (B.email) {
        throw new HttpError(409, `This mobile number already belongs to another account (${maskEmail(B.email)}). Please sign in to that account.`, {
          code: 'phone_taken', masked_email: maskEmail(B.email),
        });
      }
      if (!(await d.putIfMatch(idx, A.uid, etag))) continue;
      merged = await mergeInto(env, B, A);
      break;
    }
    if (await d.putIfMatch(idx, A.uid, etag)) break;
  }

  const updates = {};
  const base = userPath(A.uid);
  if (A.phone && A.phone !== phone && (await d.get(`user_index/phone/${A.phone}`)) === A.uid) updates[`user_index/phone/${A.phone}`] = null;
  updates[`${base}/phone`] = phone;
  updates[`${base}/phone_verified`] = true;
  updates[`${base}/phone_verified_via`] = r.channel;
  const fresh = await loadProfile(env, A.uid);
  const prevWa = fresh?.phone === phone ? fresh.whatsapp_status : null;
  updates[`${base}/whatsapp_status`] = r.channel === 'whatsapp' ? 'verified' : r.whatsapp === false ? 'unavailable' : (prevWa || merged?.whatsapp_status || 'unknown');
  updates[`${base}/updated_at`] = nowIso();
  await d.patch('', updates);
  if (A.phone && A.phone !== phone) await audit(env, A.uid, 'phone_changed', `${A.phone.slice(-3)} -> ${phone.slice(-3)}`);
  else await audit(env, A.uid, 'phone_verified', `via ${r.channel}`);
  await bestEffort(env, A.uid, 'set phone', () => authAdmin(env).update(A.uid, { phone: e164(phone) }));
  const orders_linked = await linkPhoneOrders(env, A.uid, phone);
  return { merged, orders_linked };
}

/** Move B's orders and addresses into A, retire B (tombstone + delete in Firebase Auth). Index already points to A. */
async function mergeInto(env, B, A) {
  const d = db(env);
  const now = nowIso();
  const updates = {};
  const orders = (await d.get(`user_orders/${B.uid}`)) || {};
  for (const [no, at] of Object.entries(orders)) {
    updates[`user_orders/${A.uid}/${no}`] = at;
    updates[`orders/${no}/uid`] = A.uid;
  }
  updates[`user_orders/${B.uid}`] = null;

  const fresh = (await loadProfile(env, A.uid)) || A;
  const have = Object.values(fresh.addresses || {});
  const key = (a) => `${String(a.line1).toLowerCase()}|${a.pincode}`;
  let count = have.length;
  for (const [id, a] of Object.entries(B.addresses || {})) {
    if (count >= MAX_ADDRESSES || have.some((h) => key(h) === key(a))) continue;
    updates[`${userPath(A.uid)}/addresses/${id}`] = a;
    count++;
  }
  if (!fresh.default_address_id && B.default_address_id && B.addresses?.[B.default_address_id]) updates[`${userPath(A.uid)}/default_address_id`] = B.default_address_id;
  if (!fresh.name && B.name) updates[`${userPath(A.uid)}/name`] = B.name;
  updates[`${userPath(A.uid)}/merged_from/${B.uid}`] = now;
  updates[userPath(B.uid)] = {
    uid: B.uid, merged_into: A.uid, merged_at: now, disabled: true, created_via: B.created_via, created_at: B.created_at,
  };
  await d.patch('', updates);
  await bestEffort(env, B.uid, 'delete merged user', () => authAdmin(env).remove(B.uid));
  await audit(env, A.uid, 'merged', `absorbed ${B.uid} (${Object.keys(orders).length} orders)`);
  await audit(env, B.uid, 'merged_into', A.uid);
  return { from: B.uid, orders: Object.keys(orders).length, whatsapp_status: B.whatsapp_status };
}

// ---- WhatsApp

export async function whatsappStart(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  if (!profile.phone_verified) throw new HttpError(409, 'Please verify your mobile number first.', { code: 'phone_unverified' });
  if (profile.whatsapp_status === 'verified') throw new HttpError(409, 'WhatsApp is already confirmed.', { code: 'already_verified' });
  try {
    return json(await startOtp(env, { purpose: 'verify_whatsapp', target: profile.phone, channel: 'whatsapp', uid, ip: clientIp(request), request }));
  } catch (e) {
    if (e?.details?.code === 'not_on_whatsapp') await db(env).patch(userPath(uid), { whatsapp_status: 'unavailable', updated_at: nowIso() });
    throw e;
  }
}

export async function whatsappVerify(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  await verifyOtp(env, { purpose: 'verify_whatsapp', target: profile.phone, code: body.code, uid });
  await db(env).patch(userPath(uid), { whatsapp_status: 'verified', updated_at: nowIso() });
  await audit(env, uid, 'whatsapp_verified');
  return json({ profile: publicProfile({ ...profile, whatsapp_status: 'verified' }) });
}

// ---- email (code via Postal)

export async function emailStart(request, env) {
  const { uid, claims, profile } = await requireCustomer(request, env);
  const p = await syncProfile(env, claims, profile);
  if (!p.email) throw new HttpError(409, 'Add an email address to your account first.', { code: 'no_email' });
  if (p.email_verified) throw new HttpError(409, 'Your email is already confirmed.', { code: 'already_verified' });
  return json(await startOtp(env, { purpose: 'verify_email', target: p.email, uid, ip: clientIp(request), request }));
}

export async function emailVerify(request, env) {
  const { uid, claims, profile } = await requireCustomer(request, env);
  const p = await syncProfile(env, claims, profile);
  const body = await readJson(request);
  if (!p.email) throw new HttpError(409, 'Add an email address to your account first.', { code: 'no_email' });
  await verifyOtp(env, { purpose: 'verify_email', target: p.email, code: body.code, uid });
  try { await authAdmin(env).update(uid, { email_verified: true }); } catch (e) {
    console.error('set emailVerified failed', e?.code || e);
    throw new HttpError(503, 'Could not confirm your email right now. Please try again.');
  }
  await db(env).patch('', {
    [`${userPath(uid)}/email_verified`]: true,
    [`${userPath(uid)}/updated_at`]: nowIso(),
    [`user_index/email/${safeKey(p.email)}`]: uid,
  });
  await audit(env, uid, 'email_verified');
  return json({ profile: publicProfile({ ...p, email_verified: true }) });
}

// ---- addresses

export async function listAddresses(request, env) {
  const { profile } = await requireCustomer(request, env);
  return json({ addresses: addressList(profile) });
}

function addressInput(body) {
  const { address, fields } = validateAddress(body);
  const name = clean(body.name, 80);
  if (body.name != null && name.length < 2) fields.name = 'Please enter the recipient name.';
  if (Object.keys(fields).length) throw new HttpError(422, 'Please check the highlighted fields.', { fields });
  return { ...address, name: name || null, label: clean(body.label, 30) || null };
}

export async function saveAddress(env, uid, profile, input, { id = null, makeDefault = false } = {}) {
  const addresses = profile.addresses || {};
  if (!id && Object.keys(addresses).length >= MAX_ADDRESSES) {
    throw new HttpError(409, `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`, { code: 'too_many_addresses' });
  }
  if (id && !addresses[id]) throw new HttpError(404, 'Address not found.');
  const aid = id || pushKey();
  const now = nowIso();
  const row = { ...input, created_at: addresses[aid]?.created_at || now, updated_at: now };
  const updates = { [`${userPath(uid)}/addresses/${aid}`]: row, [`${userPath(uid)}/updated_at`]: now };
  if (makeDefault || !profile.default_address_id) updates[`${userPath(uid)}/default_address_id`] = aid;
  await db(env).patch('', updates);
  return aid;
}

export async function createAddress(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  await saveAddress(env, uid, profile, addressInput(body), { makeDefault: body.default === true });
  return json({ addresses: addressList(await loadProfile(env, uid)) }, 201);
}

export async function updateAddress(request, env, id) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  await saveAddress(env, uid, profile, addressInput(body), { id, makeDefault: body.default === true });
  return json({ addresses: addressList(await loadProfile(env, uid)) });
}

export async function deleteAddress(request, env, id) {
  const { uid, profile } = await requireCustomer(request, env);
  if (!profile.addresses?.[id]) throw new HttpError(404, 'Address not found.');
  const rest = Object.keys(profile.addresses).filter((k) => k !== id);
  await db(env).patch('', {
    [`${userPath(uid)}/addresses/${id}`]: null,
    [`${userPath(uid)}/default_address_id`]: profile.default_address_id === id ? rest[0] || null : profile.default_address_id,
  });
  return json({ addresses: addressList(await loadProfile(env, uid)) });
}

// ---- my orders

export async function myOrders(request, env) {
  const { uid } = await requireCustomer(request, env);
  const d = db(env);
  const idx = (await d.get(`user_orders/${uid}`)) || {};
  const nos = Object.entries(idx).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 50).map(([no]) => no);
  const rows = await Promise.all(nos.map((no) => d.get(`orders/${no}`)));
  const orders = rows.filter(Boolean).map((o) => ({
    order_no: o.order_no, created_at: o.created_at, status: o.status, status_label: STATUS_LABELS[o.status] || o.status,
    total: o.total, payment_label: paymentLabel(o), payment_method: o.payment_method, payment_status: o.payment_status,
    items: values(o.items).map((i) => ({ name: i.name, qty: i.qty })),
    courier: o.courier || null, tracking_no: o.tracking_no || null, tracking_url: o.tracking_url || null,
    city: o.city, pincode: o.pincode,
    can_cancel: ['placed', 'confirmed', 'packed'].includes(o.status),
  }));
  return json({ orders });
}

// --------------------------------------------------------------------------- privacy (DPDP Act): export and delete

/** GET /api/account/export: everything we hold about the signed-in customer, as a JSON download. */
export async function exportMyData(request, env, who = null) {
  const { uid, profile } = who || await requireCustomer(request, env);
  const d = db(env);
  const idx = (await d.get(`user_orders/${uid}`)) || {};
  const orders = (await Promise.all(Object.keys(idx).slice(0, 500).map((no) => d.get(`orders/${no}`)))).filter(Boolean)
    .map(({ events, idempotency_key, razorpay_order_id, stock_held, stock_released, ...o }) => ({ ...o, items: values(o.items) }));
  const { addresses, ...rest } = profile || {};
  const data = { exported_at: nowIso(), account: rest, addresses: values(addresses), orders };
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="gomo-my-data.json"', 'cache-control': 'no-store' },
  });
}

const OPEN_STATUSES = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery'];

/**
 * POST /api/account/delete { confirm: "DELETE" }: erase the customer's account.
 * Orders are kept (tax law requires invoices for 8 years) but unlinked from the account.
 * Refused while an order is still on its way, so delivery and refunds can finish.
 */
export async function deleteMyAccount(request, env, who = null) {
  const { uid, profile } = who || await requireCustomer(request, env);
  const body = await readJson(request).catch(() => ({}));
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Please confirm account deletion.');
  if (!(await rateLimit(env, `acctdel:${uid}`, 5, 3600))) throw new HttpError(429, 'Too many attempts. Please try again later.');
  const d = db(env);
  const idx = (await d.get(`user_orders/${uid}`)) || {};
  const orders = (await Promise.all(Object.keys(idx).map((no) => d.get(`orders/${no}/status`))));
  if (orders.some((st) => OPEN_STATUSES.includes(st))) {
    throw new HttpError(409, 'You have an order that is still on its way. You can delete your account once it is delivered or cancelled.', { code: 'open_orders' });
  }
  const updates = {
    [userPath(uid)]: { uid, deleted_at: nowIso(), disabled: true },
    [`user_orders/${uid}`]: null,
  };
  if (profile?.phone && (await d.get(`user_index/phone/${profile.phone}`)) === uid) updates[`user_index/phone/${profile.phone}`] = null;
  if (profile?.email && (await d.get(`user_index/email/${safeKey(profile.email)}`)) === uid) updates[`user_index/email/${safeKey(profile.email)}`] = null;
  await d.patch('', updates);
  await d.patch(`audit/${pushKey()}`, { at: nowIso(), uid, action: 'account_deleted' }).catch(() => {});
  try { await authAdmin(env).remove(uid); } catch (e) { console.error('auth delete failed', e?.message || e); }
  return json({ ok: true });
}
