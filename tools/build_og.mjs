// Per-product social previews (Open Graph / Twitter / WhatsApp).
// Link-preview crawlers don't run JavaScript, so every /product/<slug> and /combo/<slug> gets its own static HTML copy of
// index.html with that item's title, description, price and image in the <head>, plus a 1200x630 JPEG share card.
//   node tools/build_og.mjs          (run before `firebase deploy --only hosting`; `npm run deploy:shop` does both)
// Output: product/<slug>/index.html, combo/<slug>/index.html, assets/og/<kind>-<slug>.jpg  (all generated, safe to delete)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://gomo.earthenbeauty.in';
const API = 'https://gomo-api.soumalya9862.workers.dev';
const VER = Date.now().toString(36); // cache-buster so platforms refetch new cards
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const media = (key) => (/^https?:/.test(key) ? key : /^assets\//.test(key) ? `file://${join(ROOT, key)}` : `${API}/media/${String(key).split('/').map(encodeURIComponent).join('/')}`);

const cat = await (await fetch(`${API}/api/catalog`)).json();
const byId = Object.fromEntries(cat.products.map((p) => [p.id, p]));
const STOCK = { candle: 'assets/img/candle-1400.webp', sachet: 'assets/img/sachet-1400.webp', spray: 'assets/img/mist-1400.webp', gift: 'assets/img/gift-open-1600.webp' };
const imgOf = (p) => (p?.images?.[0]?.web ? media(p.images[0].web) : STOCK[p?.id] ? media(STOCK[p.id]) : null);

const items = [
  ...cat.products.map((p) => ({
    kind: 'product', path: `/product/${slug(p.name) || p.id}`, slug: slug(p.name) || p.id, name: p.name,
    desc: p.description || `${p.name} from GoMo Candles — handcrafted in Kolkata.`,
    price: p.price > 0 ? p.price : null, mrp: p.mrp > p.price ? p.mrp : null, label: p.category || 'GoMo Candles',
    images: [imgOf(p)].filter(Boolean), transparent: !!p.images?.[0]?.transparent, inStock: p.in_stock !== false,
  })),
  ...cat.offers.map((o) => ({
    kind: 'combo', path: `/combo/${slug(o.name) || o.id}`, slug: slug(o.name) || o.id, name: o.name,
    desc: o.description || o.contents || o.name, price: o.price, mrp: o.compare_at > o.price ? o.compare_at : null,
    label: o.badge || (o.type === 'pack' ? 'Pack' : 'Combo'),
    images: o.images?.[0]?.web ? [media(o.images[0].web)] : o.items.map((i) => imgOf(byId[i.product_id])).filter(Boolean),
    transparent: o.images?.[0]?.web ? !!o.images[0].transparent : o.items.length > 1 || !!byId[o.items[0]?.product_id]?.images?.[0]?.transparent, inStock: o.in_stock !== false,
  })),
];

// ---------------------------------------------------------------- share cards (1200x630 JPEG)
const LOGO = readFileSync(join(ROOT, 'assets/brand/gomo-logo.svg'), 'utf8');
const card = (it) => {
  const multi = it.images.length > 1;
  const imgs = (multi ? it.images.slice(0, 3) : it.images.slice(0, 1)).map((u) => `<img src="${esc(u)}" class="${it.transparent || multi ? 'cut' : 'full'}" data-check-light>`).join('');
  const save = it.mrp && it.price ? Math.round(it.mrp - it.price) : 0;
  return `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=DM+Sans:wght@500;700&display=swap" rel="stylesheet"><style>
  *{margin:0;padding:0;box-sizing:border-box}body{width:1200px;height:630px;overflow:hidden;font-family:'DM Sans',sans-serif;color:#1d1915;
  background:radial-gradient(ellipse at 72% 55%,rgba(222,150,84,.42),rgba(222,150,84,0) 55%),linear-gradient(160deg,#fbf4ec 0%,#f3e5d5 55%,#ead6c1 100%)}
  .l{position:absolute;left:70px;top:64px;width:540px}.logo{height:58px;width:auto;display:block;margin-bottom:34px}.logo path{fill:#141110}
  .tag{display:inline-block;font-weight:700;font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:#9c5530;margin-bottom:18px}
  h1{font-family:Oswald,sans-serif;font-weight:700;text-transform:uppercase;font-size:${it.name.length > 26 ? 54 : 72}px;line-height:1.02}.l{bottom:96px}
  .price{display:flex;align-items:baseline;gap:18px;margin-top:28px}.price b{font-family:Oswald,sans-serif;font-size:64px}.price s{font-size:30px;color:#8a7e74}
  .save{display:inline-block;margin-top:16px;background:#9c5530;color:#fff;font-weight:700;font-size:24px;border-radius:999px;padding:9px 20px}
  .url{position:absolute;left:70px;bottom:40px;font-weight:700;font-size:22px;color:#5f5147}
  .r{position:absolute;right:50px;top:40px;width:520px;height:550px;display:flex;align-items:center;justify-content:center;gap:0}
  .r img.full{width:500px;height:500px;object-fit:cover;border-radius:32px;box-shadow:0 30px 60px rgba(60,30,10,.25)}
  .r img.light{width:480px;height:480px;object-fit:contain;mix-blend-mode:multiply;border-radius:0;box-shadow:none}
  .r img.cut{max-width:${multi ? 190 : 500}px;max-height:${multi ? 360 : 520}px;object-fit:contain;filter:drop-shadow(0 26px 30px rgba(60,30,10,.28))}
  ${multi ? '.r img.cut:nth-child(2){margin:0 -20px;z-index:2;max-height:430px}' : ''}
  </style></head><body>
  <div class="l">${LOGO.replace('<svg', '<svg class="logo"')}<span class="tag">${esc(it.label)}</span><h1>${esc(it.name)}</h1>
    ${it.price ? `<div class="price"><b>${inr(it.price)}</b>${it.mrp ? `<s>${inr(it.mrp)}</s>` : ''}</div>${save > 0 ? `<span class="save">You save ${inr(save)}</span>` : ''}` : '<div class="price"><b style="font-size:44px">Made to order</b></div>'}</div>
  <div class="r">${imgs}</div><div class="url">gomo.earthenbeauty.in</div></body></html>`;
};

// Inline remote photos as data: URLs so the card page can read their pixels (white-background check) — no cross-origin taint.
const inlined = {};
async function inline(u) {
  if (!/^https?:/.test(u)) return u;
  if (!inlined[u]) { const r = await fetch(u); inlined[u] = `data:${r.headers.get('content-type') || 'image/webp'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`; }
  return inlined[u];
}
for (const it of items) it.images = await Promise.all(it.images.map(inline));

mkdirSync(join(ROOT, 'assets/og'), { recursive: true });
const b = await launch();
await b.viewport(1200, 630);
for (const it of items) {
  const file = join('/tmp', `og-${it.kind}-${it.slug}.html`);
  writeFileSync(file, card(it));
  await b.goto('file://' + file, 2500);
  await b.eval(`Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))`);
  await b.eval(`[...document.querySelectorAll('img.full[data-check-light]')].forEach((im) => { try {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 20, 20);
    const px = [[0,0],[19,0],[0,19],[19,19],[10,0],[0,10]].map(([x,y]) => g.getImageData(x, y, 1, 1).data);
    if (px.every((p) => p[0] > 235 && p[1] > 235 && p[2] > 235)) { im.classList.remove('full'); im.classList.add('light'); }
  } catch (e) {} })`);
  await b.sleep(300);
  const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } });
  writeFileSync(join(ROOT, `assets/og/${it.kind}-${it.slug}.jpg`), Buffer.from(r.data, 'base64'));
  it.card = `${SITE}/assets/og/${it.kind}-${it.slug}.jpg?v=${VER}`;
}
await b.close();

// ---------------------------------------------------------------- per-page HTML with its own <head>
const base = readFileSync(join(ROOT, 'index.html'), 'utf8');
const setMeta = (html, re, val) => html.replace(re, (m, a, _old, c) => `${a}${esc(val)}${c}`);
for (const dir of ['product', 'combo']) if (existsSync(join(ROOT, dir))) rmSync(join(ROOT, dir), { recursive: true });
for (const it of items) {
  const url = SITE + it.path;
  const title = `${it.name}${it.price ? ` — ${inr(it.price)}` : ''} · GoMo Candles`;
  const desc = String(it.desc).replace(/\s+/g, ' ').trim().slice(0, 190);
  let h = base;
  h = h.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  h = setMeta(h, /(<meta name="description" content=")([^"]*)(")/, desc);
  h = setMeta(h, /(<link rel="canonical" href=")([^"]*)(")/, url);
  h = setMeta(h, /(<meta property="og:type" content=")([^"]*)(")/, 'product');
  h = setMeta(h, /(<meta property="og:title" content=")([^"]*)(")/, title);
  h = setMeta(h, /(<meta property="og:description" content=")([^"]*)(")/, desc);
  h = setMeta(h, /(<meta property="og:url" content=")([^"]*)(")/, url);
  h = setMeta(h, /(<meta name="twitter:title" content=")([^"]*)(")/, title);
  h = setMeta(h, /(<meta name="twitter:description" content=")([^"]*)(")/, desc);
  h = setMeta(h, /(<meta name="twitter:image" content=")([^"]*)(")/, it.card);
  // Replace both og:image blocks with this item's card.
  h = h.replace(/<meta property="og:image:url"[^>]*>\n?/, '');
  h = h.replace(/(\s*<meta property="og:image" content="[^"]*" \/>\n(?:\s*<meta property="og:image:[a-z_]+" content="[^"]*" \/>\n)*)+/,
    `\n  <meta property="og:image" content="${esc(it.card)}" />\n  <meta property="og:image:secure_url" content="${esc(it.card)}" />\n  <meta property="og:image:type" content="image/jpeg" />\n  <meta property="og:image:width" content="1200" />\n  <meta property="og:image:height" content="630" />\n  <meta property="og:image:alt" content="${esc(it.name)}" />\n`);
  h = h.replace(/(<meta name="twitter:image:alt" content=")([^"]*)(")/, (m, a, _o, c) => `${a}${esc(it.name)}${c}`);
  if (it.price) h = h.replace('<meta name="twitter:card"', `<meta property="product:price:amount" content="${it.price}" />\n  <meta property="product:price:currency" content="INR" />\n  <meta property="product:availability" content="${it.inStock ? 'in stock' : 'out of stock'}" />\n  <meta name="twitter:card"`);
  // Relative asset links must keep working from /product/<slug>/.
  if (!/<base /.test(h)) h = h.replace('<head>', '<head>\n  <base href="/" />');
  const out = join(ROOT, it.path.slice(1) + '.html'); // served as /product/<slug> (cleanUrls) — no redirect, so every crawler sees it
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, h);
}
console.log(`share pages: ${items.length} (${items.map((i) => i.path).join(', ')})`);
