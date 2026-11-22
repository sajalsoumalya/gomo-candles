import { esc, icon, toast } from './ui.js';
import { api, setAuthErrorHandler } from './api.js';
import { getStats } from './stats.js';
import { initAuth, isConfigured, devLoginAvailable, signInEmail, signInGoogle, resetPassword, sendVerification, reloadUser, signOut, devSignIn } from './auth.js';
import { API_BASE } from './firebase-config.js';
import * as dashboard from './views/dashboard.js';
import * as orders from './views/orders.js';
import * as order from './views/order.js';
import * as products from './views/products.js';
import * as offers from './views/offers.js';
import * as settings from './views/settings.js';
import { TABS as SETTINGS_TABS } from './views/settings.js';
import * as notifications from './views/notifications.js';
import * as customers from './views/customers.js';
import * as coupons from './views/coupons.js';
import * as roles from './views/roles.js';

const root = document.getElementById('app');
// GoMo logo (traced from the owner's artwork, see assets/brand/gomo-logo.svg in the shop)
const LOGO = `<svg viewBox="0 0 977 1000" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M9.9 549.7 7.0 553.4 3.3 561.2 1.2 570.2 0.0 581.3 0.0 944.6 1.2 956.5 3.7 966.7 8.6 975.8 14.8 981.9 25.0 987.7 35.7 990.6 46.4 991.8 71.4 991.8 79.6 991.0 89.9 988.9 95.6 986.9 103.9 981.9 110.0 975.8 114.5 968.0 116.6 961.4 118.6 945.0 118.6 751.6 119.0 749.6 119.9 748.8 122.3 750.0 197.9 853.4 205.7 862.9 214.7 869.5 223.7 873.6 229.5 875.2 231.9 875.2 237.3 876.4 250.0 876.8 261.1 875.6 270.1 873.2 276.3 870.3 282.8 865.8 286.9 862.1 295.2 852.2 369.9 750.4 372.7 747.9 374.0 749.2 374.4 750.8 374.4 943.8 376.4 961.0 378.5 967.2 383.0 975.4 388.3 981.1 392.9 984.4 401.5 988.5 408.0 990.1 421.2 991.8 446.2 991.8 461.8 989.7 467.6 988.1 474.5 984.8 477.8 982.8 484.4 976.6 487.3 972.5 491.0 963.9 492.6 954.8 493.4 941.3 493.8 940.9 493.8 585.8 493.4 585.4 493.0 575.1 491.0 562.8 486.9 553.8 481.9 547.6 475.8 542.7 469.2 539.0 458.9 536.1 443.8 534.1 422.4 534.1 408.0 535.7 396.6 539.0 390.0 543.1 381.8 550.9 375.6 558.3 250.0 720.4 247.1 723.3 245.9 723.3 243.0 720.4 111.7 551.3 101.8 541.9 96.1 538.6 85.4 535.7 71.4 534.1 50.1 534.1 34.9 536.1 24.6 539.0 15.6 544.3ZM724.1 529.1 701.1 532.4 678.6 538.6 656.8 547.2 646.6 552.1 641.6 555.4 637.1 557.5 617.4 570.6 602.2 582.9 587.0 597.7 571.0 616.6 560.3 631.8 549.3 650.7 538.6 673.6 537.8 676.9 534.9 683.5 530.8 697.0 530.8 698.7 527.9 707.7 525.9 717.6 522.6 741.4 521.8 762.3 521.3 762.7 522.6 791.1 527.5 821.8 532.8 840.7 541.1 862.1 548.0 876.0 557.5 892.0 566.1 904.8 574.3 915.4 581.7 924.1 592.4 935.1 606.3 947.9 626.4 963.1 640.0 971.3 662.6 982.8 677.8 988.5 701.6 995.1 722.5 998.4 726.6 998.4 740.1 1000.0 768.5 999.6 793.9 996.3 816.1 990.6 838.7 981.9 853.4 974.5 874.4 961.8 891.6 948.7 903.1 938.4 911.3 930.2 924.9 914.6 937.6 897.0 944.6 885.5 952.0 871.5 963.5 844.0 967.2 830.5 968.8 826.4 970.4 820.2 973.7 802.1 976.2 779.6 976.6 755.3 975.4 743.4 975.4 737.7 970.9 709.4 965.1 688.4 957.3 667.9 946.2 645.3 935.6 628.1 924.5 612.9 912.2 598.9 897.4 584.6 890.0 578.4 871.9 565.3 850.6 553.0 830.5 543.9 814.9 538.2 793.1 532.4 770.1 529.1 757.8 528.7 757.4 528.3 736.0 528.3 729.9 529.1ZM736.0 648.6 758.6 648.2 771.8 650.2 786.1 655.2 801.7 663.0 813.2 671.2 824.3 681.9 835.4 695.4 840.7 703.6 847.3 716.7 852.2 730.3 854.3 738.9 855.9 750.0 856.3 773.4 853.9 792.3 852.6 797.6 846.9 814.0 842.4 823.5 837.0 832.5 828.8 843.2 821.0 851.4 812.4 858.8 804.2 864.5 788.6 872.7 776.7 876.8 764.0 879.3 754.9 879.7 754.5 880.1 742.6 880.1 730.7 878.9 722.9 877.3 710.6 873.2 704.0 870.3 691.3 862.5 682.3 855.5 670.0 843.2 665.4 837.4 658.0 825.9 653.5 817.3 649.8 809.1 645.3 796.0 642.0 777.5 642.0 771.8 641.6 771.3 642.0 750.8 644.1 737.3 645.7 730.7 650.2 718.0 653.9 709.8 658.5 701.6 665.0 691.7 670.0 685.6 679.8 675.3 686.0 670.0 694.6 663.8 704.8 658.0 714.7 653.9 726.2 650.2ZM665.0 3.7 642.4 7.0 618.2 13.5 601.4 20.1 586.2 27.5 566.9 39.0 548.4 53.0 533.7 66.5 520.9 80.0 506.6 98.5 493.8 118.6 481.9 142.4 473.7 164.6 467.2 190.5 463.5 217.2 463.5 223.3 462.6 229.9 462.6 252.5 463.1 252.9 463.5 264.8 468.4 296.0 473.7 314.9 481.1 334.6 482.8 337.0 487.7 348.1 500.0 369.0 507.4 379.7 516.0 390.8 524.2 400.2 540.6 416.7 548.9 423.6 569.0 438.4 589.1 450.3 602.6 456.9 624.0 464.7 646.6 470.4 675.7 474.1 704.0 474.5 717.2 472.9 721.3 472.9 741.0 469.6 763.5 463.1 765.6 461.8 778.7 456.9 795.2 448.7 805.8 442.5 825.5 429.0 842.8 414.2 858.0 398.6 872.3 380.5 884.6 361.7 894.1 343.6 904.8 317.7 910.9 296.8 914.2 280.0 914.6 274.2 916.3 265.6 916.3 260.7 917.5 250.8 917.5 227.8 917.1 227.4 916.3 211.8 912.2 185.6 906.4 164.2 899.8 146.1 891.2 127.3 879.3 106.7 865.8 87.8 854.7 75.1 843.2 63.6 830.5 52.5 811.6 39.0 792.3 27.9 775.5 20.1 754.5 12.3 734.4 7.0 711.0 3.7 698.3 3.3 697.9 2.9 676.9 2.9 670.8 3.7ZM589.5 304.6 590.3 301.3 592.8 296.8 596.5 293.1 602.6 289.4 610.8 287.8 615.4 287.8 621.9 289.0 628.1 292.3 633.8 297.6 637.5 302.5 643.3 313.6 646.6 318.6 653.9 326.4 660.5 331.3 670.4 336.2 679.0 339.1 686.4 340.3 700.7 340.3 708.5 339.1 717.2 336.2 726.2 331.7 733.6 326.4 741.4 318.1 746.3 310.3 750.0 302.5 754.1 297.2 759.0 292.7 766.8 288.6 772.2 287.8 777.1 287.8 783.7 289.0 788.2 291.1 791.1 293.1 795.6 298.0 798.0 303.8 798.4 309.5 794.3 322.7 786.5 337.4 776.7 350.2 766.4 360.0 760.7 364.5 746.7 373.2 736.9 377.7 728.2 380.5 711.0 384.6 703.6 385.5 697.5 385.5 697.0 385.9 690.9 385.9 690.5 385.5 683.9 385.5 679.8 384.6 676.1 384.6 670.4 383.0 666.7 382.6 651.9 378.1 637.1 371.1 628.1 365.4 620.7 359.6 611.7 351.0 606.3 344.8 598.1 332.5 594.0 324.3 591.1 316.9 589.5 310.8ZM216.7 0.8 210.6 2.1 206.9 2.1 202.4 3.3 186.8 5.7 167.9 11.1 146.1 19.3 119.9 32.4 98.1 46.8 83.3 58.7 67.7 73.5 56.2 86.6 47.6 97.7 33.7 119.5 22.2 142.4 15.2 160.5 8.6 184.7 5.7 204.0 4.9 220.0 4.5 220.4 4.5 243.0 5.3 249.6 5.3 255.7 8.6 280.4 14.8 305.0 21.3 323.9 25.5 332.1 26.3 335.0 35.3 352.6 46.8 371.1 61.2 390.0 72.2 402.3 82.1 412.2 94.8 423.2 115.8 438.4 127.3 445.4 131.8 447.5 133.8 449.1 153.1 458.1 170.0 464.3 190.1 469.6 212.6 472.9 224.5 473.3 225.0 473.7 250.0 473.7 250.4 473.3 264.8 472.9 265.2 472.5 277.9 471.7 304.2 468.0 326.4 463.1 335.8 459.8 344.0 457.7 359.2 451.6 374.8 443.3 382.6 438.4 392.0 431.4 404.4 420.0 412.6 409.7 420.0 396.1 423.6 382.2 423.6 234.4 420.4 212.6 415.8 203.2 408.5 195.4 400.2 190.5 389.6 187.6 377.3 186.0 249.2 186.0 231.9 188.4 226.6 190.5 221.7 194.2 217.2 199.1 213.1 206.5 210.6 215.9 209.4 228.2 209.4 245.5 211.0 259.9 212.6 266.0 218.4 276.3 224.1 281.6 232.8 285.7 247.5 287.4 301.3 287.4 303.8 289.8 303.8 342.4 303.4 343.6 302.1 344.8 298.0 346.5 281.2 350.2 278.3 350.2 269.7 351.8 244.7 352.6 244.3 353.0 234.8 353.0 219.2 351.4 206.5 348.1 198.3 345.2 186.4 339.5 173.6 330.9 160.9 319.8 152.7 310.8 143.7 298.4 136.7 286.5 131.8 275.5 126.4 257.8 124.4 242.6 124.4 222.5 125.2 214.3 127.3 204.0 132.6 188.0 138.3 176.5 146.1 164.6 151.9 157.6 164.2 145.7 176.9 136.7 188.8 130.1 206.5 123.6 216.7 121.5 229.5 119.9 244.3 119.9 260.7 121.9 276.3 125.2 284.5 128.1 288.6 128.9 300.9 133.4 309.9 137.5 325.9 147.4 332.5 150.7 337.4 152.3 344.4 153.5 351.0 153.1 355.1 152.3 364.9 148.6 374.8 142.0 385.5 131.4 392.4 122.3 399.8 111.2 405.2 101.4 408.9 90.3 409.7 85.8 409.7 78.0 408.9 73.1 406.8 66.9 403.5 61.6 395.7 53.4 387.5 46.4 378.9 39.8 365.8 31.2 353.4 24.6 339.9 18.9 319.8 11.9 312.4 10.3 305.0 7.8 293.9 5.3 281.2 3.7 275.9 2.5 258.6 0.4 250.0 0.4 249.6 0.0 230.3 0.0 229.9 0.4Z"/></svg>`;
const GOOGLE = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

const ROUTES = [
  { re: /^\/?$/, view: dashboard, nav: 'dashboard' },
  { re: /^\/dashboard$/, view: dashboard, nav: 'dashboard' },
  { re: /^\/orders$/, view: orders, nav: 'orders' },
  { re: /^\/orders\/(GM-\d{6}-\d{4})$/, view: order, nav: 'orders' },
  { re: /^\/offers$/, view: offers, nav: 'offers' },
  { re: /^\/offers\/(new|[a-z0-9-]+)$/, view: offers, nav: 'offers', editor: true },
  { re: /^\/products$/, view: products, nav: 'products' },
  { re: /^\/coupons$/, view: coupons, nav: 'coupons' },
  { re: /^\/roles$/, view: roles, nav: 'roles' },
  { re: /^\/customers$/, view: customers, nav: 'customers' },
  { re: /^\/customers\/([A-Za-z0-9_-]{1,128})$/, view: customers, nav: 'customers' },
  { re: /^\/settings(?:\/([a-z]+))?$/, view: settings, nav: 'settings' },
  { re: /^\/notifications$/, view: notifications, nav: 'notifications' },
];

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['orders', 'Orders', 'orders'],
  ['offers', 'Offers', 'offers'],
  ['products', 'Products', 'products'],
  ['coupons', 'Coupons', 'offers'],
  ['customers', 'Customers', 'users'],
  ['notifications', 'Messages', 'bell'],
];

const state = { user: null, admin: null, newOrders: 0 };

// Which admin role can open which page (must match worker/src/staff.js).
const NAV_AREA = { dashboard: 'orders', orders: 'orders', offers: 'catalog', products: 'catalog', coupons: 'coupons', customers: 'customers', notifications: 'messages' };
const hasArea = (area) => { const a = state.admin?.areas || []; return a.includes('*') || a.includes(area); };
const isSuper = () => !!state.admin?.super || (state.admin?.areas || []).includes('*');
export const allowed = (navKey) => (navKey === 'roles' ? isSuper() : navKey === 'settings' ? SETTINGS_TABS.some(([, , area]) => hasArea(area) || (area === 'set_team' && isSuper())) : hasArea(NAV_AREA[navKey]));
const SETTINGS_ICON = { store: 'products', shipping: 'orders', payments: 'offers', invoice: 'print', team: 'users', notify: 'bell', templates: 'mail', signin: 'phone', storage: 'image', integrations: 'refresh' };
const settingsNav = () => SETTINGS_TABS.filter(([, , area]) => (area === 'set_team' ? isSuper() : hasArea(area)));
// Super admin section in the sidebar: team approvals and roles.
const superNav = () => (isSuper() ? [['settings/team', 'Team & approvals', 'users'], ['roles', 'Roles', 'settings']] : []);
const superNavHtml = () => (superNav().length ? `<div class="nav-group">Super admin</div>${superNav().map(([k, label, ic]) => `<a href="#/${k}" data-nav="${k === 'roles' ? 'roles' : 'settings:team'}" class="sub">${icon(ic)}<span>${esc(label)}</span>${k === 'settings/team' ? '<span class="count" data-req-count hidden></span>' : ''}</a>`).join('')}` : '');
const visibleNav = () => NAV.filter(([k]) => allowed(k));
// Phone menu tile (bottom sheet)
const tile = (href, nav, ic, label, extra) => `<a href="#/${href}" data-nav="${nav}" class="tile"><span class="ti">${icon(ic)}</span><span>${esc(label)}</span>${extra}</a>`;
// Page name shown in the phone top bar
function titleFor(r, m) {
  if (r.nav === 'settings') return (SETTINGS_TABS.find(([k]) => k === m[1]) || [])[1] || 'Settings';
  if (r.view === order) return 'Order';
  if (r.nav === 'roles') return 'Roles';
  if (r.editor) return m[1] === 'new' ? 'New offer' : 'Edit offer';
  return (NAV.find(([k]) => k === r.nav) || [])[1] || 'Dashboard';
}

// ------------------------------------------------------------------ auth screens
function authShell(inner) {
  root.innerHTML = `<div class="auth">
    <div class="auth-art">
      <a class="logo" href="#/">${LOGO}<span><small>Admin</small></span></a>
      <div><h1>Orders, offers<br>&amp; <em>calm</em>.</h1><p>Manage products, publish combos and packs, and keep every customer updated on WhatsApp and email.</p></div>
      <small style="color:rgba(255,255,255,.4)">GoMo Candles · Admin panel</small>
    </div>
    <div class="auth-form"><div class="auth-card">${inner}</div></div></div>`;
}

function renderLogin(message = '') {
  if (!isConfigured) {
    authShell(`<h2>Setup needed</h2>
      <p class="sub">Firebase isn't configured yet. Add your web app config to <code>admin/js/firebase-config.js</code>
      and enable Email/Password and Google sign-in in the Firebase console.</p>
      ${devLoginAvailable ? `<div class="alert info">Local development: start the Worker with <code>--var DEV_ADMIN_TOKEN:&lt;secret&gt;</code> and enter the same secret below.</div>
      <form class="form" id="devForm"><div class="field"><label for="dt">Dev token</label><input id="dt" type="password" required autocomplete="off"></div>
      <button class="btn btn-primary btn-block" type="submit">Continue (local only)</button></form>` : ''}`);
    document.getElementById('devForm')?.addEventListener('submit', (e) => { e.preventDefault(); devSignIn(document.getElementById('dt').value.trim()); });
    return;
  }
  authShell(`<h2>Sign in</h2><p class="sub">Use your admin account.</p>
    ${message ? `<div class="alert err">${esc(message)}</div>` : ''}
    <div id="authErr"></div>
    <button type="button" class="google-btn" id="gBtn">${GOOGLE} Continue with Google</button>
    <div class="divider">or with email</div>
    <form class="form" id="loginForm" novalidate>
      <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-block" type="submit" id="loginBtn">Sign in</button>
      <button class="btn btn-ghost btn-sm" type="button" id="forgot">Forgot password?</button>
    </form>
    ${devLoginAvailable ? `<div class="divider">local development</div>
      <form class="form" id="devForm"><div class="field"><label for="dt">Dev token <i>(only works with wrangler dev on localhost)</i></label><input id="dt" type="password" autocomplete="off"></div>
      <button class="btn btn-line btn-block" type="submit">Continue with dev token</button></form>` : ''}`);
  document.getElementById('devForm')?.addEventListener('submit', (e) => { e.preventDefault(); devSignIn(document.getElementById('dt').value.trim()); });
  const showErr = (e) => { document.getElementById('authErr').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; };
  document.getElementById('gBtn').addEventListener('click', () => signInGoogle().catch(showErr));
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    try { await signInEmail(document.getElementById('em').value.trim(), document.getElementById('pw').value); }
    catch (err) { showErr(err); btn.disabled = false; }
  });
  document.getElementById('forgot').addEventListener('click', async () => {
    const email = document.getElementById('em').value.trim();
    if (!email) return showErr(new Error('Enter your email above first.'));
    try { await resetPassword(email); document.getElementById('authErr').innerHTML = '<div class="alert ok">Password reset email sent.</div>'; }
    catch (err) { showErr(err); }
  });
}

function renderBlocked(err) {
  const code = err.data?.code;
  if (code === 'email_unverified') {
    authShell(`<h2>Verify your email</h2><p class="sub">We need to confirm <b>${esc(err.data.email)}</b> belongs to you before opening the admin panel.</p>
      <div id="vMsg"></div>
      <div class="form"><button class="btn btn-primary btn-block" id="sendV">Send verification email</button>
      <button class="btn btn-line btn-block" id="doneV">I've verified — continue</button>
      <button class="btn btn-ghost btn-block" id="out">Sign out</button></div>`);
    document.getElementById('sendV').addEventListener('click', async () => {
      await sendVerification();
      document.getElementById('vMsg').innerHTML = '<div class="alert ok">Verification email sent. Open the link, then come back here.</div>';
    });
    document.getElementById('doneV').addEventListener('click', async () => { await reloadUser(); boot(state.user); });
  } else if (code === 'access_pending' || code === 'not_admin') {
    authShell(`<h2>Waiting for approval</h2><p class="sub">You're signed in as <b>${esc(err.data.email)}</b>.</p>
      <div class="alert info">Your request has been sent to the super admin. You'll get access as soon as they approve it — no need to sign up again.</div>
      <div class="form"><button class="btn btn-primary btn-block" id="recheck">Check again</button>
      <button class="btn btn-line btn-block" id="out">Sign in with another account</button></div>`);
    document.getElementById('recheck').addEventListener('click', () => boot(state.user));
  } else if (code === 'access_declined') {
    authShell(`<h2>Access declined</h2><p class="sub"><b>${esc(err.data.email)}</b> can't use the admin panel.</p>
      <div class="alert warn">The super admin declined this request. Contact them if you think this is a mistake.</div>
      <button class="btn btn-line btn-block" id="out">Sign in with another account</button>`);
  } else {
    authShell(`<h2>Can't connect</h2><div class="alert err">${esc(err.message)}</div>
      <p class="sub">API: <code>${esc(API_BASE)}</code></p>
      <div class="form"><button class="btn btn-primary btn-block" id="retry">Try again</button><button class="btn btn-ghost btn-block" id="out">Sign out</button></div>`);
    document.getElementById('retry').addEventListener('click', () => boot(state.user));
  }
  document.getElementById('out')?.addEventListener('click', () => signOut());
}

// ------------------------------------------------------------------ shell
function renderShell() {
  const a = state.admin;
  const initial = esc((a.name || a.email || '?').charAt(0).toUpperCase());
  const avatar = state.user?.photo ? `<img src="${esc(state.user.photo)}" alt="" referrerpolicy="no-referrer">` : initial;
  root.innerHTML = `<div class="app">
    <aside class="side">
      <a class="logo" href="#/">${LOGO}<span><small>Admin panel</small></span></a>
      <nav>${visibleNav().map(([k, label, ic]) => `<a href="#/${k}" data-nav="${k}">${icon(ic)}<span>${label}</span>${k === 'orders' ? '<span class="count" data-new-count hidden></span>' : ''}</a>`).join('')}
        ${superNavHtml()}
        ${settingsNav().filter(([k]) => k !== 'team').length ? `<div class="nav-group">Settings</div>${settingsNav().filter(([k]) => k !== 'team').map(([k, label]) => `<a href="#/settings/${k}" data-nav="settings:${k}" class="sub">${icon(SETTINGS_ICON[k] || 'settings')}<span>${esc(label)}</span></a>`).join('')}` : ''}</nav>
      <div class="side-foot">
        <div class="who"><span class="avatar">${avatar}</span><span><b>${esc(a.name)}</b>${esc(a.email)}<em class="role-tag">${esc(a.role_label || 'Super admin')}</em></span></div>
        <button class="btn btn-ghost btn-sm" style="color:rgba(255,255,255,.7);justify-content:flex-start" id="signOut">${icon('logout')} Sign out</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <a class="logo" href="#/" aria-label="Dashboard">${LOGO}</a>
        <div class="tb-title"><small>GoMo Admin</small><b id="tbTitle"></b></div>
        <span class="tb-live" id="tbLive" title="Updates appear on their own"><i></i>Live</span>
      </header>
      <div class="mnav" id="mnav" hidden>
        <div class="sheet" id="drawer" role="dialog" aria-modal="true" aria-label="Menu">
          <span class="grab" aria-hidden="true"></span>
          <div class="me"><span class="avatar">${avatar}</span><span class="who"><b>${esc(a.name)}</b><small>${esc(a.email)}</small><em class="role-tag">${esc(a.role_label || 'Super admin')}</em></span>
            <button class="btn btn-line btn-sm" id="signOut2">${icon('logout')} Sign out</button></div>
          <div class="nav-group">Manage</div>
          <nav class="tiles">${visibleNav().map(([k, label, ic]) => tile(k, k, ic, label, k === 'orders' ? '<span class="count" data-new-count hidden></span>' : '')).join('')}</nav>
          ${superNav().length ? `<div class="nav-group">Super admin</div><nav class="tiles">${superNav().map(([k, label, ic]) => tile(k, k === 'roles' ? 'roles' : 'settings:team', ic, label, k === 'settings/team' ? '<span class="count" data-req-count hidden></span>' : '')).join('')}</nav>` : ''}
          ${settingsNav().filter(([k]) => k !== 'team').length ? `<div class="nav-group">Settings</div><nav class="tiles">${settingsNav().filter(([k]) => k !== 'team').map(([k, label]) => tile(`settings/${k}`, `settings:${k}`, SETTINGS_ICON[k] || 'settings', label, '')).join('')}</nav>` : ''}
        </div>
      </div>
      <main class="content" id="view"></main>
    </div>
    <nav class="tabbar">${visibleNav().filter(([k]) => ['dashboard', 'orders', 'products', 'offers'].includes(k)).map(([k, label, ic]) => `<a href="#/${k}" data-nav="${k}"><span class="ti">${icon(ic)}</span><span class="tl">${k === 'dashboard' ? 'Home' : label}</span>${k === 'orders' ? '<span class="count" data-new-count hidden></span>' : ''}</a>`).join('')}
      <button type="button" class="tab-more" id="tabMore" aria-label="Open menu" aria-expanded="false" aria-controls="mnav"><span class="ti">${icon('grid')}</span><span class="tl">More</span><span class="count" data-req-count hidden></span></button></nav>
  </div><div class="slip" id="slip"></div>`;
  document.getElementById('signOut').addEventListener('click', () => signOut());
  document.getElementById('signOut2').addEventListener('click', () => signOut());
  // phone menu: "More" in the tab bar slides a sheet up from the bottom; it closes on navigation, backdrop tap,
  // Esc, tapping More again or a swipe down
  const mnav = document.getElementById('mnav'), drawer = document.getElementById('drawer');
  const more = document.getElementById('tabMore');
  let shutTimer = 0;
  const setMenu = (open) => {
    clearTimeout(shutTimer);
    more.setAttribute('aria-expanded', String(open)); more.classList.toggle('on', open); document.body.classList.toggle('menu-open', open);
    drawer.style.transform = '';
    if (open) { mnav.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => mnav.classList.add('open'))); }
    else { mnav.classList.remove('open'); shutTimer = setTimeout(() => { mnav.hidden = true; }, 260); }
  };
  const isOpen = () => mnav.classList.contains('open');
  more.addEventListener('click', () => setMenu(!isOpen()));
  mnav.addEventListener('click', (e) => { if (e.target === mnav || e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setMenu(false); });
  window.addEventListener('hashchange', () => { if (isOpen()) setMenu(false); });
  // drag the sheet down to close it (only when its list is scrolled to the top)
  let y0 = null, dy = 0;
  drawer.addEventListener('touchstart', (e) => { y0 = drawer.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  drawer.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); if (dy) { drawer.style.transition = 'none'; drawer.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  drawer.addEventListener('touchend', () => { drawer.style.transition = ''; if (dy > 90) setMenu(false); else drawer.style.transform = ''; y0 = null; });
}

export function setNewOrders(n) {
  state.newOrders = n;
  document.querySelectorAll('[data-new-count]').forEach((el) => { el.textContent = n; el.hidden = !n; });
}

async function refreshCounts() {
  if (hasArea('orders')) { try { const s = await getStats(); setNewOrders(s.by_status.placed || 0); } catch { /* ignore */ } }
  if (isSuper()) {
    try { const t = await api('/api/admin/staff'); const n = (t.requests || []).length; document.querySelectorAll('[data-req-count]').forEach((b) => { b.textContent = n; b.hidden = !n; }); } catch { /* ignore */ }
  }
}

let renderSeq = 0;
async function route() {
  if (!state.admin) return;
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  let r = ROUTES.find((x) => x.re.test(path)) || ROUTES[0];
  if (!allowed(r.nav)) {
    // Packers have no dashboard: send them to Orders. Anything else they can't open shows a message.
    if (r.nav === 'dashboard') {
      const first = visibleNav()[0]?.[0] || (settingsNav()[0] ? `settings/${settingsNav()[0][0]}` : null);
      if (first) { location.replace(`#/${first}`); return; }
    }
    document.getElementById('view').innerHTML = `<div class="card"><h3>No access</h3><p class="muted">You don't have access to this page. Ask the owner to give it to you under Settings → Team.</p></div>`;
    return;
  }
  const m = path.match(r.re) || [];
  const navKey = r.nav === 'settings' ? `settings:${m[1] || ''}` : r.nav;
  const tb = document.getElementById('tbTitle');
  if (tb) tb.textContent = titleFor(r, m);
  // list pages repeat the top-bar title in their heading; phones hide that copy (order/customer pages keep theirs)
  document.body.classList.toggle('h1-dup', r.nav === 'settings' || (!m[1] && !r.editor));
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === navKey || (r.nav === 'settings' && !m[1] && a.dataset.nav.startsWith('settings:') && a === document.querySelector('[data-nav^="settings:"]'))));
  const el = document.getElementById('view');
  const seq = ++renderSeq;
  window.scrollTo(0, 0);
  try {
    await r.view.render(el, { id: m[1], editor: !!r.editor, query: new URLSearchParams(location.hash.split('?')[1] || ''), isCurrent: () => seq === renderSeq, refreshCounts });
  } catch (e) {
    if (seq === renderSeq) el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`;
  }
}

async function boot(user) {
  state.user = user;
  if (!user) { state.admin = null; renderLogin(); return; }
  root.innerHTML = '<div class="wrap-boot"><span class="spinner"></span>&nbsp; Checking access…</div>';
  try {
    const { admin } = await api('/api/admin/me');
    state.admin = admin;
    window.GOMO_ADMIN = admin; // read by views (e.g. packers don't see payment buttons)
    renderShell();
    route();
    refreshCounts();
  } catch (e) {
    state.admin = null;
    renderBlocked(e);
  }
}

setAuthErrorHandler((err) => {
  if (!state.admin) return;
  if (err.status === 401) { toast('Session expired — please sign in again.', 'err'); signOut(); }
});

window.addEventListener('hashchange', route);
setInterval(() => { if (state.admin && document.visibilityState === 'visible') refreshCounts(); }, 60000);

// New-version check: an open tab keeps running old code after a deploy. Every few minutes (and when the tab comes back
// into view) compare the server's copy of the app files; if they changed, offer a one-click reload.
const VERSION_FILES = ['js/app.js', 'js/views/products.js', 'css/admin.css'];
let versionSeen = null, versionPrompted = false;
async function appVersion() {
  const tags = await Promise.all(VERSION_FILES.map((f) => fetch(f, { method: 'HEAD', cache: 'no-store' }).then((r) => r.headers.get('etag') || r.headers.get('last-modified') || '').catch(() => '')));
  return tags.join('|');
}
async function checkVersion() {
  if (versionPrompted) return;
  const v = await appVersion();
  if (!v.replace(/\|/g, '')) return;
  if (versionSeen === null) { versionSeen = v; return; }
  if (v !== versionSeen) {
    versionPrompted = true;
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.innerHTML = '<span>A new version of the admin panel is available.</span><button class="btn btn-primary btn-sm" type="button">Reload now</button>';
    bar.querySelector('button').addEventListener('click', () => location.reload());
    document.body.appendChild(bar);
  }
}
checkVersion();
setInterval(checkVersion, 3 * 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });

initAuth(boot).catch((e) => { root.innerHTML = `<div class="wrap-boot"><div class="alert err">Could not start sign-in: ${esc(e.message)}</div></div>`; });
