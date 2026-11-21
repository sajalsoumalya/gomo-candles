/* GoMo Candles — storefront logic: live catalog, cart, checkout, payments, tracking, page interactions. */
(function () {
  'use strict';

  var CFG = window.GOMO_CONFIG || {};
  var API = String(CFG.API_BASE || '').replace(/\/+$/, '');
  var CART_KEY = 'gomo_cart_v1';
  var CATALOG_KEY = 'gomo_catalog_v1';   // last catalog from the API (prices are set in the admin panel)
  var DETAILS_KEY = 'gomo_details_v1';
  var LAST_ORDER_KEY = 'gomo_last_order_v1';

  var STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
    'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
    'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
    'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];

  var STATUS_FLOW = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
  var STATUS_LABELS = { placed: 'Order placed', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };

  var ART = { candle: '#i-candle', sachet: '#i-sachet', spray: '#i-spray', gift: '#i-gift' };
  var PACK_ART = { candle: '#i-candle3', sachet: '#i-sachet3', spray: '#i-spray3', gift: '#i-gift' };
  var VIS_BG = { candle: '', sachet: '#e9f0ec', spray: '#f6eedd', gift: '#f1e6da' };
  var ARROW = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var X_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-9.2-9.3C1.6 7.3 3.9 4 7.3 4c2 0 3.6 1.1 4.7 2.7C13.1 5.1 14.7 4 16.7 4c3.4 0 5.7 3.3 4.5 6.7C19.5 15.4 12 20 12 20z"/></svg>';

  // ------------------------------------------------------------------ fallback catalog (mirrors the live catalog)
  function buildFallback() {
    var GST = { label: 'GST', value: '5% included in the price' };
    var products = [
      { id: 'candle', name: 'Evil Eye Candle', category: 'Scented Candle', tag: 'Bestseller', price: 449, mrp: 999, art: 'candle', in_stock: true, orderable: true,
        chips: ['Long Burn Time', 'Calming Scent', 'Nazar Protection'],
        details: [{ label: 'Expiry', value: '1 year' }, { label: 'Storage', value: 'Keep away from heat or direct sunlight' }, GST],
        description: 'Our signature scented candle — crafted to fill your room with calming fragrance while the iconic Evil Eye design wards off negative energy. Perfect for evenings, meditation or unwinding.' },
      { id: 'sachet', name: 'Evil Eye Sachets', category: 'Fragrance Sachet', tag: 'Room Freshener', price: 199, mrp: 499, art: 'sachet', in_stock: true, orderable: true,
        chips: ['30-Day Fragrance', 'No Flame', 'Portable'],
        details: [{ label: 'Expiry', value: '1 year' }, { label: 'Storage', value: 'Not to be kept in an open area. No heat or direct sunlight' }, GST],
        description: 'A subtle, long-lasting room freshener sachet blending aromatherapy with the protective charm of the Evil Eye. Hang in your wardrobe, car or any corner that deserves a little peace.' },
      { id: 'spray', name: 'Linen Mist', category: 'Pillow & Linen Mist', tag: 'Sleep Aid', price: 299, mrp: 599, art: 'spray', in_stock: true, orderable: true,
        chips: ['Sleep Enhancing', 'Non-Staining', 'Calming Blend'],
        details: [{ label: 'Quantity', value: '100 ml' }, GST],
        description: 'A calming pillow and linen mist designed to ease your transition into sleep. Two sprays on your pillow — close your eyes and let the soothing fragrance guide you to peaceful rest.' },
      { id: 'gift', name: 'Gift Sets', category: 'Curated Bundle', tag: 'Gifting', price: 0, art: 'gift', in_stock: true, orderable: false,
        chips: ['Mix & Match', 'Gift Ready', 'Personal Touch'], details: [],
        description: 'Combine the Evil Eye Candle, Sachets and Linen Mist into a thoughtful gift of calm and protection — put together with you personally for birthdays, housewarmings and festivals.' }
    ];
    var by = {};
    products.forEach(function (p) { by[p.id] = p; });
    function offer(id, type, name, description, badge, price, items) {
      var full = items.map(function (it) { return { product_id: it[0], qty: it[1], name: by[it[0]].name, art: by[it[0]].art, unit_price: by[it[0]].price }; });
      var compare = full.reduce(function (s, it) { return s + it.unit_price * it.qty; }, 0);
      return { id: id, type: type, name: name, description: description, badge: badge, price: price, compare_at: compare,
        savings: Math.max(0, compare - price), contents: full.map(function (i) { return i.qty + ' × ' + i.name; }).join(', '), items: full, in_stock: true };
    }
    return {
      store: { name: 'GoMo Candles', whatsapp: '', email: 'support@earthenbeauty.in' },
      shipping: { free_above: 999, include_equal: false, fee: 0 },
      payments: { cod: true, razorpay: false, razorpay_key_id: null },
      products: products,
      offers: [
        offer('combo-trio', 'combo', 'The Complete GoMo Ritual', 'One of each — light, freshen and mist your way to calmer evenings.', 'Combo of 3', 799, [['candle', 1], ['sachet', 1], ['spray', 1]]),
        offer('pack-sachet-3', 'pack', 'Evil Eye Sachets — 3 pc combo', 'Wardrobe, car and desk — a sachet for each.', '3 pc combo', 499, [['sachet', 3]])
      ]
    };
  }

  var catalog = savedCatalog() || buildFallback();
  var live = false;            // true once the API catalog has loaded
  var catalogFailed = false;   // API unreachable: keep using the built-in catalog
  var prodById = {}, offerById = {};

  // ------------------------------------------------------------------ helpers
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inr(n) { return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'); }
  function savedCatalog() {
    var c = store(CATALOG_KEY);
    return c && c.saved_at > Date.now() - 30 * 864e5 && c.store && Array.isArray(c.products) && Array.isArray(c.offers) ? c : null;
  }
  // until the admin's prices are known (no saved catalog yet), price areas are hidden by the html.catalog-pending class
  var catalogReadyResolve, catalogReadyP = new Promise(function (r) { catalogReadyResolve = r; });
  function catalogSettled() { document.documentElement.classList.remove('catalog-pending'); hideLoader(); if (catalogReadyResolve) catalogReadyResolve(); }
  // Branded page loader (#pageLoader in index.html): hidden once the first view is drawn. The account page waits for sign-in.
  function hideLoader(force) {
    if (!force && ROUTE.view === 'account') return;
    var l = document.getElementById('pageLoader');
    if (l && !l.classList.contains('done')) l.classList.add('done');
  }
  function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null'); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()) + Math.random().toString(36).slice(2, 12); }
  // "Contact us" link: WhatsApp once a real number is set in the admin (Settings → Store), otherwise email.
  function hasWhatsApp() { var n = String(catalog.store.whatsapp || '').replace(/\D/g, ''); return n.length >= 10 && !/^(91)?9{10}$/.test(n); }
  function waLink(text) {
    if (hasWhatsApp()) return 'https://wa.me/' + String(catalog.store.whatsapp).replace(/\D/g, '') + '?text=' + encodeURIComponent(text);
    return 'mailto:' + (catalog.store.email || 'support@earthenbeauty.in') + '?subject=' + encodeURIComponent(catalog.store.name + ' enquiry') + '&body=' + encodeURIComponent(text);
  }
  function normPhone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    else if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : '';
  }
  // Mobile boxes sit after a fixed "+91", so tidy what autofill or paste puts in: "09062656165", "+91 90626 56165",
  // "919062656165" all become "9062656165". Indian mobiles never start with 0, so leading zeros always go;
  // "91" is only dropped when the whole number is pasted (12+ digits or a "+"), so a number like 91234 56789 still types fine.
  function tidyMobile(raw) {
    var s = String(raw || '');
    var d = s.replace(/\D/g, '');
    if ((/^\s*\+/.test(s) || d.length >= 12) && d.indexOf('91') === 0) d = d.slice(2);
    d = d.replace(/^0+/, '');
    return d.slice(0, 10);
  }
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || el.type !== 'tel' || !el.closest || !el.closest('.prefix')) return;
    var clean = tidyMobile(el.value);
    if (clean !== el.value) el.value = clean;
  }, true);
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return iso; }
  }

  function api(path, opts) {
    opts = opts || {};
    var auth = window.GomoAuth;
    var tokenP = auth && auth.user ? auth.getToken().catch(function () { return null; }) : Promise.resolve(null);
    return tokenP.then(function (token) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 15000) : null;
      var headers = {};
      if (opts.body) headers['content-type'] = 'application/json';
      if (token) headers.authorization = 'Bearer ' + token;
      return fetch(API + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) { var err = new Error(data.error || 'Something went wrong.'); err.status = res.status; err.data = data; throw err; }
          return data;
        });
      }, function () {
        var err = new Error('Could not reach our server. Check your connection and try again.');
        err.status = 0;
        throw err;
      }).finally(function () { if (timer) clearTimeout(timer); });
    });
  }

  function indexCatalog() {
    prodById = {}; offerById = {};
    catalog.products.forEach(function (p) {
      if (!hasPhoto(p) && PHOTOS[p.id]) p.images = PHOTOS[p.id];
      prodById[p.id] = p;
    });
    catalog.offers.forEach(function (o) {
      o.items.forEach(function (it) {
        var p = prodById[it.product_id];
        if (!(it.image && it.image.web) && hasPhoto(p)) it.image = p.images[0];
      });
      offerById[o.id] = o;
    });
  }

  // ------------------------------------------------------------------ artwork
  // Built-in product photos (assets/img, made by tools/build_images.py). Photos uploaded in the admin replace these.
  var IMG = 'assets/img/';
  function stock(name, alt, w, h, studio, sq) {
    var big = studio ? '-1400' : '-1600', small = studio ? '-700' : '-800';
    return { id: 'stock-' + name, alt: alt, w: w, h: h, web: IMG + name + big + '.webp', thumb: IMG + name + small + '.webp',
      sq: sq ? IMG + sq + '-480.webp' : null, sq_small: sq ? IMG + sq + '-160.webp' : null, studio: !!studio };
  }
  var PHOTOS = {
    candle: [stock('candle', 'Evil Eye Candle in a wooden bowl with two lit wicks', 1320, 1129, true, 'candle-sq'),
      stock('candle-desk', 'Evil Eye Candle glowing on a study desk at night', 1600, 1378)],
    sachet: [stock('sachet', 'Evil Eye charm with a yellow ribbon', 1400, 1197, true, 'sachet-sq'),
      stock('sachet-wardrobe', 'Evil Eye charm hanging in a wardrobe', 1600, 1378)],
    spray: [stock('mist', 'Dutch Lavender linen mist, 100 ml', 1400, 1196, true, 'mist-sq'),
      stock('mist-bed', 'Spraying the lavender linen mist over a bed', 1600, 1378)],
    gift: [stock('gift-open', 'Gift box opening with the candle, Evil Eye charm and linen mist', 1600, 1378, false, 'gift-sq'),
      stock('gift-closed', 'GoMo gift box tied with a navy ribbon', 1600, 1378, false, 'gift-sq')]
  };
  var COMBO_IMG = { web: IMG + 'combo-trio-1200.webp', thumb: IMG + 'combo-trio-480.webp', sq_small: IMG + 'combo-trio-sq-160.webp', w: 1200, h: 1108 };

  function mediaUrl(key) {
    if (/^(assets\/|https?:\/\/)/.test(String(key))) return key;
    var base = catalog.media_base ? String(catalog.media_base).replace(/\/+$/, '') : API + '/media';
    return base + '/' + String(key).split('/').map(encodeURIComponent).join('/');
  }
  function hasPhoto(p) { return !!(p && p.images && p.images.length && p.images[0].web); }
  function photoImg(img, opts) {
    opts = opts || {};
    var src = opts.square && img.sq ? (opts.tiny && img.sq_small ? img.sq_small : img.sq) : (opts.big ? img.web : img.thumb || img.web);
    var srcset = opts.big || opts.square ? '' : ' srcset="' + esc(mediaUrl(img.thumb || img.web)) + ' 700w, ' + esc(mediaUrl(img.web)) + ' 1400w" sizes="' + (opts.sizes || '(max-width:640px) 92vw, (max-width:980px) 46vw, 300px') + '"';
    var size = opts.square && img.sq ? ' width="480" height="480"' : (img.w && img.h ? ' width="' + img.w + '" height="' + img.h + '"' : '');
    return '<img class="' + (opts.cls || 'photo') + (img.studio ? ' studio' : '') + '" src="' + esc(mediaUrl(src)) + '"' + srcset + size +
      ' alt="' + esc(opts.decorative ? '' : (img.alt || opts.alt || '')) + '" loading="' + (opts.eager ? 'eager' : 'lazy') + '" decoding="async"' +
      (img.color ? ' style="background:' + esc(img.color) + '"' : '') + '>';
  }
  function isTrio(o) {
    return o.items.length === 3 && o.items.map(function (i) { return i.art; }).sort().join(',') === 'candle,sachet,spray';
  }
  function useSvg(href, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true"><use href="' + href + '"/></svg>'; }
  function productArt(p) { return hasPhoto(p) ? photoImg(p.images[0], { cls: 'thumb-photo', alt: p.name, square: true, tiny: true }) : useSvg(ART[p.art] || ART.candle); }
  function offerArt(o, small) {
    if (o.type !== 'pack' && isTrio(o)) {
      return small
        ? '<img class="thumb-photo cutout" src="' + COMBO_IMG.sq_small + '" width="160" height="160" alt="" loading="lazy">'
        : '<img class="combo-cutout" src="' + COMBO_IMG.thumb + '" srcset="' + COMBO_IMG.thumb + ' 480w, ' + COMBO_IMG.web + ' 1200w" sizes="(max-width:640px) 70vw, 340px" width="' + COMBO_IMG.w + '" height="' + COMBO_IMG.h + '" alt="' + esc(o.contents || o.name) + '" loading="lazy" decoding="async">';
    }
    var withImg = o.items.filter(function (i) { return i.image && i.image.web; });
    if (o.type === 'pack' && withImg.length) return '<div class="offer-photo">' + photoImg(withImg[0].image, { cls: 'photo', alt: o.name, square: true, tiny: small }) + '<span class="qty-badge">×' + esc(o.items[0].qty) + '</span></div>';
    if (o.type !== 'pack' && withImg.length === o.items.length && withImg.length >= 2) {
      return '<div class="offer-collage n' + Math.min(3, withImg.length) + '">' + withImg.slice(0, 3).map(function (i) { return photoImg(i.image, { cls: 'photo', alt: i.name, square: true, tiny: small }); }).join('') + '</div>';
    }
    if (o.type === 'pack') return '<svg viewBox="0 0 160 140" aria-hidden="true"><use href="' + (PACK_ART[o.items[0] && o.items[0].art] || PACK_ART.candle) + '"/></svg>';
    var arts = o.items.map(function (i) { return i.art; });
    if (arts.length === 3 && arts.slice().sort().join(',') === 'candle,sachet,spray') return '<svg viewBox="0 0 240 200" aria-hidden="true"><use href="#i-trio"/></svg>';
    var pos = arts.length === 2
      ? [[20, 40, 110, 128], [110, 50, 110, 128]]
      : [[6, 30, 110, 128], [124, 38, 108, 126], [62, 56, 116, 135]];
    var out = '<svg viewBox="0 0 240 200" aria-hidden="true"><ellipse cx="120" cy="190" rx="100" ry="8" fill="#000" opacity=".12"/>';
    o.items.slice(0, 3).forEach(function (it, i) {
      var p = pos[i] || pos[pos.length - 1];
      out += '<use href="' + (ART[it.art] || ART.candle) + '" x="' + p[0] + '" y="' + p[1] + '" width="' + p[2] + '" height="' + p[3] + '"/>';
    });
    return out + '</svg>';
  }
  function offerArtHref(o) {
    if (o.type === 'pack') return PACK_ART[o.items[0] && o.items[0].art] || PACK_ART.candle;
    return '#i-trio';
  }

  function packFor(product) {
    return catalog.offers.filter(function (o) { return o.type === 'pack' && o.items.length === 1 && o.items[0].product_id === product.id; })[0] || null;
  }
  function combos() { return catalog.offers.filter(function (o) { return o.type === 'combo'; }); }
  function packs() { return catalog.offers.filter(function (o) { return o.type === 'pack'; }); }
  function buyable(p) { return p.orderable && p.price > 0; }

  // ------------------------------------------------------------------ routes
  // Firebase rewrites every path to index.html; the path picks what is shown:
  //   /                home                  /shop          every product, combo and pack
  //   /product/<slug>  one product           /combo/<slug>  one combo or pack
  //   /shipping-policy, /returns-policy, /privacy-policy
  function slugify(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function productUrl(p) { return '/product/' + (slugify(p.name) || encodeURIComponent(p.id)); }
  function offerUrl(o) { return '/combo/' + (slugify(o.name) || encodeURIComponent(o.id)); }
  function decodeSeg(seg) { try { return decodeURIComponent(seg).toLowerCase(); } catch (e) { return String(seg).toLowerCase(); } }
  var ROUTE = (function () {
    var path = location.pathname.replace(/\/+$/, '') || '/', m;
    if (path === '/shop') return { view: 'shop' };
    if (path === '/account') return { view: 'account' };
    if ((m = /^\/product\/([^\/]+)$/.exec(path))) return { view: 'product', slug: decodeSeg(m[1]) };
    if ((m = /^\/combo\/([^\/]+)$/.exec(path))) return { view: 'offer', slug: decodeSeg(m[1]) };
    if ((m = /^\/(shipping|returns|privacy)-policy$/.exec(path))) return { view: 'policy', page: m[1] };
    if (path === '/terms') return { view: 'policy', page: 'terms' };
    return { view: 'home' };
  })();
  function routeSlug() { return ROUTE.view === 'product' ? ROUTE.slug : null; }
  function findProduct(slug) {
    return catalog.products.filter(function (p) { return slugify(p.name) === slug || String(p.id).toLowerCase() === slug; })[0] || null;
  }
  function findOffer(slug) {
    return catalog.offers.filter(function (o) { return slugify(o.name) === slug || String(o.id).toLowerCase() === slug; })[0] || null;
  }
  var PRIMARY_ORIGIN = 'https://gomo.earthenbeauty.in';
  // Structured data for Google (schema.org JSON-LD): one <script id="ldjson"> per page, replaced on each render.
  function absImg(key) { var u = mediaUrl(key); return /^https?:/.test(u) ? u : PRIMARY_ORIGIN + '/' + u.replace(/^\/+/, ''); }
  function setLd(obj) {
    var el = document.getElementById('ldjson');
    if (!obj) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('script'); el.type = 'application/ld+json'; el.id = 'ldjson'; document.head.appendChild(el); }
    el.textContent = JSON.stringify(obj);
  }
  function productLd(name, desc, path, price, inStock, images, mrp) {
    return {
      '@context': 'https://schema.org', '@type': 'Product', name: name, description: String(desc || '').slice(0, 500),
      image: images.filter(Boolean).slice(0, 4), url: PRIMARY_ORIGIN + path,
      brand: { '@type': 'Brand', name: 'GoMo Candles' },
      offers: { '@type': 'Offer', url: PRIMARY_ORIGIN + path, priceCurrency: 'INR', price: String(price),
        availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/NewCondition',
        seller: { '@type': 'Organization', name: 'GoMo Candles' } },
    };
  }

  function setMeta(title, description, path) {
    document.title = title + ' \u2014 ' + catalog.store.name;
    var md = $('meta[name="description"]'), cl = $('link[rel="canonical"]');
    if (md && description) md.setAttribute('content', String(description).slice(0, 160));
    // Always point search engines and shares at the primary domain, even when opened on the old firebase URL.
    if (cl) cl.setAttribute('href', PRIMARY_ORIGIN + path);
    var ou = $('meta[property="og:url"]'), ot = $('meta[property="og:title"]'), od = $('meta[property="og:description"]');
    if (ou) ou.setAttribute('content', PRIMARY_ORIGIN + path);
    if (ot) ot.setAttribute('content', document.title);
    if (od && description) od.setAttribute('content', String(description).slice(0, 200));
    if (location.pathname !== path) history.replaceState(null, '', path + location.search + location.hash);
  }
  function notFound(view, what) {
    if (!live && !catalogFailed) { view.innerHTML = '<section class="wrap pdp-missing"><p class="lead">Loading\u2026</p></section>'; return; }
    document.title = 'Not found \u2014 ' + catalog.store.name;
    view.innerHTML = '<section class="wrap pdp-missing"><div class="eyebrow">404</div><h1 class="h-sec">We couldn\u2019t find <em>' + what + '</em></h1>' +
      '<p class="lead">It may have been renamed or is no longer available.</p><a class="btn btn-rust" href="/shop">See all products ' + ARROW + '</a></section>';
  }
  function pctOff(p) { return p.mrp > p.price && p.price > 0 ? Math.round((1 - p.price / p.mrp) * 100) : 0; }
  function priceWithMrp(p) { return inr(p.price) + (p.mrp > p.price ? ' <s>' + inr(p.mrp) + '</s>' : ''); }

  // category tile — home "shop" row and "you may also like" on product pages
  function catTile(p, i) {
    var img = hasPhoto(p) ? p.images[0] : null;
    return '<a href="' + esc(productUrl(p)) + '" class="cat r' + (i % 4 ? ' d' + (i % 4) : '') + '">' +
      '<div class="cat-vis">' + (img ? photoImg(img, { cls: 'tile-photo', square: true, decorative: true }) : useSvg(ART[p.art] || ART.candle)) + '</div>' +
      '<div class="cat-foot"><div><b>' + esc(p.name) + '</b><small>' + (buyable(p) ? priceWithMrp(p) : 'Curated bundles') + '</small></div>' +
      '<span class="arrow-btn" aria-hidden="true">' + ARROW + '</span></div></a>';
  }

  // ------------------------------------------------------------------ offer countdown (end time set in Admin → Offers, IST)
  var IST = 'Asia/Kolkata';
  function istEnd(iso) {
    try { return new Date(iso).toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + ' IST'; } catch (e) { return ''; }
  }
  function countdownHtml(o) {
    var end = o && o.ends_at ? Date.parse(o.ends_at) : NaN;
    if (!o || o.countdown === false || !(end > Date.now())) return '';
    return '<div class="offer-cd" data-ends="' + end + '" role="timer" aria-live="off">' +
      '<span class="cd-label">Offer ends in</span>' +
      '<span class="cd-units">' + ['d', 'h', 'm', 's'].map(function (u) { return '<span class="cd-u"><b data-u="' + u + '">00</b><i>' + { d: 'days', h: 'hrs', m: 'min', s: 'sec' }[u] + '</i></span>'; }).join('') + '</span>' +
      '<small class="cd-until">Until ' + esc(istEnd(o.ends_at)) + '</small></div>';
  }
  function tickCountdowns() {
    var els = document.querySelectorAll('.offer-cd[data-ends]');
    if (!els.length) return;
    var now = Date.now(), ended = false;
    for (var i = 0; i < els.length; i++) {
      var left = Math.max(0, Number(els[i].getAttribute('data-ends')) - now);
      if (!left) { els[i].classList.add('cd-over'); els[i].querySelector('.cd-label').textContent = 'Offer ended'; ended = true; continue; }
      var s = Math.floor(left / 1000), parts = { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 };
      var bs = els[i].querySelectorAll('b[data-u]');
      for (var j = 0; j < bs.length; j++) { var u = bs[j].getAttribute('data-u'); var v = (parts[u] < 10 ? '0' : '') + parts[u]; if (bs[j].textContent !== v) bs[j].textContent = v; }
      els[i].querySelector('.cd-u b[data-u="d"]').parentNode.hidden = parts.d === 0;
    }
    // When an offer runs out, reload the catalog so the price and banner disappear (the server stops selling it at the same moment).
    if (ended && !tickCountdowns.reloading) { tickCountdowns.reloading = true; setTimeout(function () { location.reload(); }, 4000); }
  }
  setInterval(tickCountdowns, 1000);

  function comboCard(o, withId) {
    return '<article class="combo r"' + (withId ? ' id="combo"' : '') + '>' +
      '<div>' +
        '<span class="combo-badge">' + esc(o.badge || 'Combo') + (o.savings ? ' · Save ' + inr(o.savings) : '') + '</span>' +
        '<h3><a href="' + esc(offerUrl(o)) + '">' + esc(o.name) + '</a></h3>' +
        (o.description ? '<p>' + esc(o.description) + '</p>' : '') +
        countdownHtml(o) +
        '<ul>' + o.items.map(function (it) {
          var p = prodById[it.product_id];
          return '<li><div>' + esc(it.qty) + ' × ' + (p ? '<a href="' + esc(productUrl(p)) + '">' + esc(it.name) + '</a>' : esc(it.name)) + '</div><span>' + inr(it.unit_price * it.qty) + '</span></li>';
        }).join('') + '</ul>' +
        '<div class="combo-price"><b>' + inr(o.price) + '</b>' + (o.savings ? '<s>' + inr(o.compare_at) + '</s><em>You save ' + inr(o.savings) + '</em>' : '') + '</div>' +
        (o.in_stock === false
          ? '<button type="button" class="btn btn-white" disabled>Currently unavailable</button>'
          : '<button type="button" class="btn btn-white" data-add="offer:' + esc(o.id) + '">Add Combo · ' + inr(o.price) + ' ' + ARROW + '</button>') +
        '<a class="combo-more" href="' + esc(offerUrl(o)) + '">View details</a>' +
      '</div>' +
      '<div class="combo-art">' + offerArt(o) + '</div>' +
    '</article>';
  }

  var pdp = { id: null, option: 'single', img: 0 };
  var PERK_ICONS = {
    ship: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h11v10H2zM13 9h4l3 3v4h-7z"/><circle cx="6" cy="17.5" r="1.8" fill="#fff"/><circle cx="16.5" cy="17.5" r="1.8" fill="#fff"/></svg>',
    cod: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke-linecap="round"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21c-4.4 0-8-3.4-8-7.7C4 8 12 3 12 3s8 5 8 10.3C20 17.6 16.4 21 12 21z"/><path d="M12 21v-8"/></svg>'
  };

  function renderProductPage() {
    var view = $('#productView'), slug = routeSlug();
    if (!view || slug == null) return;
    var p = findProduct(slug);
    if (!p) return notFound(view, 'that product');
    if (pdp.id !== p.id) pdp = { id: p.id, option: 'single', img: 0 };
    setMeta(p.name, p.description, productUrl(p));
    if (buyable(p)) setLd(productLd(p.name, p.description, productUrl(p), p.price, p.in_stock, (hasPhoto(p) ? p.images : []).map(function (i) { return absImg(i.web); })));
    else setLd(null);

    var pack = buyable(p) ? packFor(p) : null;
    if (pdp.option === 'pack' && !pack) pdp.option = 'single';
    var sel = pdp.option === 'pack' ? pack : null;
    var imgs = hasPhoto(p) ? p.images : [];
    if (pdp.img >= imgs.length) pdp.img = 0;
    var off = pctOff(p);

    var media = imgs.length
      ? '<button type="button" class="pdp-main" data-gallery="' + esc(p.id) + '" data-gstart="' + pdp.img + '" aria-label="Enlarge photo of ' + esc(p.name) + '"' +
          (imgs[pdp.img].studio && VIS_BG[p.art] ? ' style="background:' + VIS_BG[p.art] + '"' : '') + '>' +
          photoImg(imgs[pdp.img], { cls: 'photo', alt: p.name, eager: true, sizes: '(max-width:980px) 92vw, 620px' }) +
          (p.tag ? '<span class="prod-tag">' + esc(p.tag) + '</span>' : '') +
          (off && !sel ? '<span class="pdp-off">' + off + '% off</span>' : '') +
          (sel ? '<span class="pack-x">×' + esc(sel.items[0].qty) + '</span>' : '') + '</button>' +
        (imgs.length > 1 ? '<div class="pdp-thumbs">' + imgs.map(function (img, n) {
          return '<button type="button" data-pimg="' + n + '" class="' + (n === pdp.img ? 'on' : '') + '" aria-label="Show photo ' + (n + 1) + '" aria-pressed="' + (n === pdp.img) + '">' +
            photoImg(img, { cls: 'photo', square: true, tiny: true, decorative: true }) + '</button>';
        }).join('') + '</div>' : '')
      : '<div class="pdp-main">' + useSvg(ART[p.art] || ART.candle, 'pdp-art') + '</div>';

    var price;
    if (buyable(p)) {
      var now = sel ? sel.price : p.price;
      var was = sel ? (sel.savings ? sel.compare_at : 0) : (p.mrp > p.price ? p.mrp : 0);
      price = '<div class="pdp-price"><b>' + inr(now) + '</b>' + (was ? '<s>' + (sel ? '' : 'MRP ') + inr(was) + '</s>' : '') +
        (sel ? (sel.savings ? '<em>Save ' + inr(sel.savings) + '</em>' : '') : (off ? '<em>' + off + '% off</em>' : '')) + '</div>' +
        '<p class="pdp-tax">Inclusive of all taxes' + (sel ? ' · ' + esc(sel.contents) : '') + '</p>';
    } else {
      price = '<div class="pdp-price"><b>Ask us</b></div><p class="pdp-tax">Custom bundles, put together with you personally</p>';
    }

    var opt = function (val, label, amount, note) {
      var on = pdp.option === val;
      return '<button type="button" role="radio" data-popt="' + val + '" aria-checked="' + on + '" class="' + (on ? 'on' : '') + '">' +
        '<b>' + label + '</b><span>' + amount + '</span>' + (note ? '<small>' + note + '</small>' : '') + '</button>';
    };
    var options = pack ? '<div class="pdp-options" role="radiogroup" aria-label="Choose an option">' +
      opt('single', 'Single', inr(p.price), p.mrp > p.price ? 'MRP <s>' + inr(p.mrp) + '</s>' : '') +
      opt('pack', esc(pack.badge || ('Pack of ' + pack.items[0].qty)), inr(pack.price), esc(pack.items[0].qty) + ' pcs' + (pack.savings ? ' · Save ' + inr(pack.savings) : '')) +
      '</div>' : '';

    var addKey = sel ? 'offer:' + sel.id : 'product:' + p.id;
    var fewLeft = buyable(p) && p.in_stock && p.few_left ? '<p class="few-left">🔥 Only ' + p.few_left + ' left — order soon</p>' : '';
    var actions = fewLeft + '<div class="pdp-actions' + (buyable(p) && p.in_stock ? '' : ' one') + '">' + (buyable(p)
      ? (p.in_stock
        ? '<button type="button" class="btn btn-rust" data-add="' + esc(addKey) + '">Add to cart ' + ARROW + '</button><button type="button" class="btn btn-line" data-buynow="' + esc(addKey) + '">Buy now</button>'
        : '<button type="button" class="btn btn-rust" disabled>Sold out</button>')
      : '<a class="btn btn-rust" href="' + esc(waLink("Hi! I'd like to order " + p.name + ' from ' + catalog.store.name + '. Please share options.')) + '" target="_blank" rel="noopener">' + (hasWhatsApp() ? 'Enquire on WhatsApp' : 'Email us to build yours') + ' ' + ARROW + '</a>') +
      '</div>';

    var rows = [];
    if (p.mrp > 0) rows.push(['MRP', inr(p.mrp)]);
    if (buyable(p)) rows.push(['Selling price', inr(p.price) + ' (incl. of all taxes)']);
    if (pack) rows.push([pack.badge || ('Pack of ' + pack.items[0].qty), inr(pack.price) + ' for ' + pack.items[0].qty + ' pcs']);
    (p.details || []).forEach(function (d) { rows.push([d.label, d.value]); });
    var specs = rows.length ? '<div class="pdp-specs"><h2>Product details</h2><dl>' +
      rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl></div>' : '';

    var perks = '<ul class="pdp-perks">' +
      '<li><span class="perk-ic">' + PERK_ICONS.ship + '</span>' + esc(shipNote()) + '</li>' +
      (catalog.payments && catalog.payments.cod ? '<li><span class="perk-ic">' + PERK_ICONS.cod + '</span>Cash on Delivery</li>' : '') +
      '<li><span class="perk-ic">' + PERK_ICONS.hand + '</span>Handcrafted in Kolkata</li></ul>';

    var combo = combos().filter(function (c) { return c.items.some(function (it) { return it.product_id === p.id; }); })[0] || combos()[0];
    var others = catalog.products.filter(function (q) { return q.id !== p.id; });

    view.innerHTML =
      '<section class="wrap pdp">' +
        '<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/shop">Shop</a><span aria-hidden="true">/</span><span aria-current="page">' + esc(p.name) + '</span></nav>' +
        '<div class="pdp-grid">' +
          '<div class="pdp-media">' + media + '</div>' +
          '<div class="pdp-info">' +
            '<span class="prod-cat">' + esc(p.category) + '</span>' +
            '<h1>' + esc(p.name) + '</h1>' +
            price + options + actions +
            '<p class="pdp-desc">' + esc(p.description) + '</p>' +
            (p.chips && p.chips.length ? '<div class="chips">' + p.chips.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>' : '') +
            perks + specs +
          '</div>' +
        '</div>' +
      '</section>' +
      (combo ? '<section class="wrap pdp-combo"><div class="eyebrow">Better together</div>' + comboCard(combo, false) + '</section>' : '') +
      (others.length ? '<section class="wrap sec pdp-related"><div class="sec-head"><div><div class="eyebrow">You may also like</div><h2 class="h-sec">More ways to find <em>your calm</em></h2></div></div>' +
        '<div class="cats">' + others.map(catTile).join('') + '</div></section>' : '');
  }

  // ------------------------------------------------------------------ shop page (/shop) and combo pages (/combo/<slug>)
  function offerMrp(o) {
    var total = 0, all = o.items.length > 0;
    o.items.forEach(function (it) {
      var p = prodById[it.product_id];
      if (p && p.mrp > 0) total += p.mrp * it.qty; else all = false;
    });
    return all ? total : 0;
  }
  function offerKind(o) { return o.type === 'pack' ? 'Value pack' : 'Combo'; }
  function shopCard(c) {
    return '<article class="prod r">' +
      '<a class="prod-vis has-photo' + (c.cls ? ' ' + c.cls : '') + '" href="' + esc(c.href) + '" tabindex="-1" aria-hidden="true"' + (c.bg ? ' style="background:' + c.bg + '"' : '') + '>' +
        c.art + (c.tag ? '<span class="prod-tag">' + esc(c.tag) + '</span>' : '') + (c.off ? '<span class="pdp-off">' + c.off + '% off</span>' : '') + '</a>' +
      '<div class="prod-body"><span class="prod-cat">' + esc(c.cat) + '</span>' +
        '<h3><a href="' + esc(c.href) + '">' + esc(c.name) + '</a></h3>' +
        '<p>' + esc(c.desc) + '</p>' +
        '<div class="prod-foot"><div class="price">' + c.price + '</div>' + c.action + '</div>' +
      '</div></article>';
  }
  function productCard(p) {
    var img = hasPhoto(p) ? p.images[0] : null, off = pctOff(p);
    return shopCard({
      href: productUrl(p), name: p.name, cat: p.category, tag: p.tag, desc: p.description, off: off,
      bg: img && img.studio && VIS_BG[p.art] ? VIS_BG[p.art] : '',
      art: img ? photoImg(img, { cls: 'photo', alt: p.name, sizes: '(max-width:640px) 92vw, 300px' }) : useSvg(ART[p.art] || ART.candle),
      price: buyable(p) ? inr(p.price) + (p.mrp > p.price ? '<s>' + inr(p.mrp) + '</s>' : '') + (p.in_stock && p.few_left ? '<small class="few-left">Only ' + p.few_left + ' left</small>' : '<small>Inclusive of all taxes</small>') : 'Ask us<small>Made to order</small>',
      action: !buyable(p)
        ? '<a class="buy" href="' + esc(productUrl(p)) + '">Details ' + ARROW + '</a>'
        : (p.in_stock ? '<button type="button" class="buy" data-add="product:' + esc(p.id) + '">Add ' + ARROW + '</button>' : '<button type="button" class="buy" disabled>Sold out</button>')
    });
  }
  function offerCard(o) {
    var mrp = offerMrp(o);
    return shopCard({
      href: offerUrl(o), name: o.name, cat: offerKind(o), tag: o.badge, cls: o.type === 'pack' ? '' : 'is-combo',
      desc: o.description || o.contents || o.items.map(function (it) { return it.qty + ' × ' + it.name; }).join(' + '),
      art: offerArt(o),
      price: inr(o.price) + (o.savings ? '<s>' + inr(o.compare_at) + '</s>' : '') + '<small>' + (o.savings ? 'You save ' + inr(o.savings) : (mrp > o.price ? 'MRP ' + inr(mrp) : 'Inclusive of all taxes')) + '</small>',
      action: o.in_stock === false ? '<button type="button" class="buy" disabled>Unavailable</button>' : '<button type="button" class="buy" data-add="offer:' + esc(o.id) + '">Add ' + ARROW + '</button>'
    });
  }

  // Small banner after the products: bulk orders and custom gift boxes go to WhatsApp (or email if no number is set).
  var WA_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.8-1.3.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>';
  function bulkBanner() {
    var wa = hasWhatsApp();
    var href = waLink('Hi GoMo! I would like to ask about a bulk order / a custom gift box.');
    return '<aside class="bulk-banner r">' +
      '<div class="bulk-ic" aria-hidden="true">' + useSvg(ART.gift) + '</div>' +
      '<div class="bulk-txt"><b>Bulk orders &amp; custom gift boxes</b>' +
        '<span>Weddings, festivals, corporate gifting or return favours — we\u2019ll put together a box for any occasion.</span></div>' +
      '<a class="btn bulk-btn" href="' + esc(href) + '" target="_blank" rel="noopener">' + (wa ? WA_SVG + ' Chat on WhatsApp' : 'Email us') + '</a>' +
    '</aside>';
  }

  function renderShopPage() {
    var view = $('#shopView');
    if (!view || ROUTE.view !== 'shop') return;
    setMeta('Shop', 'Shop GoMo Candles: the Evil Eye Candle, Evil Eye Sachets, Linen Mist and money-saving combos. Handcrafted in Kolkata with natural fragrances.', '/shop');
    // Banner: the first combo, full width. Products: only ones that can be bought (hides "Gift Sets" at ₹0).
    var banner = combos()[0] || null;
    var items = catalog.products.filter(buyable).slice(0, 3);
    view.innerHTML =
      '<section class="wrap shop-page">' +
        '<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><span aria-current="page">Shop</span></nav>' +
        '<div class="shop-head">' +
          '<div><h1>Shop <em>GoMo</em></h1><p>Handcrafted in Kolkata with natural fragrances.</p></div>' +
          '<ul class="shop-perks">' +
            '<li>' + PERK_ICONS.ship + esc(shipNote()) + '</li>' +
            (catalog.payments && catalog.payments.cod ? '<li>' + PERK_ICONS.cod + 'Cash on Delivery</li>' : '') +
            '<li>' + PERK_ICONS.hand + 'Handmade</li>' +
          '</ul></div>' +
        (banner ? '<div class="shop-banner">' + comboCard(banner, false) + '</div>' : '') +
        '<h2 class="shop-sub" id="products-list">Products <small>' + items.length + (items.length === 1 ? ' product' : ' products') + '</small></h2>' +
        '<div class="prod-grid shop-grid shop-grid-3">' + items.map(productCard).join('') + '</div>' +
        bulkBanner() +
        '<p class="shop-note">' + esc(shipNote()) + (catalog.payments && catalog.payments.cod ? ' · Cash on Delivery available' : '') + ' · All prices include GST</p>' +
      '</section>';
  }

  function renderOfferPage() {
    var view = $('#productView');
    if (!view || ROUTE.view !== 'offer') return;
    var o = findOffer(ROUTE.slug);
    if (!o) return notFound(view, 'that offer');
    var mrp = offerMrp(o);
    setMeta(o.name, o.description || (o.name + ': ' + (o.contents || '') + ' for ' + inr(o.price) + '.'), offerUrl(o));
    setLd(productLd(o.name, o.description || o.contents, offerUrl(o), o.price, o.in_stock !== false, o.items.map(function (i) { return i.image && i.image.web ? absImg(i.image.web) : null; })));

    var thumbs = o.items.map(function (it) {
      var p = prodById[it.product_id];
      if (!p) return '';
      return '<a href="' + esc(productUrl(p)) + '" title="' + esc(p.name) + '">' + productArt(p) + '</a>';
    }).join('');
    var media = '<div class="pdp-main offer-main' + (o.type === 'pack' ? ' is-pack' : ' is-combo') + '">' + offerArt(o) +
        (o.badge ? '<span class="prod-tag">' + esc(o.badge) + '</span>' : '') +
        (mrp > o.price ? '<span class="pdp-off">' + Math.round((1 - o.price / mrp) * 100) + '% off MRP</span>' : '') + '</div>' +
      (thumbs ? '<div class="pdp-thumbs offer-thumbs">' + thumbs + '</div>' : '');

    var price = '<div class="pdp-price"><b>' + inr(o.price) + '</b>' + (o.savings ? '<s>' + inr(o.compare_at) + '</s><em>Save ' + inr(o.savings) + '</em>' : '') + '</div>' +
      '<p class="pdp-tax">Inclusive of all taxes' + (o.savings ? ' · ' + inr(o.compare_at) + ' if bought separately' : '') + '</p>';
    var actions = '<div class="pdp-actions' + (o.in_stock === false ? ' one' : '') + '">' + (o.in_stock === false
      ? '<button type="button" class="btn btn-rust" disabled>Currently unavailable</button>'
      : '<button type="button" class="btn btn-rust" data-add="offer:' + esc(o.id) + '">Add to cart ' + ARROW + '</button><button type="button" class="btn btn-line" data-buynow="offer:' + esc(o.id) + '">Buy now</button>') + '</div>';

    var inside = '<div class="offer-inside"><h2>What\u2019s inside</h2><ul>' + o.items.map(function (it) {
      var p = prodById[it.product_id];
      var name = esc(it.qty) + ' \u00d7 ' + esc(it.name);
      return '<li>' + (p ? '<a class="oi-thumb" href="' + esc(productUrl(p)) + '" tabindex="-1" aria-hidden="true">' + productArt(p) + '</a>' : '') +
        '<div><b>' + (p ? '<a href="' + esc(productUrl(p)) + '">' + name + '</a>' : name) + '</b>' +
        (p ? '<small>' + esc(p.category) + (p.mrp > 0 ? ' \u00b7 MRP ' + inr(p.mrp) : '') + '</small>' : '') + '</div>' +
        '<span>' + inr(it.unit_price * it.qty) + '</span></li>';
    }).join('') + '</ul></div>';

    var rows = [['Contents', o.contents || o.items.map(function (it) { return it.qty + ' \u00d7 ' + it.name; }).join(' + ')]];
    if (mrp > 0) rows.push(['Total MRP', inr(mrp)]);
    if (o.savings) rows.push(['Bought separately', inr(o.compare_at)]);
    rows.push([offerKind(o) + ' price', inr(o.price) + ' (incl. of all taxes)']);
    if (o.savings) rows.push(['You save', inr(o.savings)]);
    // details every item shares (e.g. GST) are shown once for the whole offer
    var first = (prodById[(o.items[0] || {}).product_id] || {}).details || [];
    first.forEach(function (d) {
      var shared = o.items.every(function (it) {
        var p = prodById[it.product_id];
        return p && (p.details || []).some(function (x) { return x.label === d.label && x.value === d.value; });
      });
      if (shared) rows.push([d.label, d.value]);
    });
    var specs = '<div class="pdp-specs"><h2>' + offerKind(o) + ' details</h2><dl>' +
      rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl></div>';

    var perks = '<ul class="pdp-perks">' +
      '<li><span class="perk-ic">' + PERK_ICONS.ship + '</span>' + esc(shipNote()) + '</li>' +
      (catalog.payments && catalog.payments.cod ? '<li><span class="perk-ic">' + PERK_ICONS.cod + '</span>Cash on Delivery</li>' : '') +
      '<li><span class="perk-ic">' + PERK_ICONS.hand + '</span>Handcrafted in Kolkata</li></ul>';

    var otherOffers = combos().concat(packs()).filter(function (x) { return x.id !== o.id; });
    var inIt = o.items.map(function (it) { return it.product_id; });
    var products = catalog.products.filter(function (p) { return inIt.indexOf(p.id) !== -1; })
      .concat(catalog.products.filter(function (p) { return inIt.indexOf(p.id) === -1; }));

    view.innerHTML =
      '<section class="wrap pdp">' +
        '<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/shop">Shop</a><span aria-hidden="true">/</span><span aria-current="page">' + esc(o.name) + '</span></nav>' +
        '<div class="pdp-grid">' +
          '<div class="pdp-media">' + media + '</div>' +
          '<div class="pdp-info">' +
            '<span class="prod-cat">' + offerKind(o) + '</span>' +
            '<h1>' + esc(o.name) + '</h1>' +
            price + actions +
            (o.description ? '<p class="pdp-desc">' + esc(o.description) + '</p>' : '') +
            inside + perks + specs +
          '</div>' +
        '</div>' +
      '</section>' +
      (otherOffers.length ? '<section class="wrap sec pdp-related"><div class="sec-head"><div><div class="eyebrow">More offers</div><h2 class="h-sec">Other ways to <em>save</em></h2></div></div>' +
        '<div class="prod-grid shop-grid">' + otherOffers.map(offerCard).join('') + '</div></section>' : '') +
      '<section class="wrap sec pdp-related"><div class="sec-head"><div><div class="eyebrow">Shop single</div><h2 class="h-sec">Buy them <em>on their own</em></h2></div></div>' +
        '<div class="cats">' + products.map(catTile).join('') + '</div></section>';
  }

  // ------------------------------------------------------------------ mobile offer pop-up
  // phones don't get the top offer bar (it takes too much room); the main combo is shown as a card instead,
  // at most once a day, never over the cart / checkout / sign-in, and not on the offer or policy pages
  var OFFER_POP_KEY = 'gomo_offer_popup_at';
  var offerPopTimer = null;
  function offerPopupCard() {
    var all = combos().concat(packs()), o = all[0];
    if (!o) return '';
    var others = all.slice(1, 3);
    return '<div class="modal-card offer-pop">' +
      '<button type="button" class="x-btn" data-close aria-label="Close offer">' + X_ICON + '</button>' +
      '<div class="offer-pop-art">' + offerArt(o) + '</div>' +
      '<div class="offer-pop-body">' +
        '<span class="combo-badge">' + esc(o.badge || 'On offer') + (o.savings ? ' \u00b7 Save ' + inr(o.savings) : '') + '</span>' +
        '<h3 id="offerPopTitle">' + esc(o.name) + '</h3>' +
        '<p>' + esc(o.contents || o.items.map(function (it) { return it.qty + ' \u00d7 ' + it.name; }).join(' + ')) + '</p>' +
        '<div class="combo-price"><b>' + inr(o.price) + '</b>' + (o.savings ? '<s>' + inr(o.compare_at) + '</s><em>You save ' + inr(o.savings) + '</em>' : '') + '</div>' +
        (o.in_stock === false ? '' : '<button type="button" class="btn btn-white btn-block" data-add="offer:' + esc(o.id) + '">Add ' + (o.type === 'pack' ? 'pack' : 'combo') + ' \u00b7 ' + inr(o.price) + ' ' + ARROW + '</button>') +
        '<a class="offer-pop-more" href="' + esc(offerUrl(o)) + '" data-close>See what\u2019s inside</a>' +
      '</div>' +
      (others.length ? '<div class="offer-pop-also">' + others.map(function (x) {
        return '<a href="' + esc(offerUrl(x)) + '" data-close><span><small>Also on offer</small><b>' + esc(x.name) + '</b></span><strong>' + inr(x.price) + '</strong>' + ARROW + '</a>';
      }).join('') + '</div>' : '') +
    '</div>';
  }
  function maybeOfferPopup() {
    if (offerPopTimer || ROUTE.view === 'offer' || ROUTE.view === 'policy' || ROUTE.view === 'account') return;
    if (!window.matchMedia || !window.matchMedia('(max-width:640px)').matches) return;
    if (Date.now() - (Number(store(OFFER_POP_KEY)) || 0) < 864e5) return;
    if (!combos().length && !packs().length) return;
    offerPopTimer = setTimeout(function () {
      var m = $('#offerModal');
      if (!m || openPanel || !(combos().length || packs().length)) return;
      m.innerHTML = offerPopupCard();
      open(m);
      store(OFFER_POP_KEY, Date.now());
    }, 4000);
  }

  // ------------------------------------------------------------------ rendering
  // offers column: when there are fewer than 3 packs, fill it with the single products (MRP vs selling price)
  function singlesRows(n) {
    if (n <= 0) return '';
    return catalog.products.filter(function (p) { return buyable(p) && !packFor(p); }).slice(0, n).map(function (p) {
      var off = pctOff(p), href = esc(productUrl(p));
      return '<article class="pack single r">' +
        '<a class="pack-thumb" href="' + href + '" aria-label="' + esc(p.name) + '">' + productArt(p) + '</a>' +
        '<div><small>Single' + (off ? ' · ' + off + '% off' : '') + '</small>' +
          '<b><a href="' + href + '">' + esc(p.name) + '</a></b>' +
          '<div class="pack-price"><strong>' + inr(p.price) + '</strong>' + (p.mrp > p.price ? '<span class="was">MRP ' + inr(p.mrp) + '</span>' : '') + '</div></div>' +
        (p.in_stock
          ? '<button type="button" class="buy add" data-add="product:' + esc(p.id) + '">Add ' + ARROW + '</button>'
          : '<button type="button" class="buy" disabled>Out of stock</button>') +
      '</article>';
    }).join('');
  }

  function shipNote() {
    var s = catalog.shipping || {};
    if (!s.fee) return 'Free shipping';
    return 'Free shipping ' + (s.include_equal ? 'from ' : 'above ') + inr(s.free_above);
  }

  function renderOffers() {
    var section = $('#offers'), col = $('#comboCol'), packList = $('#packs'), wrap = $('.offers');
    if (!section || !col || !packList) return;
    var cs = combos(), ps = packs();
    section.hidden = !cs.length && !ps.length;
    wrap.classList.toggle('no-combo', !cs.length);
    wrap.classList.remove('no-packs');
    col.hidden = !cs.length;
    packList.hidden = false;

    col.innerHTML = cs.map(function (o, i) { return comboCard(o, i === 0); }).join('');

    packList.innerHTML = ps.map(function (o, i) {
      var it = o.items[0] || {};
      var p = prodById[it.product_id];
      var href = esc(offerUrl(o));
      return '<article class="pack r' + (i % 3 ? ' d' + (i % 3) : '') + '">' +
        (href ? '<a class="pack-thumb" href="' + href + '" aria-label="' + esc(it.name || o.name) + '">' : '<div class="pack-thumb">') + offerArt(o) + (href ? '</a>' : '</div>') +
        '<div><small>' + esc(o.badge || ('Pack of ' + it.qty)) + (o.savings ? ' · Save ' + inr(o.savings) : '') + '</small>' +
          '<b>' + (href ? '<a href="' + href + '">' + esc(it.name || o.name) + '</a>' : esc(it.name || o.name)) + (it.qty > 1 ? ' <span class="pack-qty">× ' + esc(it.qty) + '</span>' : '') + '</b>' +
          '<div class="pack-price"><strong>' + inr(o.price) + '</strong>' + (o.savings ? '<span class="was">' + inr(o.compare_at) + '</span>' : '') + '</div></div>' +
        (o.in_stock === false
          ? '<button type="button" class="buy" disabled>Unavailable</button>'
          : '<button type="button" class="buy add" data-add="offer:' + esc(o.id) + '">Add ' + ARROW + '</button>') +
      '</article>';
    }).join('') + singlesRows(3 - ps.length) +
      '<a href="/shop" class="btn btn-line packs-more">See all products ' + ARROW + '</a>';

    var note = $('.offer-note');
    if (note) note.textContent = 'Savings shown against buying the same items individually · Cash on Delivery available';
  }

  function renderOfferBar() {
    var bar = $('#offerBar');
    if (!bar) return;
    var cs = combos(), ps = packs();
    if (!cs.length && !ps.length) { bar.hidden = true; return; }
    var parts = ['<span class="pill">On Offer</span>'];
    if (cs[0]) parts.push('<span>' + esc(cs[0].badge || cs[0].name) + ' at <b>' + inr(cs[0].price) + '</b>' + (cs[0].savings ? ' — save ' + inr(cs[0].savings) : '') + '</span>');
    if (cs[0] && ps.length) parts.push('<span class="sep" aria-hidden="true">·</span>');
    if (ps.length) parts.push('<span>' + (ps.length === 1 ? esc((ps[0].items[0] || {}).name || ps[0].name) + ' · ' + esc(ps[0].badge || 'Pack') + ' at' : 'Packs from') + ' <b>' + inr(Math.min.apply(null, ps.map(function (o) { return o.price; }))) + '</b></span>');
    parts.push('<a href="/shop" class="go">View offers <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></a>');
    bar.innerHTML = parts.join('\n');
    bar.hidden = false;
  }

  function renderMenus() {
    var drop = $('#shopDrop');
    if (drop) {
      var html = '<a href="/shop"><b>All products</b></a>' + catalog.products.map(function (p) {
        return '<a href="' + esc(productUrl(p)) + '">' + esc(p.name) + ' <span>' + (buyable(p) ? inr(p.price) : 'Ask us') + '</span></a>';
      }).join('');
      if (catalog.offers.length) {
        html += '<hr>' + catalog.offers.slice(0, 6).map(function (o) {
          return '<a href="' + esc(offerUrl(o)) + '">' + esc(o.type === 'pack' ? o.name : (o.badge || o.name)) + ' <span>' + inr(o.price) + '</span></a>';
        }).join('');
      }
      drop.innerHTML = html;
    }
    var foot = $('#footProducts');
    if (foot) {
      var items = ['<li><a href="/shop">All products</a></li>'].concat(catalog.products.map(function (p) { return '<li><a href="' + esc(productUrl(p)) + '">' + esc(p.name) + (buyable(p) ? ' — ' + inr(p.price) : '') + '</a></li>'; }));
      combos().slice(0, 2).forEach(function (o) { items.push('<li><a href="' + esc(offerUrl(o)) + '">' + esc(o.badge || o.name) + ' — ' + inr(o.price) + '</a></li>'); });
      packs().forEach(function (o) { items.push('<li><a href="' + esc(offerUrl(o)) + '">' + esc(o.name) + ' — ' + inr(o.price) + '</a></li>'); });
      foot.innerHTML = items.join('');
    }
    $$('[data-cat]').forEach(function (el) {
      var p = prodById[el.getAttribute('data-cat')];
      if (p && buyable(p)) el.innerHTML = priceWithMrp(p);
    });
    $$('[data-ship-note]').forEach(function (el) { el.textContent = catalog.shipping.fee ? ('on orders ' + (catalog.shipping.include_equal ? 'from ' : 'above ') + inr(catalog.shipping.free_above)) : 'on every order'; });
    // WhatsApp-only links (footer icon, "Order via WhatsApp") stay hidden until a real number is set
    $$('[data-wa]').forEach(function (a) {
      a.hidden = !hasWhatsApp();
      if (hasWhatsApp()) a.href = a.href.replace(/wa\.me\/\d*/, 'wa.me/' + String(catalog.store.whatsapp).replace(/\D/g, ''));
    });
    // Contact email comes from Admin → Settings → Store. Update every mailto link, and any link that shows the address as its text.
    $$('[data-store-email]').forEach(function (a) {
      var em = catalog.store.email || 'support@earthenbeauty.in';
      a.href = a.href.replace(/^mailto:[^?]*/, 'mailto:' + em);
      if (/@/.test(a.textContent)) a.textContent = em;
    });
  }

  // hero season card
  var seasonItems = [], si = 0, seasonTimer = null;
  function buildSeason() {
    seasonItems = [];
    combos().slice(0, 1).forEach(function (o) {
      seasonItems.push({ art: offerArtHref(o), img: isTrio(o) ? COMBO_IMG.sq_small : null, tag: 'On Offer', name: o.badge || o.name, href: offerUrl(o),
        text: esc(o.items.map(function (i) { return i.name.replace(/^Evil Eye /, ''); }).join(' + ')) + ' · <strong>' + inr(o.price) + '</strong>' + (o.savings ? ' <span class="was">' + inr(o.compare_at) + '</span>' : '') });
    });
    catalog.products.forEach(function (p) {
      var pack = buyable(p) ? packFor(p) : null;
      seasonItems.push({ art: ART[p.art] || ART.candle, img: hasPhoto(p) ? mediaUrl(p.images[0].sq_small || p.images[0].sq || p.images[0].thumb) : null, studio: hasPhoto(p) && p.images[0].studio, tag: p.tag || p.category, name: p.name, href: productUrl(p),
        text: buyable(p)
          ? '<strong>' + inr(p.price) + '</strong>' + (p.mrp > p.price ? ' <span class="was">' + inr(p.mrp) + '</span>' : '') + (pack ? ' · ' + esc(pack.badge || 'Pack') + ' ' + inr(pack.price) : '')
          : 'Curated bundles · <strong>Ask us</strong>' });
    });
    si = -1;
    showSeason(0, true);
  }
  function showSeason(n, instant) {
    if (!seasonItems.length) return;
    si = (n + seasonItems.length) % seasonItems.length;
    var body = $('#seasonBody');
    if (!body) return;
    var apply = function () {
      var p = seasonItems[si];
      var thumb = $('.season-thumb');
      if (thumb) {
        thumb.classList.toggle('has-photo', !!p.img);
        thumb.innerHTML = p.img
          ? '<img src="' + esc(p.img) + '" alt="" width="160" height="160"' + (p.studio ? ' class="studio"' : '') + '>'
          : '<svg aria-hidden="true"><use href="' + p.art + '"/></svg>';
      }
      $('#seasonTag').textContent = p.tag;
      $('#seasonName').textContent = p.name;
      $('#seasonName').setAttribute('href', p.href);
      $('#seasonText').innerHTML = p.text;
      body.classList.remove('fade');
    };
    if (instant) return apply();
    body.classList.add('fade');
    setTimeout(apply, 220);
  }

  function renderAll() {
    indexCatalog();
    renderOfferBar();
    renderMenus();
    renderOffers();
    if ($('#seasonBody')) buildSeason();
    renderProductPage();
    renderOfferPage();
    renderShopPage();
    observeReveal();
    renderCart();
    tickCountdowns();
  }

  // ------------------------------------------------------------------ reveal on scroll
  var io = null;
  function observeReveal() {
    var els = $$('.r:not(.vis)');
    if (!io) {
      els.forEach(function (el) { el.classList.add('vis'); });
      return;
    }
    els.forEach(function (el) { io.observe(el); });
  }

  // ------------------------------------------------------------------ cart
  var cart = (store(CART_KEY) || []).filter(function (i) { return i && (i.type === 'product' || i.type === 'offer') && i.id && i.qty > 0; });

  function saveCart() { store(CART_KEY, cart); renderCart(); }
  function cartCount() { return cart.reduce(function (s, i) { return s + i.qty; }, 0); }

  function addToCart(type, id, qty) {
    var item = cart.filter(function (i) { return i.type === type && i.id === id; })[0];
    if (item) item.qty = Math.min(20, item.qty + (qty || 1));
    else cart.push({ type: type, id: id, qty: qty || 1 });
    saveCart();
    var btn = $('#cartBtn');
    if (btn) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
    var line = resolve({ type: type, id: id, qty: 1 });
    toast((line ? line.name : 'Item') + ' added to cart', 'View cart', openCart);
  }

  function resolve(it) {
    if (it.type === 'product') {
      var p = prodById[it.id];
      if (!p) return null;
      return { key: 'product:' + p.id, name: p.name, sub: p.category, unit: p.price, compare: p.price, art: productArt(p), ok: buyable(p) && p.in_stock, qty: it.qty };
    }
    var o = offerById[it.id];
    if (!o) return null;
    return { key: 'offer:' + o.id, name: o.name, sub: o.contents, unit: o.price, compare: o.compare_at, art: offerArt(o, true), ok: o.in_stock !== false, qty: it.qty };
  }

  function totals() {
    var lines = cart.map(resolve).filter(Boolean);
    var subtotal = 0, compare = 0;
    lines.forEach(function (l) { if (l.ok) { subtotal += l.unit * l.qty; compare += l.compare * l.qty; } });
    var s = catalog.shipping || {};
    var free = s.include_equal ? subtotal >= s.free_above : subtotal > s.free_above;
    var shipping = subtotal > 0 && !free ? (s.fee || 0) : 0;
    return { lines: lines, subtotal: subtotal, savings: Math.max(0, compare - subtotal), shipping: shipping, total: subtotal + shipping };
  }

  function summaryRows(t) {
    return '<div class="sum-row"><span>Subtotal</span><span>' + inr(t.subtotal) + '</span></div>' +
      (t.savings ? '<div class="sum-row save"><span>You save</span><span>− ' + inr(t.savings) + '</span></div>' : '') +
      (t.discount ? '<div class="sum-row save"><span>Coupon ' + esc(t.coupon) + '</span><span>− ' + inr(t.discount) + '</span></div>' : '') +
      '<div class="sum-row"><span>Shipping</span><span>' + (t.shipping ? inr(t.shipping) : 'Free') + '</span></div>' +
      '<div class="sum-row total"><span>Total</span><span>' + inr(t.total) + '</span></div>';
  }

  function renderCart() {
    var count = cartCount();
    var badge = $('#cartCount');
    if (badge) { badge.textContent = count; badge.hidden = !count; }
    var body = $('#cartBody'), foot = $('#cartFoot');
    if (!body) return;
    var t = totals();
    if (!t.lines.length) {
      body.innerHTML = '<div class="cart-empty">' + useSvg('#i-candle') + '<b>Your cart is empty</b>Add a candle, a combo or a pack to get started.</div>';
      foot.innerHTML = '<a href="/shop" class="btn btn-rust btn-block" data-close>Browse products ' + ARROW + '</a>';
      return;
    }
    body.innerHTML = t.lines.map(function (l) {
      return '<div class="line" data-key="' + esc(l.key) + '">' +
        '<div class="line-thumb">' + l.art + '</div>' +
        '<div><b>' + esc(l.name) + '</b><small>' + esc(l.sub || '') + '</small>' +
          (l.ok
            ? '<div class="line-actions"><span class="stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button><span>' + l.qty + '</span><button type="button" data-step="1" aria-label="Increase">+</button></span>' +
              '<button type="button" class="link-btn" data-remove>Remove</button></div>'
            : '<div class="line-actions"><small style="color:#b3261e">No longer available</small><button type="button" class="link-btn" data-remove>Remove</button></div>') +
        '</div>' +
        '<div class="line-price">' + inr(l.unit * l.qty) + (l.compare > l.unit ? '<s>' + inr(l.compare * l.qty) + '</s>' : '') + '</div>' +
      '</div>';
    }).join('');
    var s = catalog.shipping || {};
    var progress = '';
    if (s.fee && t.subtotal > 0) {
      var need = (s.include_equal ? s.free_above : s.free_above + 1) - t.subtotal;
      var pct = Math.min(100, Math.round(t.subtotal / Math.max(1, s.free_above) * 100));
      progress = '<div class="ship-progress">' + (need > 0 ? 'Add ' + inr(need) + ' more for free shipping' : 'You have unlocked free shipping') + '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }
    var anyBad = t.lines.some(function (l) { return !l.ok; });
    foot.innerHTML = progress + summaryRows(t) +
      '<button type="button" class="btn btn-rust btn-block" id="toCheckout"' + (anyBad || !t.subtotal ? ' disabled' : '') + '>Checkout · ' + inr(t.total) + ' ' + ARROW + '</button>' +
      '<p class="muted-note">' + (anyBad ? 'Remove unavailable items to continue.' : [catalog.payments && catalog.payments.cod ? 'Cash on Delivery available' : '', shipNote()].filter(Boolean).join(' · ')) + '</p>';
  }

  // ------------------------------------------------------------------ overlay / panels
  var openPanel = null;
  function showOverlay(on) {
    $('#uiOverlay').classList.toggle('open', on);
    document.body.classList.toggle('ui-lock', on);
  }
  function open(el) {
    if (openPanel && openPanel !== el) openPanel.classList.remove('open');
    openPanel = el;
    el.classList.add('open');
    $('#toast').classList.remove('show');
    showOverlay(true);
    setTimeout(function () { var f = $('input, select, button:not(.x-btn)', el); if (f) f.focus({ preventScroll: true }); }, 60);
  }
  function closeAll() {
    if (openPanel) openPanel.classList.remove('open');
    if (openPanel && openPanel.id === 'trackModal' && /^#track/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    openPanel = null;
    showOverlay(false);
  }
  function openCart() { renderCart(); open($('#cartDrawer')); }

  // ------------------------------------------------------------------ toast
  var toastTimer = null;
  function toast(msg, action, fn) {
    var t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action) + '</button>' : '');
    if (action) $('button', t).addEventListener('click', function () { t.classList.remove('show'); fn(); });
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  // ------------------------------------------------------------------ checkout (signed-in customers with a verified mobile)
  var ck = { step: 1, idem: null, busy: false, error: '', fieldErrors: {}, values: null, result: null, uid: null, addr: 'new', saveAddr: true };
  var CHECK_IC = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var LOC_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/></svg>';

  function profile() { return (window.GomoAuth && window.GomoAuth.profile) || null; }
  function savedAddr() { var p = profile(); return p && ck.addr !== 'new' ? (p.addresses || []).filter(function (a) { return a.id === ck.addr; })[0] || null : null; }

  function defaultValues(p) {
    var saved = store(DETAILS_KEY) || {};
    return {
      name: (p && p.name) || saved.name || '', phone: (p && p.phone) || saved.phone || '', line1: '', line2: '', landmark: '', city: '', state: '', pincode: '', lat: null, lng: null, accuracy: null,
      notes: '', payment_method: catalog.payments.cod ? 'cod' : 'razorpay'
    };
  }

  function openCheckout() {
    var t = totals();
    if (!t.lines.length) return;
    if (!window.GomoAuth) { toast('Loading sign-in… please try again in a moment.'); return; }
    window.GomoAuth.require('checkout').then(startCheckout).catch(function () { /* sign-in closed */ });
  }

  function startCheckout(p) {
    if (!p) return;
    var keep = ck.values && ck.uid === p.uid && !ck.result ? ck.values : null;
    var addrs = p.addresses || [];
    var def = addrs.filter(function (a) { return a.default; })[0] || addrs[0];
    ck = { step: 1, idem: uid(), busy: false, error: '', fieldErrors: {}, values: keep || defaultValues(p), result: null, uid: p.uid,
      addr: def ? def.id : 'new', saveAddr: addrs.length < 5 };
    if (!ck.values.name) ck.values.name = p.name || (def && def.name) || '';
    if (!catalog.payments.cod && ck.values.payment_method === 'cod') ck.values.payment_method = 'razorpay';
    renderCheckout();
    open($('#checkoutModal'));
  }

  function field(name, label, opts) {
    opts = opts || {};
    var v = ck.values[name] || '';
    var err = ck.fieldErrors[name];
    var input;
    if (opts.type === 'select') {
      input = '<select id="ck-' + name + '" name="' + name + '" autocomplete="' + (opts.ac || 'off') + '"><option value="">Select…</option>' +
        STATES.map(function (s) { return '<option' + (s === v ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>';
    } else if (opts.type === 'textarea') {
      input = '<textarea id="ck-' + name + '" name="' + name + '" maxlength="300" placeholder="' + esc(opts.ph || '') + '">' + esc(v) + '</textarea>';
    } else {
      input = '<input id="ck-' + name + '" name="' + name + '" value="' + esc(v) + '" type="' + (opts.type || 'text') + '"' +
        (opts.ac ? ' autocomplete="' + opts.ac + '"' : '') + (opts.mode ? ' inputmode="' + opts.mode + '"' : '') +
        (opts.max ? ' maxlength="' + opts.max + '"' : '') + (opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : '') + '>';
      if (opts.prefix) input = '<div class="prefix"><span>' + opts.prefix + '</span>' + input + '</div>';
    }
    return '<div class="field' + (opts.full ? ' full' : '') + (err ? ' invalid' : '') + '" data-field="' + name + '">' +
      '<label for="ck-' + name + '">' + label + (opts.optional ? ' <i>(optional)</i>' : '') + '</label>' + input +
      '<div class="err">' + esc(err || '') + '</div></div>';
  }

  /** Shared with account.js. Returns { field: message } for invalid address fields. */
  function validateAddressValues(v, requireName) {
    var e = {};
    if (requireName && String(v.name || '').trim().length < 2) e.name = 'Please enter the recipient name.';
    if (String(v.line1 || '').trim().length < 5) e.line1 = 'Enter your house / flat and street.';
    if (String(v.city || '').trim().length < 2) e.city = 'Enter your city.';
    if (STATES.indexOf(v.state) < 0) e.state = 'Choose your state.';
    if (!/^[1-9]\d{5}$/.test(String(v.pincode || '').trim())) e.pincode = 'Enter a valid 6-digit PIN code.';
    return e;
  }

  function validateStep(step) {
    var v = ck.values, e = {};
    if (step === 1 && String(v.name).trim().length < 2) e.name = 'Please enter your full name.';
    if (step === 1 && !phoneVerified() && !normPhone(v.phone)) e.phone = 'Enter a valid 10-digit mobile number.';
    if (step === 2) {
      if (ck.addr === 'new') e = validateAddressValues(v, false);
      else if (!savedAddr()) e.addr = 'Choose a delivery address.';
    }
    if (step === 3 && !v.payment_method) e.payment_method = 'Choose a payment method.';
    ck.fieldErrors = e;
    return !Object.keys(e).length;
  }

  function deliveryAddress() {
    var a = savedAddr() || ck.values;
    var out = { line1: a.line1, line2: a.line2 || '', landmark: a.landmark || '', city: a.city, state: a.state, pincode: String(a.pincode || '').trim() };
    if (a.lat != null && a.lng != null) { out.lat = a.lat; out.lng = a.lng; out.accuracy = a.accuracy; }
    return out;
  }
  function addressLines(a) { return esc([a.line1, a.line2, a.landmark].filter(Boolean).join(', ')) + '<br>' + esc(a.city + ', ' + a.state + ' ' + a.pincode); }

  function miniSummary(t) {
    return '<aside class="ck-summary"><h4>Your order</h4>' +
      t.lines.filter(function (l) { return l.ok; }).map(function (l) { return '<div class="mini"><span>' + l.qty + ' × ' + esc(l.name) + '</span><span>' + inr(l.unit * l.qty) + '</span></div>'; }).join('') +
      '<div style="margin-top:10px">' + summaryRows(t) + '</div></aside>';
  }

  function contactBox(p) {
    var email = p.email
      ? (p.email_verified
        ? '<div class="cb-row ok"><span class="cb-ic">' + CHECK_IC + '</span><div><b>' + esc(p.email) + '</b><small>Receipts by email</small></div></div>'
        : '<div class="cb-row"><span class="cb-ic warn">!</span><div><b>' + esc(p.email) + '</b><small>Not confirmed yet — <button type="button" class="link-btn" data-ck="account">confirm it</button> to get email receipts</small></div></div>')
      : '<div class="cb-row"><span class="cb-ic muted">@</span><div><small>No email on your account — <button type="button" class="link-btn" data-ck="account">add one</button> for receipts (optional)</small></div></div>';
    return '<div class="contact-box">' +
      (phoneVerified() ? '<div class="cb-row ok"><span class="cb-ic">' + CHECK_IC + '</span><div><b>+91 ' + esc(p.phone) + '</b><small>Verified mobile · order updates' + (p.whatsapp_status === 'verified' ? ' on WhatsApp' : p.whatsapp_status === 'unavailable' ? ' by email' : '') + '</small></div></div>' : '') +
      email + '</div>' +
      '<p class="muted-note" style="text-align:left">Not you? <button type="button" class="link-btn" data-ck="switch">Use a different account</button></p>';
  }

  // Totals with the coupon the server confirmed (re-checked again when the order is placed).
  function ckTotals() {
    var t = totals();
    var c = ck.coupon;
    if (c && c.subtotal === t.subtotal) { t.discount = c.discount; t.coupon = c.code; t.shipping = c.shipping; t.total = c.total; }
    else if (c) ck.coupon = null; // cart changed: ask again
    return t;
  }
  function couponBox() {
    var c = ck.coupon;
    if (c) return '<div class="coupon-box on"><span><b>' + esc(c.code) + '</b> applied · ' + esc(c.message) + '</span><button type="button" class="link-btn" data-ck="uncoupon">Remove</button></div>';
    return '<div class="coupon-box"><label for="ck-coupon">Have a coupon code?</label><div class="coupon-row">' +
      '<input id="ck-coupon" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="e.g. WELCOME10" value="' + esc(ck.couponTyped || '') + '">' +
      '<button type="button" class="btn btn-line btn-sm" data-ck="coupon"' + (ck.couponBusy ? ' disabled' : '') + '>' + (ck.couponBusy ? '<span class="spinner"></span>' : 'Apply') + '</button></div>' +
      (ck.couponError ? '<small class="err">' + esc(ck.couponError) + '</small>' : '') + '</div>';
  }
  function applyCoupon() {
    var input = $('#ck-coupon');
    var code = (input ? input.value : ck.couponTyped || '').trim().toUpperCase();
    ck.couponTyped = code;
    if (!code) { ck.couponError = 'Enter a code.'; return renderCheckout(); }
    ck.couponBusy = true; ck.couponError = ''; renderCheckout();
    var t = totals();
    api('/api/coupons/check', { method: 'POST', body: { code: code, phone: orderPhone(), items: cart.map(function (i) { return { type: i.type, id: i.id, qty: i.qty }; }) } })
      .then(function (d) { ck.coupon = Object.assign({ subtotal: t.subtotal }, d.coupon); ck.couponBusy = false; renderCheckout(); toast(d.coupon.message); })
      .catch(function (err) { ck.couponBusy = false; ck.couponError = err.message; renderCheckout(); });
  }

  function renderCheckout() {
    var m = $('#checkoutModal');
    var t = ckTotals();
    var p = profile();
    if (!p && !ck.result) return;
    var title = ck.result ? (ck.result.kind === 'pending' ? 'Payment pending' : 'Order placed') : 'Checkout';
    var stepsBar = ck.result ? '' : '<div class="steps-bar">' + ['Contact', 'Delivery', 'Payment'].map(function (s, i) {
      return '<span class="' + (ck.step === i + 1 ? 'on' : ck.step > i + 1 ? 'done' : '') + '">' + (i + 1) + '. ' + s + '</span>';
    }).join('') + '</div>';
    var body = '', foot = '';

    if (ck.result) {
      body = renderResult();
    } else {
      var alert = ck.error ? '<div class="alert err" role="alert">' + esc(ck.error) + '</div>' : '';
      if (!live) alert = '<div class="alert info">Online ordering is connecting… If this message stays, you can also <a href="' + esc(waLink(waOrderText(t))) + '" target="_blank" rel="noopener" style="text-decoration:underline;font-weight:600">' + (hasWhatsApp() ? 'order on WhatsApp' : 'email us your order') + '</a>.</div>' + alert;
      var form = '';
      if (ck.step === 1) {
        form = '<div class="form-grid">' + field('name', 'Full name', { ac: 'name', max: 80, full: true }) +
          (phoneVerified() ? '' : field('phone', 'Mobile number', { type: 'tel', ac: 'tel-national', mode: 'numeric', max: 14, prefix: '+91', ph: '98765 43210', full: true })) +
          '</div>' + (phoneVerified() ? '' : '<p class="muted-note" style="text-align:left;margin:-6px 0 14px">We call or WhatsApp this number to confirm your order before shipping.</p>') + contactBox(p);
      } else if (ck.step === 2) {
        var addrs = p.addresses || [];
        var list = addrs.length ? '<div class="pay-opts addr-choices" role="radiogroup" aria-label="Delivery address">' + addrs.map(function (a) {
          return '<label class="pay-opt' + (ck.addr === a.id ? ' on' : '') + '"><input type="radio" name="addr_choice" value="' + esc(a.id) + '"' + (ck.addr === a.id ? ' checked' : '') + '>' +
            '<span><b>' + esc(a.label || a.name || 'Saved address') + (a.default ? ' <em class="tag">Default</em>' : '') + '</b><small>' + addressLines(a) + '</small></span></label>';
        }).join('') + '<label class="pay-opt' + (ck.addr === 'new' ? ' on' : '') + '"><input type="radio" name="addr_choice" value="new"' + (ck.addr === 'new' ? ' checked' : '') + '><span><b>Deliver to a new address</b></span></label></div>' +
          (ck.fieldErrors.addr ? '<div class="alert err">' + esc(ck.fieldErrors.addr) + '</div>' : '') : '';
        var fresh = '';
        if (ck.addr === 'new') {
          fresh = (window.GomoLocation && window.GomoLocation.available() ? '<button type="button" class="btn btn-line btn-sm loc-btn" data-ck="locate">' + LOC_IC + ' Use my current location</button><div class="loc-holder" id="ckLoc" hidden></div>' : '') +
            '<div class="form-grid">' +
            field('line1', 'House / flat, street', { ac: 'address-line1', max: 160, full: true }) +
            field('line2', 'Area / locality', { ac: 'address-line2', max: 160, full: true, optional: true }) +
            field('landmark', 'Landmark', { max: 100, optional: true }) +
            field('pincode', 'PIN code', { ac: 'postal-code', mode: 'numeric', max: 6 }) +
            field('city', 'City', { ac: 'address-level2', max: 60 }) +
            field('state', 'State', { type: 'select', ac: 'address-level1' }) +
            '</div>' +
            (ck.values.lat != null ? '<p class="muted-note pin-note">Map pin added — the courier will see your exact location. <button type="button" class="link-btn" data-ck="unpin">Remove pin</button></p>' : '') +
            ((p.addresses || []).length < 5 ? '<label class="check-row"><input type="checkbox" id="ckSave"' + (ck.saveAddr ? ' checked' : '') + '> Save this address to my account</label>' : '');
        }
        form = list + fresh + '<div class="form-grid" style="margin-top:14px">' + field('notes', 'Delivery note', { type: 'textarea', full: true, optional: true, ph: 'Gift message, preferred time…' }) + '</div>';
      } else {
        var v = ck.values;
        var opts = [];
        if (catalog.payments.cod) opts.push(['cod', 'Cash on Delivery', 'Pay in cash or UPI when your order arrives.']);
        if (catalog.payments.razorpay) opts.push(['razorpay', 'Pay online', 'UPI, cards, net banking and wallets via Razorpay.']);
        form = '<div class="pay-opts" role="radiogroup" aria-label="Payment method">' + opts.map(function (o) {
          return '<label class="pay-opt' + (v.payment_method === o[0] ? ' on' : '') + '"><input type="radio" name="payment_method" value="' + o[0] + '"' + (v.payment_method === o[0] ? ' checked' : '') + '>' +
            '<span><b>' + o[1] + '</b><small>' + o[2] + '</small></span></label>';
        }).join('') + '</div>' +
          '<div class="review-box"><button type="button" class="link-btn" data-goto="1">Change</button><b>' + esc(v.name) + '</b> · +91 ' + esc(orderPhone()) + (p.email && p.email_verified ? ' · ' + esc(p.email) : '') + '</div>' +
          '<div class="review-box"><button type="button" class="link-btn" data-goto="2">Change</button><b>Deliver to</b>' + (deliveryAddress().lat != null ? ' <em class="tag">Pinned on map</em>' : '') + '<br>' + addressLines(deliveryAddress()) + '</div>' +
          couponBox();
      }
      body = alert + '<div class="ck-grid"><div>' + form + '</div>' + miniSummary(t) + '</div>';
      var back = ck.step > 1 ? '<button type="button" class="btn btn-line" data-ck="back">Back</button>' : '<button type="button" class="btn btn-line" data-close>Continue shopping</button>';
      var next = ck.step < 3
        ? '<button type="button" class="btn btn-rust" data-ck="next">Continue ' + ARROW + '</button>'
        : '<button type="button" class="btn btn-rust" data-ck="place"' + (ck.busy ? ' disabled' : '') + '>' +
          (ck.busy ? '<span class="spinner"></span> Placing order…' : (ck.values.payment_method === 'razorpay' ? 'Pay ' + inr(t.total) : 'Place order · ' + inr(t.total))) + '</button>';
      foot = back + next;
    }

    m.querySelector('.modal-card').innerHTML =
      '<div class="panel-head"><h3 id="ckTitle">' + title + '</h3><button type="button" class="x-btn" data-close aria-label="Close">' + X_ICON + '</button></div>' +
      stepsBar + '<div class="modal-body">' + body + '</div>' + (foot ? '<div class="modal-foot">' + foot + '</div>' : '');
  }

  function renderResult() {
    var r = ck.result, o = r.order;
    var p = profile();
    if (r.kind === 'pending') {
      return '<div class="done-wrap"><div class="done-ic warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg></div>' +
        '<h3>Payment not completed</h3><p>Your order <b>' + esc(o.order_no) + '</b> is saved but not paid yet. ' + (r.message ? esc(r.message) : '') + '</p>' +
        '<div class="done-actions"><button type="button" class="btn btn-rust" data-ck="retry">Try payment again</button>' +
        (catalog.payments.cod ? '<button type="button" class="btn btn-line" data-ck="cod">Pay with Cash on Delivery</button>' : '') + '</div></div>';
    }
    var channels = [p && p.whatsapp_status !== 'unavailable' ? 'WhatsApp' : null, p && p.email && p.email_verified ? 'email' : null].filter(Boolean);
    return '<div class="done-wrap"><div class="done-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>' +
      '<h3>Thank you, ' + esc(String(ck.values.name).split(' ')[0]) + '!</h3>' +
      '<p>Your order is placed' + (o.payment_status === 'paid' ? ' and paid' : '') + '.' + (channels.length ? ' We\'ll send updates on ' + channels.join(' and ') + '.' : '') + '</p>' +
      '<div class="order-no">' + esc(o.order_no) + '</div>' +
      '<div class="review-box" style="text-align:left;max-width:420px;margin:18px auto 0">' +
        o.items.map(function (i) { return '<div class="sum-row"><span>' + i.qty + ' × ' + esc(i.name) + '</span><span>' + inr(i.line_total) + '</span></div>'; }).join('') +
        '<div class="sum-row total"><span>' + esc(o.payment_label) + '</span><span>' + inr(o.total) + '</span></div></div>' +
      (p && p.pending && p.pending.length ? '<p class="muted-note">Confirm your ' + (p.pending.indexOf('whatsapp') >= 0 ? 'WhatsApp' : 'email') + ' in <button type="button" class="link-btn" data-ck="account">your account</button> so updates reach you.</p>' : '') +
      '<div class="done-actions"><button type="button" class="btn btn-rust" data-track="' + esc(o.order_no) + '">Track order ' + ARROW + '</button>' +
      '<button type="button" class="btn btn-line" data-close>Continue shopping</button></div></div>';
  }

  function waOrderText(t) {
    return 'Hi! I\'d like to order from ' + catalog.store.name + ':\n' +
      t.lines.filter(function (l) { return l.ok; }).map(function (l) { return '• ' + l.qty + ' × ' + l.name + ' — ' + inr(l.unit * l.qty); }).join('\n') +
      '\nTotal: ' + inr(t.total);
  }

  function saveDetails() { store(DETAILS_KEY, { name: ck.values.name, phone: phoneVerified() ? '' : normPhone(ck.values.phone) }); }
  function phoneVerified() { var p = profile(); return !!(p && p.phone_verified && p.phone); }
  function orderPhone() { var p = profile(); return phoneVerified() ? p.phone : normPhone(ck.values.phone); }

  var STEP_OF_FIELD = { name: 1, phone: 1, line1: 2, line2: 2, landmark: 2, city: 2, state: 2, pincode: 2, notes: 2, payment_method: 3 };

  function needAuthAgain(err) {
    var code = err.data && err.data.code;
    if (err.status !== 401 && code !== 'phone_unverified' && code !== 'account_merged') return false;
    ck.busy = false;
    closeAll();
    var go = function () { window.GomoAuth.require('checkout').then(function (p) { var v = ck.values; startCheckout(p); ck.values = v; ck.step = 3; renderCheckout(); }).catch(function () {}); };
    if (code === 'account_merged') window.GomoAuth.signOut().then(go); else go();
    return true;
  }

  function placeOrder() {
    if (ck.busy) return;
    if (!validateStep(1)) { ck.step = 1; return renderCheckout(); }
    if (!validateStep(2)) { ck.step = 2; return renderCheckout(); }
    if (!validateStep(3)) return renderCheckout();
    var v = ck.values;
    var p = profile();
    ck.busy = true; ck.error = '';
    renderCheckout();
    saveDetails();
    api('/api/orders', {
      method: 'POST',
      body: {
        items: cart.map(function (i) { return { type: i.type, id: i.id, qty: i.qty }; }),
        customer: { name: v.name.trim(), phone: orderPhone() },
        address: deliveryAddress(),
        save_address: ck.addr === 'new' && ck.saveAddr,
        notes: v.notes, payment_method: v.payment_method, idempotency_key: ck.idem, coupon: ck.coupon ? ck.coupon.code : null
      }
    }).then(function (data) {
      store(LAST_ORDER_KEY, { order_no: data.order.order_no, phone: orderPhone() });
      if (ck.addr === 'new' && ck.saveAddr && window.GomoAuth) window.GomoAuth.refresh().catch(function () {});
      if (data.razorpay) return payOnline(data.order, data.razorpay);
      orderDone(data.order);
    }).catch(function (err) {
      if (needAuthAgain(err)) return;
      ck.busy = false;
      if (err.data && err.data.code === 'coupon_invalid') { ck.coupon = null; ck.couponError = err.message; ck.step = 3; ck.error = ''; return renderCheckout(); }
      if (err.data && err.data.fields) {
        ck.fieldErrors = err.data.fields;
        var steps = Object.keys(err.data.fields).map(function (f) { return STEP_OF_FIELD[f] || 3; });
        ck.step = Math.min.apply(null, steps);
      }
      ck.error = err.message;
      if (err.status === 409) refreshCatalog();
      renderCheckout();
    });
  }

  function orderDone(order) {
    cart = [];
    saveCart();
    ck.busy = false;
    ck.result = { kind: 'done', order: order };
    ck.values.notes = '';
    renderCheckout();
  }

  // address helpers shared with the account dashboard
  var pinCache = {}, pinTimer = null;
  function pinAutofill(pin, cb) {
    pin = String(pin || '').trim();
    clearTimeout(pinTimer);
    if (!/^[1-9]\d{5}$/.test(pin) || !window.GomoLocation || !(window.GomoAuth && window.GomoAuth.user)) return;
    if (pinCache[pin]) return cb(pinCache[pin]);
    pinTimer = setTimeout(function () {
      window.GomoLocation.lookupPin(pin, api).then(function (d) { pinCache[pin] = d; cb(d); }).catch(function () { /* user can type it */ });
    }, 250);
  }

  function startLocate() {
    var holder = $('#ckLoc');
    if (!holder || !window.GomoLocation) return;
    window.GomoLocation.start(holder, {
      api: api,
      onApply: function (f) {
        var v = ck.values;
        var filled = ['line1', 'line2', 'city', 'state', 'pincode'].some(function (k) { return String(v[k] || '').trim(); });
        if (filled && !window.confirm('Replace the address you typed with your location?')) { v.lat = f.lat; v.lng = f.lng; v.accuracy = f.accuracy; }
        else { Object.keys(f).forEach(function (k) { v[k] = f[k]; }); ck.fieldErrors = {}; }
        renderCheckout();
        var first = $('#ck-line1');
        if (first) first.focus();
      }
    });
  }

  var rzpLoading = null;
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (rzpLoading) return rzpLoading;
    rzpLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = function () { rzpLoading = null; reject(new Error('Could not load the payment window. Check your connection.')); };
      document.head.appendChild(s);
    });
    return rzpLoading;
  }

  function payOnline(order, rz) {
    ck.result = null;
    return loadRazorpay().then(function () {
      var settled = false;
      var rzp = new window.Razorpay({
        key: rz.key_id, amount: rz.amount, currency: rz.currency, name: rz.name, description: rz.description,
        order_id: rz.order_id, prefill: rz.prefill, theme: { color: '#9c5530' },
        handler: function (resp) {
          settled = true;
          ck.busy = true; renderCheckout();
          api('/api/orders/' + encodeURIComponent(order.order_no) + '/verify-payment', { method: 'POST', body: resp })
            .then(function (d) { orderDone(d.order); })
            .catch(function (err) { ck.busy = false; ck.result = { kind: 'pending', order: order, message: err.message }; renderCheckout(); });
        },
        modal: { ondismiss: function () { if (!settled) { ck.busy = false; ck.result = { kind: 'pending', order: order }; renderCheckout(); } } }
      });
      rzp.on('payment.failed', function (resp) {
        settled = true;
        ck.busy = false;
        ck.result = { kind: 'pending', order: order, message: (resp.error && resp.error.description) || 'The payment failed.' };
        renderCheckout();
      });
      rzp.open();
    }).catch(function (err) {
      ck.busy = false; ck.result = { kind: 'pending', order: order, message: err.message }; renderCheckout();
    });
  }

  function retryPay() {
    var o = ck.result.order;
    api('/api/orders/' + encodeURIComponent(o.order_no) + '/retry-payment', { method: 'POST', body: { phone: (profile() || {}).phone } })
      .then(function (d) { payOnline(o, d.razorpay); })
      .catch(function (err) { ck.result.message = err.message; renderCheckout(); });
  }

  function switchCod() {
    var o = ck.result.order;
    api('/api/orders/' + encodeURIComponent(o.order_no) + '/switch-to-cod', { method: 'POST', body: { phone: (profile() || {}).phone } })
      .then(function (d) { orderDone(d.order); })
      .catch(function (err) { ck.result.message = err.message; renderCheckout(); });
  }

  // ------------------------------------------------------------------ tracking
  var tk = { order_no: '', phone: '', busy: false, error: '', data: null };

  function openTrack(orderNo, phone) {
    var last = store(LAST_ORDER_KEY) || {};
    var mine = (profile() || {}).phone || '';
    tk = { order_no: orderNo || tk.order_no || last.order_no || '', phone: phone || mine || tk.phone || (orderNo && orderNo !== last.order_no ? '' : last.phone) || '', busy: false, error: '', data: null };
    renderTrack();
    open($('#trackModal'));
    if (tk.order_no && tk.phone) lookup();
  }

  function renderTrack() {
    var d = tk.data;
    var result = '';
    if (d) {
      var idx = STATUS_FLOW.indexOf(d.status);
      result = '<div class="track-result">' +
        '<div class="track-head"><div><b>' + esc(d.order_no) + '</b><small>Placed ' + esc(fmtDate(d.created_at)) + ' · ' + inr(d.total) + ' · ' + esc(d.payment_label) + '</small></div>' +
        '<span class="status-pill ' + esc(d.status) + '">' + esc(d.status_label) + '</span></div>' +
        (d.status !== 'cancelled' ? '<div class="progress-steps">' + STATUS_FLOW.map(function (s, i) { return '<div class="' + (i <= idx ? 'done' : '') + '">' + STATUS_LABELS[s] + '</div>'; }).join('') + '</div>' : '') +
        (d.courier || d.tracking_no || d.tracking_url ? '<div class="courier-box">' + (d.courier ? '<b>' + esc(d.courier) + '</b>' : 'Shipment') + (d.tracking_no ? ' · Tracking no. ' + esc(d.tracking_no) : '') +
          (d.tracking_url && /^https?:\/\//i.test(d.tracking_url) ? '<br><a href="' + esc(d.tracking_url) + '" target="_blank" rel="noopener">Track with courier →</a>' : '') + '</div>' : '') +
        '<ul class="timeline">' + d.timeline.slice().reverse().map(function (e) { return '<li>' + esc(e.label) + '<small>' + esc(fmtDate(e.at)) + '</small></li>'; }).join('') + '</ul>' +
        '<div class="review-box">' + d.items.map(function (i) { return '<div class="sum-row"><span>' + i.qty + ' × ' + esc(i.name) + '</span><span>' + inr(i.line_total) + '</span></div>'; }).join('') +
        '<div class="sum-row"><span>Delivering to</span><span>' + esc(d.city + ', ' + d.pincode) + '</span></div></div></div>';
    }
    $('#trackModal .modal-card').innerHTML =
      '<div class="panel-head"><h3>Track your order</h3><button type="button" class="x-btn" data-close aria-label="Close">' + X_ICON + '</button></div>' +
      '<div class="modal-body">' + (tk.error ? '<div class="alert err" role="alert">' + esc(tk.error) + '</div>' : '') +
      '<form class="track-form" id="trackForm" novalidate>' +
        '<div class="field"><label for="tk-order">Order number</label><input id="tk-order" name="order_no" value="' + esc(tk.order_no) + '" placeholder="GM-261111-1234" autocomplete="off" autocapitalize="characters" maxlength="16"></div>' +
        '<div class="field"><label for="tk-phone">Mobile number</label><div class="prefix"><span>+91</span><input id="tk-phone" name="phone" value="' + esc(tk.phone) + '" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel-national"></div></div>' +
        '<button type="submit" class="btn btn-rust"' + (tk.busy ? ' disabled' : '') + '>' + (tk.busy ? '<span class="spinner"></span>' : 'Track') + '</button>' +
      '</form>' + result +
      '<p class="muted-note">Need help? <a href="' + esc(waLink('Hi! I need help with my order ' + (tk.order_no || ''))) + '" target="_blank" rel="noopener" style="text-decoration:underline">' + (hasWhatsApp() ? 'WhatsApp us' : 'Email us') + '</a></p>' +
      '</div>';
  }

  function lookup() {
    tk.order_no = String(tk.order_no).trim().toUpperCase();
    if (!/^GM-\d{6}-\d{4}$/.test(tk.order_no)) { tk.error = 'Order numbers look like GM-261111-1234.'; return renderTrack(); }
    if (!normPhone(tk.phone)) { tk.error = 'Enter the mobile number used for the order.'; return renderTrack(); }
    tk.busy = true; tk.error = ''; renderTrack();
    api('/api/track?order_no=' + encodeURIComponent(tk.order_no) + '&phone=' + encodeURIComponent(normPhone(tk.phone)))
      .then(function (d) { tk.data = d.order; store(LAST_ORDER_KEY, { order_no: tk.order_no, phone: normPhone(tk.phone) }); })
      .catch(function (err) { tk.data = null; tk.error = err.message; })
      .then(function () { tk.busy = false; renderTrack(); });
  }

  // ------------------------------------------------------------------ chrome (panels markup)
  function mountUi() {
    var html =
      '<div class="ui-overlay" id="uiOverlay" data-close></div>' +
      '<aside class="drawer" id="cartDrawer" role="dialog" aria-modal="true" aria-labelledby="cartTitle">' +
        '<div class="panel-head"><h3 id="cartTitle">Your cart</h3><button type="button" class="x-btn" data-close aria-label="Close cart">' + X_ICON + '</button></div>' +
        '<div class="drawer-body" id="cartBody"></div><div class="drawer-foot" id="cartFoot"></div></aside>' +
      '<div class="modal" id="checkoutModal" role="dialog" aria-modal="true" aria-labelledby="ckTitle"><div class="modal-card"></div></div>' +
      '<div class="modal" id="trackModal" role="dialog" aria-modal="true" aria-label="Track your order"><div class="modal-card"></div></div>' +
      '<div class="modal gallery-modal" id="galleryModal" role="dialog" aria-modal="true" aria-label="Product photos"><div class="modal-card"></div></div>' +
      '<div class="modal offer-modal" id="offerModal" role="dialog" aria-modal="true" aria-labelledby="offerPopTitle"></div>' +
      '<div class="toast" id="toast" role="status" aria-live="polite"></div>';
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  }

  // ------------------------------------------------------------------ events
  function bindEvents() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      var add = t.closest('[data-add]');
      if (add && !add.disabled) {
        e.preventDefault();
        if (add.closest('#offerModal')) closeAll();
        var parts = add.getAttribute('data-add').split(':');
        addToCart(parts[0], parts.slice(1).join(':'), 1);
        return;
      }
      if (t.closest('#cartBtn')) { e.preventDefault(); openCart(); return; }
      var buyNow = t.closest('[data-buynow]');
      if (buyNow && !buyNow.disabled) {
        e.preventDefault();
        var bp = buyNow.getAttribute('data-buynow').split(':');
        addToCart(bp[0], bp.slice(1).join(':'), 1);
        openCheckout();
        return;
      }
      var popt = t.closest('[data-popt]');
      if (popt) { pdp.option = popt.getAttribute('data-popt'); renderProductPage(); return; }
      var pimg = t.closest('[data-pimg]');
      if (pimg) { pdp.img = Number(pimg.getAttribute('data-pimg')) || 0; renderProductPage(); return; }
      if (t.closest('#acctBtn')) {
        e.preventDefault();
        location.href = '/account';
        return;
      }
      var gal = t.closest('[data-gallery]');
      if (gal) { e.preventDefault(); openGallery(gal.getAttribute('data-gallery'), Number(gal.getAttribute('data-gstart')) || 0); return; }
      var gnav = t.closest('[data-gnav]');
      if (gnav) { e.preventDefault(); showPhoto(gnav.getAttribute('data-gnav') === 'next' ? gi + 1 : gnav.getAttribute('data-gnav') === 'prev' ? gi - 1 : Number(gnav.getAttribute('data-gnav'))); return; }
      if (t.closest('#toCheckout')) { e.preventDefault(); openCheckout(); return; }
      var trackBtn = t.closest('[data-track]');
      if (trackBtn) { e.preventDefault(); openTrack(trackBtn.getAttribute('data-track')); return; }
      if (t.closest('[data-close]')) {
        if (t.closest('a[href]')) closeAll();
        else { e.preventDefault(); closeAll(); }
        return;
      }

      // cart lines
      var line = t.closest('.line');
      if (line) {
        var key = line.getAttribute('data-key').split(':');
        var item = cart.filter(function (i) { return i.type === key[0] && i.id === key.slice(1).join(':'); })[0];
        if (item && t.closest('[data-step]')) {
          item.qty = Math.max(1, Math.min(20, item.qty + Number(t.closest('[data-step]').getAttribute('data-step'))));
          saveCart();
        } else if (item && t.closest('[data-remove]')) {
          cart = cart.filter(function (i) { return i !== item; });
          saveCart();
        }
        return;
      }

      // checkout actions
      var ckBtn = t.closest('[data-ck]');
      if (ckBtn) {
        var act = ckBtn.getAttribute('data-ck');
        if (act === 'next') { if (validateStep(ck.step)) { saveDetails(); ck.step++; ck.error = ''; } renderCheckout(); }
        else if (act === 'back') { ck.step = Math.max(1, ck.step - 1); ck.fieldErrors = {}; renderCheckout(); }
        else if (act === 'place') placeOrder();
        else if (act === 'coupon') applyCoupon();
        else if (act === 'uncoupon') { ck.coupon = null; ck.couponTyped = ''; ck.couponError = ''; renderCheckout(); }
        else if (act === 'retry') retryPay();
        else if (act === 'cod') switchCod();
        else if (act === 'locate') startLocate();
        else if (act === 'unpin') { ck.values.lat = ck.values.lng = ck.values.accuracy = null; renderCheckout(); }
        else if (act === 'account') { closeAll(); location.href = '/account'; }
        else if (act === 'switch') { closeAll(); window.GomoAuth.signOut().then(openCheckout); }
        return;
      }
      var go = t.closest('[data-goto]');
      if (go) { ck.step = Number(go.getAttribute('data-goto')); renderCheckout(); return; }
    });

    document.addEventListener('input', function (e) {
      var f = e.target.closest('#checkoutModal [name]');
      if (f && f.name !== 'addr_choice' && f.name !== 'payment_method') {
        ck.values[f.name] = f.value;
        var wrap = f.closest('.field');
        if (wrap && wrap.classList.contains('invalid')) { wrap.classList.remove('invalid'); delete ck.fieldErrors[f.name]; }
        if (f.name === 'pincode') pinAutofill(f.value, function (d) {
          var city = $('#ck-city'), st = $('#ck-state');
          if (city && !city.value && d.city) { city.value = d.city; ck.values.city = d.city; }
          if (st && !st.value && d.state) { st.value = d.state; ck.values.state = d.state; }
        });
        return;
      }
      var tf = e.target.closest('#trackForm [name]');
      if (tf) tk[tf.name] = tf.value;
    });

    document.addEventListener('change', function (e) {
      var r = e.target.closest('#checkoutModal input[name="payment_method"]');
      if (r) { ck.values.payment_method = r.value; renderCheckout(); }
      var ac = e.target.closest('#checkoutModal input[name="addr_choice"]');
      if (ac) { ck.addr = ac.value; ck.fieldErrors = {}; renderCheckout(); }
      if (e.target.id === 'ckSave') ck.saveAddr = e.target.checked;
      var s = e.target.closest('#checkoutModal select[name]');
      if (s) ck.values[s.name] = s.value;
    });

    document.addEventListener('submit', function (e) {
      if (e.target.id === 'trackForm') { e.preventDefault(); lookup(); }
    });

    document.addEventListener('keydown', function (e) {
      if (openPanel && openPanel.id === 'galleryModal') {
        if (e.key === 'ArrowRight') { showPhoto(gi + 1); return; }
        if (e.key === 'ArrowLeft') { showPhoto(gi - 1); return; }
      }
      if (e.key === 'Escape' && openPanel) closeAll();
      if (e.key === 'Enter' && e.target.closest('#checkoutModal input')) {
        e.preventDefault();
        var next = $('#checkoutModal [data-ck="next"], #checkoutModal [data-ck="place"]');
        if (next) next.click();
      }
    });

    function onHash() {
      var h = location.hash;
      // old links to product cards (#p-candle) now go to the product page
      var legacy = /^#p-([\w-]+)$/.exec(h);
      var legacyP = legacy && catalog.products.filter(function (p) { return p.id === legacy[1]; })[0];
      if (legacyP) { location.replace(productUrl(legacyP)); return; }
      // the product list moved from the home page to /shop
      if (ROUTE.view === 'home' && (h === '#shop' || h === '#products')) { location.replace('/shop'); return; }
      if (/^#track/.test(h)) openTrack(decodeURIComponent(h.split('/')[1] || '').toUpperCase() || null);
      else if (h === '#cart') { openCart(); history.replaceState(null, '', location.pathname + location.search); }
      else if (h === '#account') {
        history.replaceState(null, '', location.pathname + location.search);
        location.replace('/account');
      }
    }
    window.addEventListener('hashchange', onHash);
    onHash();
  }

  // ------------------------------------------------------------------ page interactions (nav, reveal, sliders)
  function pageInteractions() {
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('vis'); io.unobserve(en.target); } });
      }, { threshold: 0.12 });
      setTimeout(function () { $$('.hero .r').forEach(function (el) { el.classList.add('vis'); }); }, 60);
    } else {
      document.documentElement.classList.add('no-io');
    }

    var nav = $('#nav'), burger = $('#burger');
    window.addEventListener('scroll', function () { nav.classList.toggle('scrolled', window.scrollY > 30); }, { passive: true });
    burger.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = document.body.classList.toggle('nav-open');
      burger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.nav') || e.target.closest('.menu a')) {
        document.body.classList.remove('nav-open');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
    var links = $$('.menu > li > a');
    var setActive = function (href) { links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === href); }); };
    if (ROUTE.view === 'shop' || ROUTE.view === 'product' || ROUTE.view === 'offer') setActive('/shop');
    else if (ROUTE.view === 'policy' || ROUTE.view === 'account') setActive('');
    else {
      var spy = [['story', '/#story'], ['offers', ''], ['order', '']];
      window.addEventListener('scroll', function () {
        var current = '/';
        spy.forEach(function (s) { var el = document.getElementById(s[0]); if (el && el.getBoundingClientRect().top < 140) current = s[1]; });
        setActive(current);
      }, { passive: true });
    }

    if ($('.season')) {
      $('#seasonPrev').addEventListener('click', function () { showSeason(si - 1); });
      $('#seasonNext').addEventListener('click', function () { showSeason(si + 1); });
      seasonTimer = setInterval(function () { showSeason(si + 1); }, 5000);
      $('.season').addEventListener('mouseenter', function () { clearInterval(seasonTimer); });
    }
  }

  // ------------------------------------------------------------------ product photo gallery
  var gp = null, gi = 0, touchX = null;
  function openGallery(pid, i) {
    gp = prodById[pid];
    if (!hasPhoto(gp)) return;
    renderGallery();
    open($('#galleryModal'));
    showPhoto(i || 0);
  }
  function renderGallery() {
    var imgs = gp.images;
    $('#galleryModal .modal-card').innerHTML =
      '<div class="panel-head"><h3>' + esc(gp.name) + '</h3><button type="button" class="x-btn" data-close aria-label="Close">' + X_ICON + '</button></div>' +
      '<div class="gallery-stage">' + imgs.map(function (img, n) { return '<figure class="g-slide" data-n="' + n + '"' + (n ? ' hidden' : '') + '>' + photoImg(img, { big: true, alt: gp.name, eager: n === 0 }) + (img.alt ? '<figcaption>' + esc(img.alt) + '</figcaption>' : '') + '</figure>'; }).join('') +
        (imgs.length > 1 ? '<button type="button" class="g-nav prev" data-gnav="prev" aria-label="Previous photo">‹</button><button type="button" class="g-nav next" data-gnav="next" aria-label="Next photo">›</button>' : '') + '</div>' +
      (imgs.length > 1 ? '<div class="g-thumbs">' + imgs.map(function (img, n) { return '<button type="button" data-gnav="' + n + '" aria-label="Photo ' + (n + 1) + '">' + photoImg(img, { cls: 'photo', sizes: '72px' }) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="g-foot"><span class="price">' + (buyable(gp) ? inr(gp.price) : 'Ask us') + '</span>' +
        (buyable(gp) && gp.in_stock ? '<button type="button" class="btn btn-rust" data-add="product:' + esc(gp.id) + '">Add to cart ' + ARROW + '</button>' : '') + '</div>';
    var stage = $('#galleryModal .gallery-stage');
    stage.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (touchX == null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 40) showPhoto(dx < 0 ? gi + 1 : gi - 1);
    }, { passive: true });
  }
  function showPhoto(n) {
    if (!gp) return;
    var count = gp.images.length;
    gi = (n + count) % count;
    $$('#galleryModal .g-slide').forEach(function (s) { s.hidden = Number(s.getAttribute('data-n')) !== gi; });
    $$('#galleryModal .g-thumbs button').forEach(function (b, k) { b.classList.toggle('on', k === gi); b.setAttribute('aria-current', k === gi ? 'true' : 'false'); });
  }

  // ------------------------------------------------------------------ boot
  window.GomoShop = {
    catalogReady: function () { return Promise.race([catalogReadyP, new Promise(function (r) { setTimeout(r, 4000); })]); },
    hideLoader: function () { hideLoader(true); },
    api: api, open: open, closeAll: closeAll, toast: toast, esc: esc, inr: inr, fmtDate: fmtDate, openTrack: openTrack,
    STATES: STATES, catalog: function () { return catalog; }, pinAutofill: pinAutofill, validateAddress: validateAddressValues,
    waOrderLink: function () { return waLink(waOrderText(totals())); }
  };
  document.addEventListener('gomo-auth-ready', function () {
    window.GomoAuth.on(function () {
      if (openPanel && openPanel.id === 'checkoutModal' && !ck.result && !profile()) closeAll();
    });
  });
  function refreshCatalog() {
    if (!API || /REPLACE_WITH/.test(API)) { catalogFailed = true; catalogSettled(); renderProductPage(); renderOfferPage(); return Promise.resolve(); }
    return api('/api/catalog', { timeout: 8000 }).then(function (data) {
      catalog = data;
      live = true;
      data.saved_at = Date.now();
      store(CATALOG_KEY, data);
      indexCatalog();
      // drop cart lines that no longer exist
      cart = cart.filter(function (i) { return resolve(i); });
      store(CART_KEY, cart);
      renderAll();
      catalogSettled();
      maybeOfferPopup();
      if (openPanel && openPanel.id === 'checkoutModal' && !ck.result) renderCheckout();
    }).catch(function (err) {
      catalogFailed = true;
      catalogSettled();
      renderProductPage();
      renderOfferPage();
      console.warn('GoMo: using built-in catalog —', err.message);
    });
  }

  // the path picks the view (see ROUTE); everything else is the home page
  var policyPage = ROUTE.view === 'policy' && $('#policyView [data-policy="' + ROUTE.page + '"]');
  if (ROUTE.view === 'policy' && !policyPage) ROUTE = { view: 'home' };
  if (ROUTE.view !== 'home') {
    // a browser may still hold an older index.html without the view this route needs: add it
    if (ROUTE.view === 'account' && !$('#accountView')) {
      var av = document.createElement('main');
      av.id = 'accountView';
      av.hidden = true;
      $('#homeView').parentNode.insertBefore(av, $('#homeView').nextSibling);
    }
    if (ROUTE.view === 'shop' && !$('#shopView')) {
      var sv = document.createElement('main');
      sv.id = 'shopView';
      sv.hidden = true;
      $('#homeView').parentNode.insertBefore(sv, $('#homeView').nextSibling);
    }
    var viewEl = $({ shop: '#shopView', product: '#productView', offer: '#productView', policy: '#policyView', account: '#accountView' }[ROUTE.view]);
    document.documentElement.classList.add('route-' + ROUTE.view);
    $('#homeView').hidden = true;
    if (viewEl) viewEl.hidden = false;
  }
  if (policyPage) {
    policyPage.hidden = false;
    document.title = policyPage.getAttribute('data-title') + ' \u2014 GoMo Candles';
    var pcl = $('link[rel="canonical"]');
    if (pcl) pcl.setAttribute('href', PRIMARY_ORIGIN + (ROUTE.page === 'terms' ? '/terms' : '/' + ROUTE.page + '-policy'));
  }
  if (live || savedCatalog()) catalogSettled();
  setTimeout(catalogSettled, 9000);   // never leave prices hidden

  mountUi();
  pageInteractions();
  bindEvents();
  renderAll();
  refreshCatalog();
  if (savedCatalog()) maybeOfferPopup();
})();
