// Builds the GoMo social-media image set (link previews, posts, stories, covers, profile picture) in headless Chrome.
//   node tools/build_social.mjs           -> assets/social/*.jpg|png  (+ assets/brand/og-image.jpg kept in sync)
// Inputs: assets/brand/gomo-logo.svg (owner's logo, vector) and assets/img/combo-trio-1200.webp (3 products, transparent,
// trimmed from assets/images/3_combo.png by tools/build_images.py).
import { launch } from './cdp.mjs';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/social');
mkdirSync(OUT, { recursive: true });

const LOGO = readFileSync(join(ROOT, 'assets/brand/gomo-logo.svg'), 'utf8');
const VB = LOGO.match(/viewBox="([^"]+)"/)[1];
const PATH = LOGO.match(/ d="([^"]+)"/)[1];
const logo = (h, fill = '#141110') => `<svg class="logo" viewBox="${VB}" style="height:${h}px"><path fill="${fill}" fill-rule="evenodd" d="${PATH}"/></svg>`;
const PRODUCTS = 'file://' + join(ROOT, 'assets/img/combo-trio-1200.webp');

const COPY = {
  line1: 'More than a candle.',
  line2: 'A moment of peace.',
  sub: 'Evil Eye Candle · Sachets · Linen Mist',
  offer: 'Combo of 3 · ₹799',
  cod: 'Cash on Delivery',
  url: 'gomo.earthenbeauty.in',
  tagline: 'More Than a Candle',
};

// Every size, with the platforms it is meant for. `safe` = area guaranteed visible after the platform crops/overlays.
const SIZES = [
  { file: 'og-1200x630.jpg', w: 1200, h: 630, layout: 'wide', use: 'Link preview: Facebook, WhatsApp, LinkedIn, Telegram, Discord, Slack, iMessage (og:image)' },
  { file: 'og-square-1200x1200.jpg', w: 1200, h: 1200, layout: 'square', use: 'Square link preview (second og:image; WhatsApp/iMessage small cards)' },
  { file: 'twitter-1200x628.jpg', w: 1200, h: 628, layout: 'wide', use: 'X / Twitter large card (twitter:image)' },
  { file: 'instagram-post-1080x1080.jpg', w: 1080, h: 1080, layout: 'square', use: 'Instagram / Facebook / LinkedIn square post' },
  { file: 'instagram-portrait-1080x1350.jpg', w: 1080, h: 1350, layout: 'tall', use: 'Instagram / Facebook 4:5 feed post' },
  { file: 'story-1080x1920.jpg', w: 1080, h: 1920, layout: 'tall', safeTop: 250, safeBottom: 340, use: 'Instagram & Facebook Story, WhatsApp Status, Reels / Shorts cover, Snapchat' },
  { file: 'pinterest-1000x1500.jpg', w: 1000, h: 1500, layout: 'tall', use: 'Pinterest pin (2:3)' },
  { file: 'x-post-1600x900.jpg', w: 1600, h: 900, layout: 'wide', use: 'X / LinkedIn / Facebook 16:9 in-feed image' },
  { file: 'youtube-thumbnail-1280x720.jpg', w: 1280, h: 720, layout: 'wide', use: 'YouTube video thumbnail' },
  { file: 'facebook-cover-1640x624.jpg', w: 1640, h: 624, layout: 'banner', safe: { w: 1180, h: 560 }, use: 'Facebook Page cover (mobile crops the sides)' },
  { file: 'x-header-1500x500.jpg', w: 1500, h: 500, layout: 'banner', safe: { w: 1500, h: 400 }, align: 'right', use: 'X / Twitter header (profile photo covers bottom-left)' },
  { file: 'linkedin-banner-1584x396.jpg', w: 1584, h: 396, layout: 'banner', safe: { w: 1584, h: 396 }, align: 'right', use: 'LinkedIn page banner (logo covers the left)' },
  { file: 'youtube-banner-2560x1440.jpg', w: 2560, h: 1440, layout: 'banner', safe: { w: 1546, h: 423 }, use: 'YouTube channel banner (text inside the 1546x423 centre)' },
  { file: 'profile-1080x1080.png', w: 1080, h: 1080, layout: 'avatar', use: 'Profile picture on every platform (safe for circle crops)' },
];

const BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:#f4e9dc}
  .c{position:relative;overflow:hidden;font-family:'DM Sans',sans-serif;color:#1d1915;
    background:radial-gradient(ellipse at var(--gx,72%) var(--gy,58%),rgba(222,150,84,.42),rgba(222,150,84,0) 55%),
               linear-gradient(160deg,#fbf4ec 0%,#f3e5d5 55%,#ead6c1 100%)}
  .c::after{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 120%,rgba(156,85,48,.18),transparent 60%)}
  .logo{display:block;width:auto}
  h1{font-family:Oswald,sans-serif;font-weight:700;text-transform:uppercase;line-height:1.02;letter-spacing:.005em}
  h1 em{font-style:normal;color:#9c5530;display:block}
  .sub{color:#5f5147;font-weight:500}
  .pills{display:flex;flex-wrap:wrap;gap:.5em}
  .pill{display:inline-flex;align-items:center;font-weight:700;border-radius:999px;padding:.55em 1.05em;white-space:nowrap}
  .pill.offer{background:#9c5530;color:#fff}
  .pill.cod{background:#fff;color:#1d1915;box-shadow:inset 0 0 0 2px rgba(29,25,21,.12)}
  .url{font-weight:600;color:#6d5f55;letter-spacing:.02em}
  .prod{position:absolute;background:url('${PRODUCTS}') center/contain no-repeat;filter:drop-shadow(0 30px 34px rgba(70,35,12,.32))}
  .floor{position:absolute;border-radius:50%;background:radial-gradient(ellipse,rgba(70,35,12,.28),transparent 70%)}
  .tag{color:#6d5f55;font-weight:600;letter-spacing:.04em;border-left:2px solid rgba(29,25,21,.18)}
`;
const px = (n) => `${Math.round(n)}px`;

function html(s) {
  const { w, h } = s;
  const m = Math.min(w, h);
  let css = '', body = '';
  const pills = (fs) => `<div class="pills" style="font-size:${px(fs)}"><span class="pill offer">${COPY.offer}</span><span class="pill cod">${COPY.cod}</span></div>`;
  const headline = (fs) => `<h1 style="font-size:${px(fs)}">${COPY.line1}<em>${COPY.line2}</em></h1>`;

  if (s.layout === 'wide') {
    // copy left, products right (16:9 and 1.91:1)
    const pad = h * 0.1, colW = w * 0.47;
    css = `.copy{position:absolute;left:${px(pad)};top:${px(pad)};bottom:${px(pad)};width:${px(colW)};display:flex;flex-direction:column}
      .c{--gx:74%;--gy:52%}`;
    body = `<div class="copy">${logo(h * 0.15)}
        <div style="margin-top:auto">${headline(h * 0.094)}
        <p class="sub" style="font-size:${px(h * 0.034)};margin:${px(h * 0.03)} 0 ${px(h * 0.04)}">${COPY.sub}</p>
        ${pills(h * 0.03)}
        <p class="url" style="font-size:${px(h * 0.027)};margin-top:${px(h * 0.04)}">${COPY.url}</p></div></div>
      <div class="floor" style="left:${px(w * 0.55)};width:${px(w * 0.4)};bottom:${px(h * 0.06)};height:${px(h * 0.09)}"></div>
      <div class="prod" style="left:${px(w * 0.5)};right:${px(w * 0.02)};top:${px(h * 0.05)};bottom:${px(h * 0.04)}"></div>`;
  } else if (s.layout === 'square') {
    const pad = m * 0.075;
    css = `.c{--gx:58%;--gy:66%}`;
    body = `<div style="position:absolute;left:${px(pad)};top:${px(pad)};right:${px(pad)};display:flex;align-items:flex-start;justify-content:space-between">
        ${logo(m * 0.12)}<p class="url" style="font-size:${px(m * 0.024)};margin-top:${px(m * 0.01)}">${COPY.url}</p></div>
      <div style="position:absolute;left:${px(pad)};top:${px(m * 0.22)}">${headline(m * 0.066)}</div>
      <div class="floor" style="left:${px(m * 0.2)};width:${px(m * 0.7)};bottom:${px(m * 0.15)};height:${px(m * 0.07)}"></div>
      <div class="prod" style="left:${px(m * 0.1)};right:${px(m * 0.04)};top:${px(m * 0.36)};bottom:${px(m * 0.13)}"></div>
      <div style="position:absolute;left:${px(pad)};bottom:${px(pad * 0.85)}">${pills(m * 0.03)}</div>`;
  } else if (s.layout === 'tall') {
    // centred stack: logo + headline on top, products fill the middle, offer at the bottom.
    // Story keeps clear of the platform UI (progress bar / reply box) at top and bottom.
    const top = s.safeTop || h * 0.06, bottom = s.safeBottom || h * 0.06;
    const logoH = Math.min(w * 0.15, h * 0.09), gap = w * 0.05, fs = w * 0.08;
    const subFs = w * 0.034, pillFs = w * 0.034, urlFs = w * 0.03;
    const topEnd = top + logoH + gap + fs * 2 * 1.04;
    const bottomStart = bottom + subFs * 1.4 + w * 0.04 + pillFs * 2.2 + w * 0.035 + urlFs * 1.4;
    const room = h - topEnd - bottomStart;
    const ph = Math.min(room * 0.9, (w * 0.94) / 1.083);   // combo cut-out is 1200x1108
    const pTop = topEnd + (room - ph) / 2;
    css = `.c{--gx:50%;--gy:${Math.round(((pTop + ph * 0.6) / h) * 100)}%} .stack{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;text-align:center}`;
    body = `<div class="stack" style="top:${px(top)}">${logo(logoH)}
        <div style="margin-top:${px(gap)}">${headline(fs)}</div></div>
      <div class="floor" style="left:${px(w * 0.2)};right:${px(w * 0.2)};top:${px(pTop + ph * 0.9)};height:${px(w * 0.07)}"></div>
      <div class="prod" style="left:${px(w * 0.03)};right:${px(w * 0.03)};top:${px(pTop)};height:${px(ph)}"></div>
      <div class="stack" style="bottom:${px(bottom)}"><p class="sub" style="font-size:${px(subFs)};margin-bottom:${px(w * 0.04)}">${COPY.sub}</p>
        <div style="display:flex;justify-content:center">${pills(pillFs)}</div>
        <p class="url" style="font-size:${px(urlFs)};margin-top:${px(w * 0.035)}">${COPY.url}</p></div>`;
  } else if (s.layout === 'banner') {
    // everything inside the safe box: logo + tagline + offer | products
    const sw = s.safe.w, sh = s.safe.h;
    const left = s.align === 'right' ? w - sw + sw * 0.34 : (w - sw) / 2, top = (h - sh) / 2;
    const bw = s.align === 'right' ? sw * 0.66 : sw;
    css = `.c{--gx:${s.align === 'right' ? 82 : 66}%;--gy:55%}`;
    body = `<div style="position:absolute;left:${px(left)};top:${px(top)};width:${px(bw)};height:${px(sh)};display:flex;align-items:center;gap:${px(sh * 0.12)}">
        <div style="display:flex;flex-direction:column;gap:${px(sh * 0.07)};flex:none">
          <div style="display:flex;align-items:center;gap:${px(sh * 0.07)}">${logo(sh * 0.36)}<span class="tag" style="font-size:${px(sh * 0.065)};padding-left:${px(sh * 0.07)};line-height:1.3">More Than<br>a Candle</span></div>
          ${pills(sh * 0.058)}
          <p class="url" style="font-size:${px(sh * 0.055)}">${COPY.url}</p>
        </div>
        <div style="position:relative;flex:1;height:100%"><div class="prod" style="inset:2% 0 2% 0"></div></div>
      </div>`;
  } else if (s.layout === 'avatar') {
    // logo only, inside the circle-safe zone (~64% of the width)
    body = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${logo(m * 0.56)}</div>`;
    css = `.c{background:#f4e9dc}.c::after{display:none}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=DM+Sans:wght@500;600;700&display=block">
    <style>${BASE_CSS} .c{width:${w}px;height:${h}px} ${css}</style></head>
    <body><div class="c">${body}</div></body></html>`;
}

const b = await launch();
const report = [];
try {
  for (const s of SIZES) {
    await b.viewport(s.w, s.h);
    const tmp = `/tmp/gomo-social-${s.file}.html`;
    writeFileSync(tmp, html(s));
    await b.goto('file://' + tmp, 2500);
    await b.eval('document.fonts.ready.then(() => true)');
    const png = s.file.endsWith('.png');
    const r = await b.send('Page.captureScreenshot', { format: png ? 'png' : 'jpeg', quality: png ? undefined : 86, clip: { x: 0, y: 0, width: s.w, height: s.h, scale: 1 } });
    writeFileSync(join(OUT, s.file), Buffer.from(r.data, 'base64'));
    const kb = Math.round(statSync(join(OUT, s.file)).size / 1024);
    report.push(`${s.file.padEnd(36)} ${String(kb).padStart(4)} KB  ${s.use}`);
    console.log(report.at(-1));
  }
} finally {
  await b.close();
}
// keep the old URL (already cached by some apps) pointing at the new design
copyFileSync(join(OUT, 'og-1200x630.jpg'), join(ROOT, 'assets/brand/og-image.jpg'));
writeFileSync(join(OUT, 'README.txt'), 'GoMo social media images — made by tools/build_social.mjs\n\n' + report.join('\n') + '\n');
