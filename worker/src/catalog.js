import { HttpError, json, nowIso, randomToken, slugify } from './util.js';
import { isOfferLive, offerCompareAt, offerContents } from './pricing.js';
import { validateOfferInput, validateProductInput } from './validate.js';
import { getSettings, integrations } from './settings.js';
import { db, values } from './db.js';
import { applyMediaChanges, mediaBase, planProductImages } from './media.js';
import { otpChannels } from './otp.js';

const toImages = (imgs) => values(imgs).filter((i) => i && i.id && i.web).map((i) => ({
  id: i.id, alt: i.alt || '', w: i.w || null, h: i.h || null, color: i.transparent ? null : i.color || null, transparent: !!i.transparent, web: i.web, thumb: i.thumb || i.web,
}));

const toProduct = (r) => ({
  id: r.id, name: r.name, category: r.category || '', tag: r.tag || '', description: r.description || '',
  chips: Array.isArray(r.chips) ? r.chips : values(r.chips), price: Number(r.price) || 0, mrp: Number(r.mrp) || 0,
  details: values(r.details).filter((d) => d && d.value).map((d) => ({ label: d.label || '', value: d.value })), art: r.art || 'candle',
  images: toImages(r.images),
  // Tracked stock: sold out at 0 even if the switch is on.
  hsn: r.hsn || null, gst_rate: r.gst_rate == null ? null : Number(r.gst_rate),
  stock: r.stock == null ? null : Number(r.stock), low_stock_at: r.low_stock_at == null ? 5 : Number(r.low_stock_at),
  in_stock: !!r.in_stock && (r.stock == null || Number(r.stock) > 0), in_stock_switch: !!r.in_stock, orderable: !!r.orderable, published: !!r.published, sort: Number(r.sort) || 0,
  created_at: r.created_at || null, updated_at: r.updated_at || null,
});

const toOffer = (r) => ({
  id: r.id, type: r.type, name: r.name, description: r.description || '', badge: r.badge || '', price: Number(r.price) || 0,
  published: !!r.published, starts_at: r.starts_at || null, ends_at: r.ends_at || null, countdown: r.countdown !== false, sort: Number(r.sort) || 0,
  images: toImages(r.images),
  created_at: r.created_at || null, updated_at: r.updated_at || null,
  items: values(r.items).map((i) => ({ product_id: i.product_id, qty: Number(i.qty) })),
});

const bySort = (a, b) => a.sort - b.sort || a.name.localeCompare(b.name);

export async function loadCatalog(env) {
  const d = db(env);
  const [p, o] = await Promise.all([d.get('products'), d.get('offers')]);
  const products = values(p).filter((x) => x && x.id).map(toProduct).sort(bySort);
  const offers = values(o).filter((x) => x && x.id).map(toOffer).sort(bySort);
  const productsById = Object.fromEntries(products.map((x) => [x.id, x]));
  const offersById = Object.fromEntries(offers.map((x) => [x.id, x]));
  return { products, offers, productsById, offersById };
}

/** Shape an offer for display (both public and admin), with computed compare-at price and savings. */
export function decorateOffer(offer, productsById, now = Date.now()) {
  const compare_at = offerCompareAt(offer, productsById);
  return {
    ...offer,
    compare_at,
    savings: Math.max(0, compare_at - offer.price),
    contents: offerContents(offer, productsById),
    live: isOfferLive(offer, now),
    items: offer.items.map((it) => ({
      ...it,
      name: productsById[it.product_id]?.name || it.product_id,
      art: productsById[it.product_id]?.art || 'candle',
      image: productsById[it.product_id]?.images?.[0] || null,
      unit_price: productsById[it.product_id]?.price || 0,
      unit_mrp: Math.max(productsById[it.product_id]?.mrp || 0, productsById[it.product_id]?.price || 0),
    })),
  };
}

export async function getPublicCatalog(env) {
  const [cat, settings] = await Promise.all([loadCatalog(env), getSettings(env)]);
  const now = Date.now();
  // Shoppers see only "few left" when stock is low, never the exact count above that.
  const products = cat.products.filter((p) => p.published).map(({ created_at, updated_at, published, stock, low_stock_at, in_stock_switch, hsn, gst_rate, ...p }) => ({
    ...p, few_left: stock != null && stock > 0 && stock <= low_stock_at ? stock : null,
  }));
  const offers = cat.offers
    .filter((o) => isOfferLive(o, now) && o.items.length && o.items.every((it) => cat.productsById[it.product_id]?.published))
    .map((o) => {
      const d = decorateOffer(o, cat.productsById, now);
      const available = o.items.every((it) => cat.productsById[it.product_id]?.in_stock);
      const { created_at, updated_at, published, live, ...rest } = d;
      return { ...rest, in_stock: available };
    });
  const rzpOn = settings.payments.razorpay && integrations(env).razorpay;
  return {
    store: { name: settings.store.name, whatsapp: settings.store.whatsapp, email: settings.store.email },
    shipping: settings.shipping,
    payments: { cod: settings.payments.cod, razorpay: rzpOn, razorpay_key_id: rzpOn ? env.RAZORPAY_KEY_ID : null },
    account: { otp_channels: otpChannels(env, settings), email_login: integrations(env).postal || env.DEV_OTP_ECHO === '1', turnstile_site_key: env.TURNSTILE_SECRET ? settings.otp.turnstile_site_key || null : null },
    media_base: mediaBase(env),
    products,
    offers,
    generated_at: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------- admin: products

async function uniqueId(env, collection, base) {
  const existing = (await db(env).get(collection, { shallow: true })) || {};
  let id = slugify(base);
  for (let i = 0; i < 5 && existing[id]; i++) id = `${slugify(base).slice(0, 40)}-${randomToken(4)}`;
  if (existing[id]) throw new HttpError(409, 'Could not create a unique id, try a different name.');
  return id;
}

export async function adminListProducts(env) {
  const cat = await loadCatalog(env);
  const usage = {};
  for (const o of cat.offers) for (const it of o.items) (usage[it.product_id] ||= []).push(o.name);
  return json({ products: cat.products.map((p) => ({ ...p, used_in_offers: usage[p.id] || [] })) });
}

const FLAGS = ['in_stock', 'orderable', 'published'];
function productRow(v) {
  const row = { ...v };
  if ('chips' in row) row.chips = JSON.parse(row.chips);
  if ('details' in row) row.details = JSON.parse(row.details);
  for (const k of FLAGS) if (k in row) row[k] = !!row[k];
  return row;
}

export async function adminCreateProduct(env, body) {
  const v = validateProductInput(body);
  const id = await uniqueId(env, 'products', v.name);
  const now = nowIso();
  const row = {
    id, name: v.name, category: v.category ?? '', tag: v.tag ?? '', description: v.description ?? '',
    chips: JSON.parse(v.chips ?? '[]'), price: v.price, mrp: v.mrp ?? 0, details: JSON.parse(v.details ?? '[]'), art: v.art ?? 'candle',
    in_stock: (v.in_stock ?? 1) === 1, orderable: (v.orderable ?? 1) === 1, published: (v.published ?? 0) === 1,
    sort: v.sort ?? 100, created_at: now, updated_at: now,
  };
  // optional fields from the form (kept like on edit; absent = not tracked / store default)
  for (const k of ['stock', 'low_stock_at', 'hsn', 'gst_rate']) if (v[k] !== undefined && v[k] !== null) row[k] = v[k];
  await db(env).put(`products/${id}`, row);
  return json({ product: toProduct(row) }, 201);
}

export async function adminUpdateProduct(env, id, body) {
  const v = validateProductInput(body, { partial: true });
  const hasImages = Object.prototype.hasOwnProperty.call(body, 'images');
  if (!Object.keys(v).length && !hasImages) throw new HttpError(400, 'Nothing to update.');
  const d = db(env);
  const current = await d.get(`products/${id}`);
  if (!current) throw new HttpError(404, 'Product not found.');
  const patch = { ...productRow(v), updated_at: nowIso() };
  let plan = null;
  if (hasImages) {
    plan = await planProductImages(env, id, current.images, body.images);
    patch.images = plan.images;
  }
  await d.patch(`products/${id}`, patch);
  // Only after the product is saved: attach new photos, move removed / replaced ones to trash.
  if (plan) await applyMediaChanges(env, plan);
  return json({ product: toProduct({ ...current, ...patch }) });
}

export async function adminDeleteProduct(env, id) {
  const cat = await loadCatalog(env);
  if (!cat.productsById[id]) throw new HttpError(404, 'Product not found.');
  const used = cat.offers.filter((o) => o.items.some((i) => i.product_id === id));
  if (used.length) {
    throw new HttpError(409, `This product is part of: ${used.map((o) => o.name).join(', ')}. Remove it from those offers or unpublish it instead.`);
  }
  await db(env).remove(`products/${id}`);
  const trash = cat.productsById[id].images.map((i) => i.id);
  const pending = values(await db(env).get('media', { orderBy: 'product_id', equalTo: id })).filter((m) => m.status !== 'trash').map((m) => m.id);
  await applyMediaChanges(env, { trash: [...new Set([...trash, ...pending])] });
  return json({ ok: true });
}

// ---------------------------------------------------------------- admin: offers

export async function adminListOffers(env) {
  const cat = await loadCatalog(env);
  return json({ offers: cat.offers.map((o) => decorateOffer(o, cat.productsById)), products: cat.products });
}

async function writeOffer(env, id, v, existing, imagesIn) {
  const now = nowIso();
  // Offer photos (optional): same uploader/storage as products, owner key "offer-<id>".
  let plan = null;
  if (imagesIn !== undefined) plan = await planProductImages(env, `offer-${id}`, existing?.images, imagesIn);
  const row = {
    id, type: v.type, name: v.name, description: v.description, badge: v.badge, price: v.price, published: !!v.published,
    starts_at: v.starts_at, ends_at: v.ends_at, countdown: v.countdown !== false, sort: v.sort, items: v.items,
    images: plan ? plan.images : (existing?.images || null),
    created_at: existing?.created_at || now, updated_at: now,
  };
  await db(env).put(`offers/${id}`, row);
  if (plan) await applyMediaChanges(env, plan);
  const cat = await loadCatalog(env);
  return decorateOffer(toOffer(row), cat.productsById);
}

async function productIds(env) {
  return new Set(Object.keys((await db(env).get('products', { shallow: true })) || {}));
}

export async function adminCreateOffer(env, body) {
  const v = validateOfferInput(body, await productIds(env));
  const id = await uniqueId(env, 'offers', `${v.type}-${v.name}`);
  return json({ offer: await writeOffer(env, id, v, null) }, 201);
}

export async function adminUpdateOffer(env, id, body) {
  const existing = await db(env).get(`offers/${id}`);
  if (!existing) throw new HttpError(404, 'Offer not found.');
  const v = validateOfferInput(body, await productIds(env));
  return json({ offer: await writeOffer(env, id, v, existing, Object.prototype.hasOwnProperty.call(body, 'images') ? body.images : undefined) });
}

export async function adminPublishOffer(env, id, published) {
  const d = db(env);
  if (!(await d.get(`offers/${id}/id`))) throw new HttpError(404, 'Offer not found.');
  await d.patch(`offers/${id}`, { published: !!published, updated_at: nowIso() });
  return json({ ok: true, published: !!published });
}

export async function adminDeleteOffer(env, id) {
  const d = db(env);
  const cur = await d.get(`offers/${id}`);
  if (!cur) throw new HttpError(404, 'Offer not found.');
  await d.remove(`offers/${id}`);
  // Delete its photos from storage too (cleanup job removes the files).
  const pending = values(await d.get('media', { orderBy: 'product_id', equalTo: `offer-${id}` })).filter((m) => m.status !== 'trash').map((m) => m.id);
  const ids = [...new Set([...values(cur.images).map((i) => i?.id).filter(Boolean), ...pending])];
  if (ids.length) await applyMediaChanges(env, { trash: ids });
  return json({ ok: true });
}
