// Builds sitemap.xml from the live catalog (products + offers) and the static pages.
//   node tools/build_sitemap.mjs        (run after adding or renaming products/offers, then deploy hosting)
import { writeFileSync } from 'node:fs';
const SITE = 'https://gomo.earthenbeauty.in';
const API = 'https://gomo-api.soumalya9862.workers.dev';
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const cat = await (await fetch(`${API}/api/catalog`)).json();
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const urls = [
  ['/', '1.0', 'weekly'], ['/shop', '0.9', 'weekly'],
  ...cat.products.map((p) => [`/product/${slug(p.name) || p.id}`, '0.8', 'weekly']),
  ...cat.offers.map((o) => [`/combo/${slug(o.name) || o.id}`, '0.8', 'weekly']),
  ['/shipping-policy', '0.3', 'yearly'], ['/returns-policy', '0.3', 'yearly'], ['/privacy-policy', '0.3', 'yearly'], ['/terms', '0.3', 'yearly'],
];
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, pr, cf]) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod><changefreq>${cf}</changefreq><priority>${pr}</priority></url>`).join('\n')}
</urlset>
`;
writeFileSync(new URL('../sitemap.xml', import.meta.url), xml);
console.log(`sitemap.xml: ${urls.length} URLs`);
