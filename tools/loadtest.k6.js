// Load test for GoMo with k6 (https://k6.io):  brew install k6
//
// SAFE BY DEFAULT: only reads (home page, catalog, states, a product page, tracking with a fake order).
// It never signs in, never sends codes and never places orders, so it costs no SMS and creates no data.
//
//   k6 run tools/loadtest.k6.js                                  # smoke: 20 users for 1 minute
//   k6 run -e PROFILE=load   tools/loadtest.k6.js                # ramp to 10,000 users over 30 minutes
//   k6 run -e PROFILE=spike  tools/loadtest.k6.js                # 0 → 5,000 users in 60 seconds (sale start)
//   k6 run -e PROFILE=soak   tools/loadtest.k6.js                # 2,000 users for 4 hours
//
// Point it at a STAGING copy for the big profiles (a second Worker + Firebase project), not the live shop:
//   k6 run -e PROFILE=load -e SHOP=https://staging.example -e API=https://gomo-api-staging.workers.dev tools/loadtest.k6.js
// Watch Cloudflare (Workers → gomo-api → Metrics) and Firebase (Realtime Database → Usage) while it runs.
// Note: the API rate-limits per IP, so from one machine you will (correctly) see 429s on /api/track.
import http from 'k6/http';
import { check, sleep, group } from 'k6';

const SHOP = __ENV.SHOP || 'https://gomo.earthenbeauty.in';
const API = __ENV.API || 'https://gomo-api.soumalya9862.workers.dev';
const PROFILES = {
  smoke: [{ duration: '1m', target: 20 }],
  load: [{ duration: '10m', target: 3000 }, { duration: '10m', target: 10000 }, { duration: '10m', target: 10000 }, { duration: '2m', target: 0 }],
  spike: [{ duration: '1m', target: 5000 }, { duration: '3m', target: 5000 }, { duration: '1m', target: 0 }],
  stress: [{ duration: '5m', target: 5000 }, { duration: '5m', target: 15000 }, { duration: '5m', target: 25000 }, { duration: '2m', target: 0 }],
  soak: [{ duration: '5m', target: 2000 }, { duration: '4h', target: 2000 }, { duration: '2m', target: 0 }],
};

export const options = {
  stages: PROFILES[__ENV.PROFILE || 'smoke'],
  thresholds: {
    'http_req_failed{kind:read}': ['rate<0.005'],          // < 0.5% errors
    'http_req_duration{kind:read}': ['p(95)<1000'],        // p95 under 1 s
    'http_req_duration{name:catalog}': ['p(95)<500'],
  },
};

const ORIGIN = { headers: { origin: SHOP } };

export default function () {
  group('browse', () => {
    const home = http.get(`${SHOP}/`, { tags: { kind: 'read', name: 'home' } });
    check(home, { 'home 200': (r) => r.status === 200 });
    const cat = http.get(`${API}/api/catalog`, { ...ORIGIN, tags: { kind: 'read', name: 'catalog' } });
    check(cat, { 'catalog 200': (r) => r.status === 200, 'catalog has products': (r) => (r.json('products') || []).length > 0 });
    sleep(Math.random() * 3 + 1);
    const prod = http.get(`${SHOP}/product/evil-eye-candle`, { tags: { kind: 'read', name: 'product' } });
    check(prod, { 'product 200': (r) => r.status === 200 });
    sleep(Math.random() * 4 + 2);
  });
  if (Math.random() < 0.1) {
    group('track', () => {
      const r = http.get(`${API}/api/track?order_no=GM-000000-0000&phone=9000000000`, { ...ORIGIN, tags: { name: 'track' } });
      check(r, { 'track answers 404 or 429': (x) => x.status === 404 || x.status === 429 });
    });
  }
  sleep(Math.random() * 5 + 3);
}
