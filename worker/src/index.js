import { HttpError, json, readJson } from './util.js';
import { db } from './db.js';
import { requireAdmin, requireArea, adminEmails } from './auth.js';
import { adminListStaff, adminSaveStaff, adminRemoveStaff, adminDeclineRequest, adminListRoles, adminSaveRole, adminDeleteRole } from './staff.js';
import { adminListCoupons, adminCreateCoupon, adminUpdateCoupon, adminDeleteCoupon } from './coupons.js';
import {
  getPublicCatalog, adminListProducts, adminCreateProduct, adminUpdateProduct, adminDeleteProduct,
  adminListOffers, adminCreateOffer, adminUpdateOffer, adminPublishOffer, adminDeleteOffer,
} from './catalog.js';
import {
  createOrder, verifyPayment, retryPayment, switchToCod, razorpayWebhook, trackOrder,
  adminListOrders, adminGetOrder, adminUpdateOrder, adminNotifyOrder, adminStats, checkCoupon, adminExportOrders,
  expireUnpaidOrders, customerCancelOrder,
} from './orders.js';
import {
  adminGetSettings, adminPutSettings, adminTestNotification, adminListNotifications, adminRetryNotification,
  adminTestOtp, adminDismissNotifications, adminListCustomers, adminGetCustomer, adminSetCustomerDisabled,
} from './admin.js';
import {
  requireCustomer, otpLoginStart, otpLoginVerify, getAccount, updateAccount, phoneStart, phoneVerify,
  whatsappStart, whatsappVerify, emailStart, emailVerify, emailLoginStart, emailLoginVerify, listAddresses, createAddress, updateAddress, deleteAddress, myOrders, exportMyData, deleteMyAccount,
} from './account.js';
import { geoReverse, geoPincode } from './geo.js';
import {
  adminCreateMedia, adminUploadVariant, adminUploadPart, adminGetMedia, adminCompleteMedia, adminDeleteMedia, adminListMedia,
  serveMedia, runCleanup, adminStorageStats, adminTestStorage,
} from './media.js';
import { INDIAN_STATES } from './validate.js';
import { adminGetInvoice } from './invoice.js';
import { runBackup, adminBackupStatus, adminDownloadBackup } from './backup.js';
import { adminCheckIntegrations } from './health.js';
import { adminUploadFile, adminListFiles, adminUpdateFile, adminDeleteFile } from './files.js';
import { checkPayment, adminCheckPayment, adminProcessRefund, adminRefreshRefund, pollRefunds } from './refunds.js';
import { adminBookShipment, adminSyncShipment, adminCancelShipment, adminListPickups, courierWebhook, pollShipments } from './shiprocket.js';

const ORDER_NO = '(GM-\\d{6}-\\d{4})';
const ID = '([a-z0-9-]{1,64})';
const MID = '([a-z0-9]{10,24})';
const UID = '([A-Za-z0-9_-]{1,128})';
const VARIANT = '(original|web|thumb)';

// [method, pattern, handler(ctx), auth?]   auth: 'admin' | 'customer' | undefined (public)
// Public catalog: the same for every visitor, so it is built at most once every CATALOG_TTL_MS per Worker instance
// (and concurrent requests share one build). Orders never use this copy: they re-read prices and stock live.
const CATALOG_TTL_MS = 15000;
let catalogMemo = null; // { at, v, promise }
function cachedCatalog(env, now = Date.now()) {
  if (catalogMemo && now - catalogMemo.at < CATALOG_TTL_MS) return catalogMemo.promise;
  const memo = { at: now, v: 0, promise: null };
  // the change stamp is read before building, so `version` is never newer than the data it labels
  memo.promise = (async () => {
    memo.v = Number(await db(env).get('changes/catalog').catch(() => 0)) || 0;
    return { ...(await getPublicCatalog(env)), version: memo.v };
  })();
  memo.promise.catch(() => { if (catalogMemo === memo) catalogMemo = null; }); // never keep a failure
  catalogMemo = memo;
  return memo.promise;
}
// ?v=<stamp> from /api/changes asks for a catalog at least that new; capped at the real stamp so a made-up v can't
// force a rebuild on every request.
async function catalogFor(env, want) {
  if (want > 0 && catalogMemo) {
    await catalogMemo.promise.catch(() => {});
    const real = Number((await cachedChanges(env)).catalog) || 0;
    if (catalogMemo && catalogMemo.v < Math.min(want, real)) catalogMemo = null;
  }
  return cachedCatalog(env);
}

// Live updates: changes/<topic> = time of the last write (see db.js). Polled by open admin and shop pages, so it
// is read at most every 2 s per Worker instance.
let changesMemo = null;
function cachedChanges(env, now = Date.now()) {
  if (changesMemo && now - changesMemo.at < 2000) return changesMemo.promise;
  const memo = { at: now, promise: db(env).get('changes').then((v) => v || {}) };
  memo.promise.catch(() => { if (changesMemo === memo) changesMemo = null; });
  changesMemo = memo;
  return memo.promise;
}

const routes = [
  ['GET', '/api/health', () => json({ ok: true })],
  ['GET', '/api/catalog', async ({ env, url }) => json(await catalogFor(env, Number(url.searchParams.get('v')) || 0), 200, { 'cache-control': 'public, max-age=30' })],
  ['GET', '/api/changes', async ({ env }) => { const c = await cachedChanges(env); return json({ catalog: Number(c.catalog) || 0, settings: Number(c.settings) || 0 }, 200, { 'cache-control': 'no-store' }); }],
  ['GET', '/api/states', () => json({ states: INDIAN_STATES }, 200, { 'cache-control': 'public, max-age=86400' })],
  ['POST', '/api/coupons/check', ({ request, env }) => checkCoupon(request, env)],
  ['POST', '/api/orders', ({ request, env, ctx }) => createOrder(request, env, ctx)],
  ['POST', `/api/orders/${ORDER_NO}/verify-payment`, ({ request, env, ctx, m }) => verifyPayment(request, env, ctx, m[1])],
  ['POST', `/api/orders/${ORDER_NO}/retry-payment`, ({ request, env, ctx, m }) => retryPayment(request, env, ctx, m[1])],
  ['POST', `/api/orders/${ORDER_NO}/check-payment`, ({ request, env, ctx, m }) => checkPayment(request, env, ctx, m[1])],
  ['POST', `/api/orders/${ORDER_NO}/switch-to-cod`, ({ request, env, ctx, m }) => switchToCod(request, env, ctx, m[1])],
  ['POST', `/api/orders/${ORDER_NO}/cancel`, ({ request, env, ctx, m }) => customerCancelOrder(request, env, ctx, m[1])],
  ['GET', '/api/track', ({ request, env }) => trackOrder(request, env)],
  ['POST', '/api/razorpay/webhook', ({ request, env, ctx }) => razorpayWebhook(request, env, ctx)],
  // Shiprocket tracking webhook (its URL may not contain "shiprocket", "sr" or "kr")
  ['POST', '/api/courier/webhook', ({ request, env, ctx }) => courierWebhook(request, env, ctx)],

  // customer sign-in by mobile OTP (public) and account (signed in; each handler authenticates itself)
  ['POST', '/api/auth/otp/start', ({ request, env }) => otpLoginStart(request, env)],
  ['POST', '/api/auth/otp/verify', ({ request, env }) => otpLoginVerify(request, env)],
  ['POST', '/api/auth/email/start', ({ request, env }) => emailLoginStart(request, env)],
  ['POST', '/api/auth/email/verify', ({ request, env }) => emailLoginVerify(request, env)],
  ['GET', '/api/account', ({ request, env }) => getAccount(request, env)],
  ['PUT', '/api/account', ({ request, env }) => updateAccount(request, env)],
  ['POST', '/api/account/phone/start', ({ request, env }) => phoneStart(request, env)],
  ['POST', '/api/account/phone/verify', ({ request, env }) => phoneVerify(request, env)],
  ['POST', '/api/account/whatsapp/start', ({ request, env }) => whatsappStart(request, env)],
  ['POST', '/api/account/whatsapp/verify', ({ request, env }) => whatsappVerify(request, env)],
  ['POST', '/api/account/email/start', ({ request, env }) => emailStart(request, env)],
  ['POST', '/api/account/email/verify', ({ request, env }) => emailVerify(request, env)],
  ['GET', '/api/account/addresses', ({ request, env }) => listAddresses(request, env)],
  ['POST', '/api/account/addresses', ({ request, env }) => createAddress(request, env)],
  ['PUT', `/api/account/addresses/${MID}`, ({ request, env, m }) => updateAddress(request, env, m[1])],
  ['DELETE', `/api/account/addresses/${MID}`, ({ request, env, m }) => deleteAddress(request, env, m[1])],
  ['GET', '/api/account/orders', ({ request, env }) => myOrders(request, env)],
  ['GET', '/api/account/export', ({ request, env }) => exportMyData(request, env)],
  ['POST', '/api/account/delete', ({ request, env }) => deleteMyAccount(request, env)],
  ['GET', '/api/geo/reverse', ({ request, env, customer }) => geoReverse(request, env, customer.uid), 'customer'],
  ['GET', '/api/geo/pincode/([1-9]\\d{5})', ({ request, env, customer, m }) => geoPincode(request, env, customer.uid, m[1]), 'customer'],

  ['GET', '/api/admin/me', ({ admin }) => json({ admin }), 'admin'],
  ['GET', '/api/admin/changes', async ({ env }) => json({ changes: await cachedChanges(env) }, 200, { 'cache-control': 'no-store' }), 'admin'],
  ['GET', '/api/admin/stats', ({ env }) => adminStats(env), 'admin'],
  ['GET', '/api/admin/products', ({ env }) => adminListProducts(env), 'admin'],
  ['POST', '/api/admin/products', async ({ request, env }) => adminCreateProduct(env, await readJson(request)), 'admin'],
  ['PUT', `/api/admin/products/${ID}`, async ({ request, env, m }) => adminUpdateProduct(env, m[1], await readJson(request)), 'admin'],
  ['DELETE', `/api/admin/products/${ID}`, ({ env, m }) => adminDeleteProduct(env, m[1]), 'admin'],
  ['GET', '/api/admin/offers', ({ env }) => adminListOffers(env), 'admin'],
  ['POST', '/api/admin/offers', async ({ request, env }) => adminCreateOffer(env, await readJson(request)), 'admin'],
  ['PUT', `/api/admin/offers/${ID}`, async ({ request, env, m }) => adminUpdateOffer(env, m[1], await readJson(request)), 'admin'],
  ['POST', `/api/admin/offers/${ID}/publish`, async ({ request, env, m }) => adminPublishOffer(env, m[1], (await readJson(request)).published), 'admin'],
  ['DELETE', `/api/admin/offers/${ID}`, ({ env, m }) => adminDeleteOffer(env, m[1]), 'admin'],
  ['GET', '/api/admin/exports/orders.csv', ({ request, env }) => adminExportOrders(request, env), 'admin'],
  ['GET', '/api/admin/orders', ({ request, env }) => adminListOrders(request, env), 'admin'],
  ['GET', `/api/admin/orders/${ORDER_NO}`, ({ env, m }) => adminGetOrder(env, m[1]), 'admin'],
  ['PATCH', `/api/admin/orders/${ORDER_NO}`, ({ request, env, ctx, m, admin }) => adminUpdateOrder(request, env, ctx, m[1], admin), 'admin'],
  ['GET', `/api/admin/orders/${ORDER_NO}/invoice`, ({ env, m }) => adminGetInvoice(env, m[1]), 'admin'],
  ['POST', `/api/admin/orders/${ORDER_NO}/notify`, ({ request, env, m }) => adminNotifyOrder(request, env, m[1]), 'admin'],
  ['POST', '/api/admin/integrations/check', ({ env }) => adminCheckIntegrations(env), 'admin'],
  ['GET', '/api/admin/coupons', ({ env }) => adminListCoupons(env), 'admin'],
  ['POST', '/api/admin/coupons', ({ request, env }) => adminCreateCoupon(request, env), 'admin'],
  ['PUT', '/api/admin/coupons/([A-Za-z0-9-]{3,20})', ({ request, env, m }) => adminUpdateCoupon(request, env, m[1]), 'admin'],
  ['DELETE', '/api/admin/coupons/([A-Za-z0-9-]{3,20})', ({ env, m }) => adminDeleteCoupon(env, m[1]), 'admin'],
  // team (owner only — enforced by requireArea: /api/admin/staff is a settings path)
  ['POST', '/api/admin/access-requests/([^/]{3,254})/decline', ({ env, m, admin }) => adminDeclineRequest(env, decodeURIComponent(m[1]), admin), 'admin'],
  ['GET', '/api/admin/roles', ({ env }) => adminListRoles(env), 'admin'],
  ['PUT', '/api/admin/roles', async ({ request, env, admin }) => adminSaveRole(env, await readJson(request), admin), 'admin'],
  ['DELETE', '/api/admin/roles/([a-z0-9-]{2,31})', ({ env, m, admin }) => adminDeleteRole(env, m[1], admin), 'admin'],
  ['GET', '/api/admin/staff', ({ env }) => adminListStaff(env, adminEmails(env)), 'admin'],
  ['PUT', '/api/admin/staff', async ({ request, env, admin }) => adminSaveStaff(env, await readJson(request), admin, adminEmails(env)), 'admin'],
  ['DELETE', '/api/admin/staff/([^/]{3,254})', ({ env, m, admin }) => adminRemoveStaff(env, decodeURIComponent(m[1]), admin), 'admin'],
  ['GET', '/api/admin/settings', ({ env }) => adminGetSettings(env), 'admin'],
  ['PUT', '/api/admin/settings', ({ request, env, admin }) => adminPutSettings(request, env, admin), 'admin'],
  ['POST', '/api/admin/test-notification', ({ request, env }) => adminTestNotification(request, env), 'admin'],
  ['POST', '/api/admin/test-otp', ({ request, env, admin }) => adminTestOtp(request, env, admin), 'admin'],
  ['GET', '/api/admin/notifications', ({ request, env }) => adminListNotifications(request, env), 'admin'],
  ['POST', '/api/admin/notifications/dismiss', ({ request, env, admin }) => adminDismissNotifications(request, env, admin), 'admin'],
  ['POST', `/api/admin/notifications/${MID}/retry`, ({ env, m }) => adminRetryNotification(env, m[1]), 'admin'],
  ['GET', '/api/admin/customers', ({ request, env }) => adminListCustomers(request, env), 'admin'],
  ['GET', `/api/admin/customers/${UID}`, ({ env, m }) => adminGetCustomer(env, m[1]), 'admin'],
  ['POST', `/api/admin/customers/${UID}/disable`, ({ env, m, admin }) => adminSetCustomerDisabled(env, m[1], true, admin), 'admin'],
  ['POST', `/api/admin/customers/${UID}/enable`, ({ env, m, admin }) => adminSetCustomerDisabled(env, m[1], false, admin), 'admin'],

  // product photos
  ['GET', '/api/admin/media', ({ request, env }) => adminListMedia(request, env), 'admin'],
  ['POST', '/api/admin/media', ({ request, env }) => adminCreateMedia(request, env), 'admin'],
  ['GET', `/api/admin/media/${MID}`, ({ env, m }) => adminGetMedia(env, m[1]), 'admin'],
  ['DELETE', `/api/admin/media/${MID}`, ({ env, m }) => adminDeleteMedia(env, m[1]), 'admin'],
  ['POST', `/api/admin/media/${MID}/delete`, ({ env, m }) => adminDeleteMedia(env, m[1]), 'admin'], // for sendBeacon/keepalive
  ['PUT', `/api/admin/media/${MID}/${VARIANT}`, ({ request, env, m }) => adminUploadVariant(request, env, m[1], m[2]), 'admin'],
  ['PUT', `/api/admin/media/${MID}/${VARIANT}/parts/(\\d{1,5})`, ({ request, env, m }) => adminUploadPart(request, env, m[1], m[2], Number(m[3])), 'admin'],
  ['POST', `/api/admin/media/${MID}/complete`, ({ env, m }) => adminCompleteMedia(env, m[1]), 'admin'],
  // file library (any file type)
  ['GET', '/api/admin/files', ({ request, env }) => adminListFiles(request, env), 'admin'],
  ['PUT', '/api/admin/files', ({ request, env, admin }) => adminUploadFile(request, env, admin), 'admin'],
  ['PATCH', `/api/admin/files/${MID}`, async ({ request, env, m }) => adminUpdateFile(env, m[1], await readJson(request)), 'admin'],
  ['DELETE', `/api/admin/files/${MID}`, ({ request, env, m }) => adminDeleteFile(request, env, m[1]), 'admin'],
  ['GET', '/api/admin/backups', ({ env }) => adminBackupStatus(env), 'admin'],
  ['POST', '/api/admin/backups/run', async ({ env }) => json({ backup: await runBackup(env, { force: true }) }), 'admin'],
  ['GET', '/api/admin/backups/(\\d{4}-\\d{2}-\\d{2}\\.json\\.gz)', ({ env, m }) => adminDownloadBackup(env, m[1]), 'admin'],
  // online payments: ask Razorpay directly; refunds start only when an admin presses Process refund
  ['POST', `/api/admin/orders/${ORDER_NO}/check-payment`, ({ env, ctx, m, admin }) => adminCheckPayment(env, ctx, m[1], admin), 'admin'],
  ['POST', `/api/admin/orders/${ORDER_NO}/refund`, ({ request, env, m, admin }) => adminProcessRefund(request, env, m[1], admin), 'admin'],
  ['POST', `/api/admin/orders/${ORDER_NO}/refund/refresh`, ({ env, m, admin }) => adminRefreshRefund(env, m[1], admin), 'admin'],
  // Shiprocket: book the courier pickup from the order page
  ['POST', `/api/admin/orders/${ORDER_NO}/shiprocket/book`, ({ request, env, m, admin }) => adminBookShipment(request, env, m[1], admin), 'admin'],
  ['POST', `/api/admin/orders/${ORDER_NO}/shiprocket/sync`, ({ env, m, admin }) => adminSyncShipment(env, m[1], admin), 'admin'],
  ['POST', `/api/admin/orders/${ORDER_NO}/shiprocket/cancel`, ({ env, m, admin }) => adminCancelShipment(env, m[1], admin), 'admin'],
  ['GET', '/api/admin/shiprocket/pickups', ({ env }) => adminListPickups(env), 'admin'],
  ['GET', '/api/admin/storage', ({ env }) => adminStorageStats(env), 'admin'],
  ['POST', '/api/admin/storage/test', ({ env }) => adminTestStorage(env), 'admin'],
  ['POST', '/api/admin/storage/cleanup', async ({ env }) => json({ summary: await runCleanup(env, { sweep: true }) }), 'admin'],
].map(([method, path, handler, auth]) => ({ method, re: new RegExp(`^${path}$`), handler, auth: auth || null }));

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function withCors(response, origin) {
  if (!origin) return response;
  const res = new Response(response.body, response);
  res.headers.set('access-control-allow-origin', origin);
  res.headers.set('access-control-expose-headers', 'content-disposition');
  res.headers.set('vary', 'origin');
  return res;
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);

  // Product photos: public, cacheable, no CORS restrictions (images are embedded with <img>).
  if (url.pathname.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      return await serveMedia(request, env, ctx, decodeURIComponent(url.pathname.slice('/media/'.length)));
    } catch (e) {
      console.error('media error', e?.message || e);
      return new Response('Temporarily unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  }

  const origin = allowedOrigin(request, env);

  if (request.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
        vary: 'origin',
      },
    });
  }

  // Browsers on other sites may not call the API (webhooks and server-to-server calls carry no Origin).
  if (request.headers.get('origin') && !origin && url.pathname !== '/api/razorpay/webhook') {
    return json({ error: 'Origin not allowed' }, 403);
  }

  try {
    const methodMatch = routes.filter((r) => r.re.test(url.pathname));
    if (!methodMatch.length) throw new HttpError(404, 'Not found');
    const route = methodMatch.find((r) => r.method === request.method);
    if (!route) throw new HttpError(405, 'Method not allowed');
    const m = url.pathname.match(route.re);
    const admin = route.auth === 'admin' ? await requireAdmin(request, env) : null;
    if (admin) requireArea(admin, request.method, url.pathname);
    const customer = route.auth === 'customer' ? await requireCustomer(request, env) : null;
    const res = await route.handler({ request, env, ctx, m, admin, customer, url });
    return withCors(res, origin);
  } catch (e) {
    if (e instanceof HttpError) return withCors(json({ error: e.message, ...(e.details || {}) }, e.status), origin);
    console.error('unhandled', e?.stack || e);
    return withCors(json({ error: 'Something went wrong. Please try again.' }, 500), origin);
  }
}

export async function scheduled(event, env, ctx) {
  ctx.waitUntil(runCleanup(env).then((s) => console.log('media cleanup', JSON.stringify(s))).catch((e) => console.error('cleanup failed', e?.stack || e)));
  // Unpaid online orders: release their stock and coupon after UNPAID_HOLD_MIN minutes.
  ctx.waitUntil(expireUnpaidOrders(env, { ctx }).then((s) => { if (s.expired.length) console.log('expired unpaid', JSON.stringify(s)); }).catch((e) => console.error('expire unpaid failed', e?.stack || e)));
  // Shiprocket shipments not updated for 2 hours: fetch tracking (backup for the webhook).
  ctx.waitUntil(pollShipments(env).then((s) => { if (s.moved.length) console.log('shipments', JSON.stringify(s)); }).catch((e) => console.error('shipment poll failed', e?.stack || e)));
  // Refunds started from the admin: mark them Refunded once Razorpay has finished (backup for the webhook).
  ctx.waitUntil(pollRefunds(env).then((s) => { if (s.done.length) console.log('refunds', JSON.stringify(s)); }).catch((e) => console.error('refund poll failed', e?.stack || e)));
  // Daily backup: the cron runs every 30 min; runBackup only does work once per IST day.
  ctx.waitUntil(runBackup(env).then((s) => { if (!s.skipped) console.log('backup', JSON.stringify(s)); }).catch((e) => console.error('backup failed', e?.stack || e)));
}

export default { fetch: handle, scheduled };
