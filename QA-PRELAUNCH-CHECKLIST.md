# GoMo Candles: pre-launch QA checklist

**Scope:** shop (gomo.earthenbeauty.in), admin (gomoadmin.web.app), API (Cloudflare Worker `gomo-api`), Firebase Realtime Database and Firebase Auth, Razorpay, Shiprocket, email (Postal), WhatsApp (OpenWA) and SMS.
**Target:** 10,000 concurrent users, with heavy sign-in and order traffic.
**How "Implemented?" was decided:** by reading this repository's code on 22 Nov 2026. "Yes" means the code exists, not that it has been load-tested or verified in production. Every row still needs to be run.

## Launch blockers (fix or decide before launch)

| # | Issue | Why it matters at 10K users |
|---|---|---|
| 1 | Razorpay Key Secret is rejected ("Authentication failed") | Every online payment fails. |
| 2 | SMS sign-in codes are capped at **300 per day** for the whole store (`daily_sms_cap`) | Heavy sign-in traffic uses this up within hours, then SMS codes stop for everyone. |
| 3 | Rate limits are per IP (10 orders/hour, 10 codes/hour) | Indian mobile networks put thousands of users behind one shared IP (CGNAT). Real customers get "Too many orders" or "Too many codes". |
| 4 | The rate limiter **fails open** under contention (`db.js` `rateLimit` returns `true` after 3 failed retries) | Under an attack, the limit stops working exactly when it is needed. |
| 5 | The catalog is read from the database on **every** request (`loadCatalog`), with only a 30-second browser cache | 10K visitors means about 3 database reads each. The database becomes the bottleneck and cost driver. |
| 6 | **No load test has ever been run** | Database connection and throughput limits, and Worker CPU limits, are unknown. |
| 7 | When an offer countdown ends, **every open tab reloads at the same second** (`tickCountdowns`) | This creates a self-made traffic spike at the moment a sale ends. |
| 8 | No self-service account deletion or data export; no consent notice under India's DPDP Act | This is a legal and compliance exposure. |
| 9 | Admin lists only scan the **newest 1,000 orders** (`ADMIN_SCAN_LIMIT`) | After 1,000 orders, older orders cannot be found by admin search or filters. |
| 10 | Retry-payment and switch-to-COD need only order number + phone and have no rate limit | Order numbers can be guessed, which leaks customer name and email. |

### Fixed and deployed on 22 Nov 2026
- **#3:** per-IP limits raised for shared mobile networks: orders 60/hour per IP (still 10 per account); sign-in codes 40/hour and 150/day per IP (still 5/hour per phone).
- **#4:** the rate limiter no longer fails open under contention.
- **#5:** the public catalog is built at most once every 15 seconds per server instance. Orders still read live prices and stock.
- **#7:** when an offer ends, open tabs reload spread over about 1.5 minutes.
- **#8:** My Account → Your data has "Download my data" and "Delete my account". Checkout says that placing an order means agreeing to the Terms and Privacy policy.
- **#9:** admin search finds any order by exact order number or 10-digit phone; a "from" date loads every order since that day.
- **#10:** retry-payment and switch-to-COD are rate limited (30/hour per IP, 10/hour per order).
- **Mobile:** on touch screens the cart +/−, header icons, menu and text links have tap areas of at least 40–44 px.
- **Load test:** `tools/loadtest.k6.js` is added (read-only by default). It has not been run yet.

**Still open:** #1 Razorpay keys, #2 the SMS daily cap (change it in Admin → Settings → Sign-in), and #6 running the load test.

## Checklist

| Area | Test Scenario | Expected Result | Priority | Implemented? | Notes |
|---|---|---|---|---|---|
| **1. Gateway & APIs** | CORS: request from a site that isn't on the allow-list | Browser blocks it; no `access-control-allow-origin` header | High | Yes | `ALLOWED_ORIGINS` in wrangler.toml. Remove the localhost entries before launch. |
| 1. Gateway & APIs | Rate limit: place 11 orders in 1 hour from one account | 11th returns 429 with a friendly message | High | Yes | `order:u:{uid}`, 10/hour |
| 1. Gateway & APIs | Rate limit: 50 different customers ordering from one shared mobile IP (CGNAT) | All succeed | High | **No** | The per-IP limit of 10/hour blocks real users. Raise it, or key it on IP plus account. |
| 1. Gateway & APIs | Rate limit: 500 parallel requests on one limit key | Limit still holds | High | **No** | `rateLimit` gives up after 3 retries and **allows** the request (fails open). |
| 1. Gateway & APIs | Sign-in code limits: 6 codes for one phone in 1 hour | 6th refused with 429 and a "wait" message | High | Yes | 5/hour, 10/day per phone, 10/hour per IP, plus a resend cooldown |
| 1. Gateway & APIs | Sign-in code requests from 1,000 different phones (SMS bombing / cost attack) | Blocked by CAPTCHA or caps | High | Partial | Turnstile exists but only works if `TURNSTILE_ENFORCE=1` is set; check it is on. |
| 1. Gateway & APIs | Daily SMS cap reached | Customers fall back to WhatsApp or email, with a clear message | High | Partial | Cap is 300/day, far too low for 10K users. Raise it and set up billing alerts. |
| 1. Gateway & APIs | Order tracking enumeration: 100 lookups from one IP | Rate limited | High | Yes | `track:{ip}` |
| 1. Gateway & APIs | Retry-payment / switch-to-COD enumeration | Rate limited; no personal data in errors | High | **No** | Known finding; add a rate limit and require sign-in. |
| 1. Gateway & APIs | Timeouts when Razorpay, OpenWA, SMS or Shiprocket is slow | API answers within ~15 seconds with a clear error; order not lost | High | Partial | geo, sms and notify have timeouts. Check that Razorpay order creation and Shiprocket calls do too. |
| 1. Gateway & APIs | Client timeout and retry: shop `api()` gets no answer | 15-second timeout, then "Could not reach our server"; nothing double-submitted | High | Yes | Orders carry an idempotency key |
| 1. Gateway & APIs | Error format: every 4xx/5xx returns JSON `{error}`; 500 never leaks a stack trace | Consistent and safe | Med | Yes | Generic 500 message in `index.js` |
| 1. Gateway & APIs | Wrong method or unknown route | 404/405 JSON, not HTML | Low | Yes | Verify |
| 1. Gateway & APIs | Oversized request body (e.g. a 5 MB order) | 413/400, Worker doesn't crash | Med | Yes | `readJson` has size caps; verify every route |
| 1. Gateway & APIs | Authentication: missing, expired, tampered or other-project Firebase token | 401 | High | Yes | RS256 signature, issuer, audience, expiry checked in `auth.js` |
| 1. Gateway & APIs | Revoked user (password changed or account disabled in Firebase) uses an old token | Rejected | Med | Partial | Disabled profiles are blocked; Firebase revocation isn't checked, so tokens live up to 1 hour |
| 1. Gateway & APIs | API versioning: old cached `shop.js` talks to a new API after a deploy | Still works, or the page refreshes | Med | **No** | No `/v1`. Keep changes backward compatible; `shop.js` is served `no-cache`. |
| 1. Gateway & APIs | 10,000 concurrent `GET /api/catalog` | p95 under 500 ms, no 5xx | High | **No** | No server cache. Add a Workers Cache API or memory cache of 30–60 s. |
| 1. Gateway & APIs | 2,000 concurrent `POST /api/orders` | No 5xx; each order created exactly once | High | **No** | Not load-tested. Each order makes about 15 database calls. |
| 1. Gateway & APIs | Webhook endpoint under burst (Razorpay retries) | Every event processed once; 2xx returned fast | High | Yes | Signature checked; marking paid is compare-and-set |
| 1. Gateway & APIs | Health check | `/api/health` 200; admin health shows each integration | Med | Yes | Razorpay currently fails the check |
| **2. Data** | Two customers buy the **last unit** at the same second | One succeeds; the other gets "just sold out"; stock never negative | High | Yes | Compare-and-set in `stock.js`. Test with 50 parallel buyers. |
| 2. Data | 200 buyers on one popular product (heavy contention) | All valid orders succeed while stock lasts | High | Partial | `adjust` retries 8 times, then says "sold out" even when stock remains. Load-test this. |
| 2. Data | Same order submitted twice (double click, retry) | One order | High | Yes | Idempotency key per checkout |
| 2. Data | Coupon "1 per customer" or "first order only" used in 5 parallel orders | Only 1 gets the discount | High | **No** | Known finding: only the overall usage limit is atomic |
| 2. Data | Coupon edited by admin while being used | Usage count not reset | Med | **No** | Known finding |
| 2. Data | Admin saves a product while orders come in | Live stock not overwritten | High | Yes | Fixed: stock is only sent if changed |
| 2. Data | Order cancelled twice at once (admin + customer) | Stock returned once | High | Yes | `releaseHeldStock` is compare-and-set |
| 2. Data | Unpaid online order left for 30+ minutes | Auto-cancelled; stock and coupon returned | High | Yes | Runs every 30 minutes |
| 2. Data | Payment arrives after auto-cancel | Order restored if stock allows, otherwise flagged for refund | High | Yes | |
| 2. Data | Prices: browser sends a tampered price, total or shipping | Server recomputes everything | High | Yes | `priceCart` and the shipping rule are server-side |
| 2. Data | Pack price applied automatically in the cart matches the server | Same total on both | High | Yes | Cart sends packs as offer lines |
| 2. Data | Validation: name, phone, pincode, state, address length, emoji, HTML | Rejected or cleaned with field errors | High | Yes | `validate.js`; test every field |
| 2. Data | Invoice numbers are continuous (GST) | No gaps or duplicates | Med | Partial | Numbers can be skipped on a race or failure (known finding) |
| 2. Data | Daily backup runs | New backup file in S3 every IST day | High | Yes | `runBackup` on the cron |
| 2. Data | **Restore drill**: restore yesterday's backup into a test project | Shop works with the restored data | High | **No** | Restore is a manual Firebase console import; never rehearsed. Write down the steps and timing. |
| 2. Data | Backup contains personal data | Stored encrypted; owner-only access | High | Partial | Owner-only download. Check S3 bucket encryption and access policy. |
| 2. Data | Time zones: order numbers, date filters, reports at 23:59 / 00:01 IST | Correct IST day | Med | Yes | |
| **3. Privacy** | Privacy policy page exists and matches reality (WhatsApp, SMS, email, Razorpay, Shiprocket, Google fonts and sign-in) | Accurate and complete | High | Partial | `/privacy-policy` exists. Review that every data processor is named. |
| 3. Privacy | Terms, shipping and returns pages exist; linked in footer and at checkout | Yes | High | Yes | |
| 3. Privacy | Consent notice at sign-up and checkout (India DPDP Act 2023) | Clear notice; link to policy; consent recorded | High | **No** | No consent checkbox or log |
| 3. Privacy | Cookie banner | Needed only if non-essential cookies or trackers are used | Med | N/A | No analytics or ads trackers found; only essential storage (cart, sign-in). Re-check before adding any. |
| 3. Privacy | Customer deletes their account | Personal data erased or anonymised; orders kept for tax law | High | **No** | Policy says "email us". Add a request flow and an admin "delete customer" action. |
| 3. Privacy | Customer exports their data | Download of profile, addresses, orders | Med | **No** | |
| 3. Privacy | Grievance officer / contact named (DPDP) | Name and email in the policy | Med | Partial | Support email present; check a named contact |
| 3. Privacy | WhatsApp / SMS marketing opt-in and opt-out | Only order messages without consent | Med | Partial | Order messages only; confirm no marketing |
| 3. Privacy | Personal data in logs (`console.log`) | No phone numbers, addresses or codes in Worker logs | Med | Partial | Review the logs from one test order |
| **4. Security** | Password storage | Never stored by us; Firebase Auth uses scrypt | High | Yes | Handled by Firebase |
| 4. Security | Password rules: min 8; common passwords | Weak ones rejected | Med | Partial | Min length 8; turn on Firebase password policy |
| 4. Security | Sign-in codes: hashed, single use, 5 tries then lockout, expiry | All true | High | Yes | |
| 4. Security | Tokens kept in Firebase storage, sent as Bearer header | No auth cookies, so **CSRF doesn't apply** | High | Yes | |
| 4. Security | Injection: SQL | Not applicable (no SQL); database paths cleaned with `safeKey` | High | Yes | Test `../`, `.`, `#`, `$` in ids and order numbers |
| 4. Security | XSS: product names, addresses, notes, coupon codes, offer text with `<script>` | Shown as text everywhere (shop, admin, emails, invoice, WhatsApp) | High | Yes | `esc()` used throughout; reviewers found no gaps. Test each screen. |
| 4. Security | Content-Security-Policy header | Present; scripts limited to own domain, Firebase, Razorpay, fonts | Med | **No** | Only X-Frame-Options and Referrer-Policy are set |
| 4. Security | HTTPS everywhere; HSTS | HTTP redirects to HTTPS; HSTS header on the custom domain | High | Partial | Firebase Hosting forces HTTPS; check HSTS on gomo.earthenbeauty.in |
| 4. Security | Encryption at rest | Firebase, Cloudflare and S3 encrypt by default | Med | Yes | Check that S3 bucket encryption is on |
| 4. Security | Database rules | Direct browser reads and writes denied | High | Yes | `.read/.write: false`; only the API (service account) has access |
| 4. Security | Secrets | Not in git; `.secrets` git-ignored; rotation plan | High | Partial | Razorpay secret needs rotation now |
| 4. Security | Admin login: email must be verified; only owner emails or invited staff | Others get 403 | High | Yes | `requireAdmin` |
| 4. Security | Admin two-factor authentication | On for the owner and staff | High | **No** | Turn on multi-factor in Firebase Auth, or require Google accounts with 2-step verification |
| 4. Security | Staff can't change custom SMS gateway, payments or team | 403 | High | Yes | Fixed today |
| 4. Security | Admin action audit log | Who changed prices, stock, refunds, status | Med | Partial | Order events record the actor; check product and settings changes |
| 4. Security | File / photo upload: type, size, name, path | Only images and allowed types; size cap; no path tricks | High | Partial | Prefix allow-list exists; verify a size cap and SVG/HTML refusal |
| 4. Security | Dependency / CDN scripts | Pinned versions (Firebase SDK, Motion) | Low | Partial | |
| **5. Payments** | Online payment success (UPI, card, netbanking, wallet) | Order paid; one confirmation message | High | **No** | Blocked: Razorpay key secret invalid |
| 5. Payments | Payment failure (card declined) | Order stays unpaid; "Try again" and "Pay with COD" shown | High | Yes | Test after fixing keys |
| 5. Payments | Customer closes the payment window | Order pending; can retry; auto-cancelled after 30 minutes | High | Yes | |
| 5. Payments | Paid, but the browser closes before returning | Webhook marks it paid | High | Yes | Webhook secret deployed; test with Razorpay's test webhook |
| 5. Payments | Webhook arrives twice or before the browser | Paid once; one notification | High | Yes | Compare-and-set in `markPaid` |
| 5. Payments | **Double charge**: customer pays two attempts (retry after a slow first one) | Second payment detected; refund flagged | High | Partial | `refunds.js` payment check exists. Test both attempts being captured. |
| 5. Payments | Amount differs from the order total | Flagged on the order | High | Yes | `markPaid` notes the mismatch |
| 5. Payments | Refund: admin "Process refund" | Razorpay refund created once (idempotent); status updates | High | Yes | `refunds.js`; test partial and full refunds |
| 5. Payments | Customer cancels a paid order | Refund marked for review; admin banner | High | Yes | |
| 5. Payments | Free prepaid delivery vs COD charge | Correct charge per method; switching to COD adds it | High | Yes | |
| 5. Payments | Coupon + prepaid + pack together | Server total equals the cart total | High | Yes | Test combinations |
| 5. Payments | PCI DSS | Card data never touches our servers (Razorpay Checkout) | High | Yes | SAQ-A level; keep it that way |
| 5. Payments | Switch to live mode | Live keys, live webhook and secret, KYC done | High | **No** | Separate live webhook secret needed |
| 5. Payments | COD: deliver, collect cash, mark paid | Dashboard "COD to collect" correct | Med | Yes | |
| **6. Access control** | Customer A opens customer B's order (cancel, track, invoice) | 404 / refused | High | Yes | Cancel checks `uid`; tracking needs the phone |
| 6. Access control | Customer calls an admin endpoint | 401/403 | High | Yes | |
| 6. Access control | Each staff role only sees allowed admin pages and API routes | Others 403; menu hidden | High | Yes | `requireArea`; test every role × page |
| 6. Access control | Packer role can't change payments or refunds | 403 | High | Yes | `payments_edit` area |
| 6. Access control | Removing staff takes effect | Next request 403 | High | Partial | Up to 1 hour of existing token life; check `requireAdmin` reloads staff each request |
| 6. Access control | Session expiry: customer idle for days | Silent refresh, or asked to sign in at checkout | Med | Yes | Firebase refresh tokens |
| 6. Access control | Admin idle timeout on a shared computer | Auto sign-out after N minutes | Med | **No** | Add an idle sign-out |
| 6. Access control | Sign out on one device | Other devices keep working (expected) | Low | Yes | Document it |
| **7. Performance** | **Load**: 10,000 users over 30 minutes (browse 70%, sign in 20%, order 10%) | p95 < 1 s; error rate < 0.5% | High | **No** | Use k6 or Artillery against a staging Worker and a separate Firebase project |
| 7. Performance | **Spike**: 0 → 5,000 users in 60 seconds (sale start / countdown end) | No 5xx; queueing at most | High | **No** | Countdown end reloads all tabs at once; spread it with random jitter |
| 7. Performance | **Stress**: increase until it breaks | Find the breaking point; it fails cleanly with 503s | High | **No** | Record the limit |
| 7. Performance | **Endurance**: 2,000 users for 4 hours | No slowdown; rate-limit and OTP records don't pile up | Med | **No** | `rate_limits/` and `otp/` records need cleanup; check |
| 7. Performance | Firebase database limits | Plan (Blaze) and concurrent / throughput limits understood | High | Partial | Check the plan, connection and write limits, and budget alerts |
| 7. Performance | Cloudflare Worker limits | Paid plan; CPU time per request; subrequest limit (orders make many calls) | High | Partial | Check the plan; on the free plan, 50 subrequests can be hit |
| 7. Performance | Media and images | Served with long cache; WebP; sized | Med | Yes | 7-day cache on `assets/img` |
| 7. Performance | Page weight and Lighthouse (mobile) | Home LCP < 2.5 s on 4G | Med | Partial | Not measured; `index.html` is ~90 KB plus fonts |
| 7. Performance | Story page frames (17 MB) | Lazy and progressive; small set on phones | Med | Yes | Only if frames are deployed |
| 7. Performance | Notifications under load (WhatsApp via OpenWA, email via Postal) | Queue, not timeouts; order not slowed | High | Partial | Sent in the background; OpenWA is unofficial and may be rate-limited or banned at volume |
| **8. Pagination** | Shop / home product grid (4 products, 4 offers) | No pagination needed; lazy-load images below the fold | Low | Yes | Revisit at 20+ products |
| 8. Pagination | /shop page | Shows **all** products and packs | Med | **No** | Shows only the first combo and 3 products (known finding) |
| 8. Pagination | Product photo gallery | Lazy-load non-visible photos | Low | Yes | |
| 8. Pagination | Story page frames | Progressive loading (already) | Low | Yes | |
| 8. Pagination | Customer "My orders" | Paginate or "Load more" after 20 | Med | Partial | Only newest 50 returned, no older pages |
| 8. Pagination | Customer saved addresses | No pagination (max 5) | Low | Yes | |
| 8. Pagination | Admin orders list | Server-side pagination over **all** orders, with search | High | Partial | Pages exist but only over the newest 1,000 orders; older ones can't be found |
| 8. Pagination | Admin customers list | Server-side pagination and search | High | Partial | Capped scan (`CUSTOMER_SCAN`) |
| 8. Pagination | Admin notifications / messages | Paginate | Med | Partial | Last 1,000 only |
| 8. Pagination | Admin products / offers / coupons | Not needed (small sets) | Low | Yes | |
| 8. Pagination | Admin dashboard stats | Computed on recent orders; fine | Low | Partial | Stats beyond 1,000 orders are incomplete |
| 8. Pagination | Admin CSV export | All orders in a date range, streamed | Med | Partial | Check the export isn't limited to 1,000 rows |
| **9. UI states** | Catalog loading (first visit, slow 3G) | Branded loader; prices hidden until real prices are known | High | Yes | `catalog-pending` |
| 9. UI states | API down | Built-in catalog shown; checkout shows a clear error | High | Yes | Built-in prices must match the admin; check it can't sell at stale prices |
| 9. UI states | Empty cart | Empty state and a "Browse products" link | Med | Yes | |
| 9. UI states | Unavailable item in cart | Marked; checkout blocked until removed | High | Yes | |
| 9. UI states | Unknown product or combo URL | Friendly 404 | Med | Yes | |
| 9. UI states | My orders: loading / empty / error | Each has a message | Med | Yes | |
| 9. UI states | Order tracking: wrong number or phone | Clear "not found" | Med | Yes | |
| 9. UI states | Cart shipping before choosing payment | "Chosen at payment" with both prices | Med | Yes | |
| 9. UI states | Out-of-stock and low-stock labels | "Sold out", "Only N left" | Med | Yes | |
| 9. UI states | Content consistency: prices, MRP and savings match across home, shop, product, cart, invoice, WhatsApp, email | Identical | High | Partial | Check after every price change |
| 9. UI states | Admin: every list has empty / loading / error states | Yes | Med | Partial | Spot-check each view |
| 9. UI states | Spam-folder reminder on email code | Shown next to Resend | Low | Yes | |
| **10. Mobile** | Touch targets ≥ 44×44 px (Apple) / 48 dp (Android) | All buttons and links | High | **No** | Cart stepper buttons are 30 px; header icons 22 px; text links are 0.76 rem. Enlarge their tap areas. |
| 10. Mobile | Checkout on 320–360 px wide screens (iPhone SE, small Android) | No sideways scroll; buttons reachable | High | Partial | Test |
| 10. Mobile | On-screen keyboard covers inputs (address, code boxes) | Field scrolls into view; "Next" reachable | High | Partial | Test on iOS Safari and Android Chrome |
| 10. Mobile | Primary action reachable with the thumb (Add to cart, Checkout, Pay) | Bottom area or sticky | Med | Partial | Cart footer is sticky; check product page |
| 10. Mobile | Landscape phone and tablet | Layout works; modals scroll | Med | **No** | No landscape-specific CSS; test checkout modal in landscape |
| 10. Mobile | Notch / safe areas (iPhone) | Content not hidden | Low | Partial | Admin has `viewport-fit=cover`; shop doesn't |
| 10. Mobile | Sign-in code boxes: paste and SMS autofill | Fills all boxes | High | Partial | Test `autocomplete="one-time-code"` |
| 10. Mobile | Razorpay on mobile (UPI intent apps) | Opens GPay / PhonePe and returns | High | **No** | Blocked by keys |
| 10. Mobile | Admin on phone (packing staff) | Orders and order pages usable | Med | Partial | |
| **11. Edge cases** | Slow network (3G throttling) | Loader, no double orders, 15-second timeout message | High | Yes | |
| 11. Edge cases | Offline mid-checkout | Clear error; cart kept | Med | Partial | No offline page or service worker |
| 11. Edge cases | Browser back from payment, or refresh during checkout | Cart kept; order not duplicated | High | Partial | Typed address is lost on refresh (only name and phone saved) |
| 11. Edge cases | Refresh after "Order placed" | No second order | High | Yes | Idempotency, and the cart is cleared |
| 11. Edge cases | Double / triple tap on "Place order" / "Pay" | One order | High | Yes | |
| 11. Edge cases | Two tabs with different carts | Last write wins; checkout uses the current cart | Med | Partial | Test |
| 11. Edge cases | Offer ends while the item is in the cart | Cart updates the price or shows "unavailable"; no page reload during checkout | High | Yes | Reload is skipped while panels are open |
| 11. Edge cases | Price changed by admin during checkout | Server price wins; customer sees the new total before paying | High | Partial | Server rejects or changes it; check the message shown |
| 11. Edge cases | Unusual input: emoji names, Hindi/Bengali addresses, 500-character landmark, `+91` / `0` / spaces in phone | Saved correctly | Med | Partial | |
| 11. Edge cases | Coupon in lowercase or with spaces; expired; not started | Normalised; clear errors | Med | Yes | |
| 11. Edge cases | Pincode not serviceable by Shiprocket | Told before payment | Med | Partial | Check `geo.js` / Shiprocket check timing |
| 11. Edge cases | Clock skew on device | Countdown and OTP still correct (server time used) | Low | Partial | |
| 11. Edge cases | Ad-blocker or blocked third-party cookies | Sign-in still works or shows a clear message | Med | Yes | Message exists in `index.html` |
| 11. Edge cases | Customer changes phone or email after ordering | Old orders still linked | Med | Yes | Phone merge logic exists |

## Business view: decide before launch

| Area | Test Scenario | Expected Result | Priority | Implemented? | Notes |
|---|---|---|---|---|---|
| Business | Cost at 10K users: SMS, WhatsApp, email, Firebase reads, Worker requests | Budget alerts set on every provider | High | **No** | SMS and Firebase reads are the biggest risks |
| Business | Support channel scales (WhatsApp / email) | Response-time target; templates | Med | Partial | |
| Business | Stock levels set and tracked for each product before the sale | Stock numbers set (not "untracked") | High | Partial | Untracked products can oversell |
| Business | Shiprocket pickup capacity for the expected order volume | Agreed with the courier | High | **No** | |
| Business | Monitoring and alerts (5xx rate, payment failures, webhook failures, backup failures) | Alert to owner phone or email | High | **No** | Only console logs today |
| Business | Rollback plan for a bad deploy | Previous Worker version and hosting release can be restored in minutes | High | Partial | Cloudflare and Firebase keep versions; write the steps down |
| Business | Code committed to git before launch | All of today's work saved | High | **No** | Nothing from today is committed |
