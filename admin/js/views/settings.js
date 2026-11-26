import { api } from '../api.js';
import { API_BASE } from '../firebase-config.js';
import { esc, EVENT_LABELS, loading, icon, toast, busy, showFieldErrors, openDialog, confirmDialog, copyText } from '../ui.js';

// Each settings page has its own address (#/settings/<page>) and its own permission (see worker/src/staff.js).
export const TABS = [
  ['store', 'Store', 'set_store'], ['shipping', 'Shipping', 'set_shipping'], ['payments', 'Payments', 'set_payments'],
  ['invoice', 'GST & invoices', 'set_invoice'], ['team', 'Team', 'set_team'], ['notify', 'Notifications', 'set_notify'],
  ['templates', 'Message templates', 'set_templates'], ['signin', 'Sign-in & SMS', 'set_signin'], ['storage', 'Photo storage', 'set_storage'],
  ['integrations', 'Integrations', 'set_integrations'],
];
const has = (area) => { const a = window.GOMO_ADMIN?.areas || []; return a.includes('*') || (area !== 'set_team' && a.includes(area)); };
export const allowedTabs = () => TABS.filter(([, , area]) => has(area));
const TAB_INTRO = {
  store: 'Your store name and how customers contact you.', shipping: 'Delivery fee and the free-shipping threshold.',
  payments: 'Cash on Delivery and online payment.', invoice: 'GSTIN and invoice numbering.', team: 'Approve access requests and choose what each person can open. Only the super admin sees this page.',
  notify: 'Who gets order updates, and where new-order alerts go.', templates: 'The WhatsApp and email text sent at each order step.',
  signin: 'How customers receive sign-in codes.', storage: 'Product photo storage on RustFS.', integrations: 'Connected services and test messages.',
};
let tab = 'store';

export async function render(el, ctx) {
  const tabs = allowedTabs();
  tab = tabs.some(([k]) => k === ctx.id) ? ctx.id : (tabs[0]?.[0] || 'store');
  if (ctx.id !== tab) { location.replace(`#/settings/${tab}`); return; }
  el.innerHTML = loading('Loading settings…');
  const d = await api('/api/admin/settings');
  if (!ctx.isCurrent()) return;
  draw(el, d);
}

function draw(el, d) {
  const s = d.settings, ig = d.integrations;
  el.innerHTML = `
    <div class="page-head"><div><small class="eyebrow-sm">${tab === 'team' ? 'Super admin' : 'Settings'}</small><h1>${esc(TABS.find(([k]) => k === tab)?.[1] || 'Settings')}</h1><p>${esc(TAB_INTRO[tab] || '')}</p></div></div>
    <div class="settings-nav chips mobile-only">${allowedTabs().map(([k, l]) => `<a class="chip ${tab === k ? 'on' : ''}" href="#/settings/${k}">${esc(l)}</a>`).join('')}</div>
    ${tab !== 'integrations' ? '<div id="panel" class="settings-panel"></div>' : `<div class="grid g-main"><div class="grid" style="align-content:start">
        <div class="card" id="integCard"><div class="row-between"><h3 style="margin:0">Integrations</h3><button class="btn btn-line btn-sm" id="integCheck">${icon('refresh')} Check connections</button></div>
          <p class="muted" style="font-size:.78rem;margin:6px 0 10px"><b>Set</b> = the secret is on the Worker. <b>Check connections</b> really contacts each service (no messages are sent).</p>
          ${integ('Database (Firebase)', true, 'FIREBASE_SERVICE_ACCOUNT', 'database')}
          ${integ('Postal (email)', ig.postal, 'POSTAL_URL, POSTAL_API_KEY, MAIL_FROM', 'postal')}
          ${integ('OpenWA (WhatsApp)', ig.openwa, 'OPENWA_URL, OPENWA_API_KEY', 'openwa')}
          ${integ('Razorpay', ig.razorpay, 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET', 'razorpay')}
          ${integ('Razorpay webhook', ig.razorpay_webhook, 'RAZORPAY_WEBHOOK_SECRET', 'razorpay_webhook')}
          ${integ('Sign-in codes', ig.otp_secret, 'OTP_SECRET', 'otp_secret')}
          ${integ('Bulk SMS', ig.sms, 'SMS_API_KEY + provider in Sign-in & SMS', 'sms')}
          ${integ('Photo storage (RustFS)', ig.s3, 'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY', 's3')}
          ${integ('Bot protection', ig.turnstile, 'TURNSTILE_SECRET (optional)', 'turnstile')}
          ${integ('Shiprocket (courier pickups)', ig.shiprocket, 'SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD', 'shiprocket')}
          <p class="muted" style="font-size:.78rem;margin-top:10px">Secrets live in <code>worker/.secrets</code> and are uploaded with <code>npm run deploy</code> — never stored here.</p>
        </div>
        <div class="card"><h3>Send a test</h3>
          <form class="form" id="testForm" novalidate>
            <div class="seg" id="tch"><button type="button" class="on" data-ch="whatsapp">WhatsApp</button><button type="button" data-ch="email">Email</button></div>
            <div class="field"><label for="tto" id="ttoLabel">WhatsApp number</label><input id="tto" placeholder="9876543210" inputmode="tel"></div>
            <button class="btn btn-dark" type="submit" id="tbtn">Send test</button>
          </form>
        </div>
      </div></div>`}`;

  const ic = el.querySelector('#integCheck');
  ic?.addEventListener('click', () => checkIntegrations(el.querySelector('#integCard'), ic));
  if (ic) checkIntegrations(el.querySelector('#integCard'), ic);
  if (el.querySelector('#panel')) panel(el.querySelector('#panel'), d, el);
  if (!el.querySelector('#testForm')) return;

  let ch = 'whatsapp';
  el.querySelectorAll('#tch [data-ch]').forEach((b) => b.addEventListener('click', () => {
    ch = b.dataset.ch;
    el.querySelectorAll('#tch [data-ch]').forEach((x) => x.classList.toggle('on', x === b));
    el.querySelector('#ttoLabel').textContent = ch === 'email' ? 'Email address' : 'WhatsApp number';
    el.querySelector('#tto').placeholder = ch === 'email' ? 'you@example.com' : '9876543210';
  }));
  el.querySelector('#testForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = el.querySelector('#tbtn');
    busy(btn, true, 'Sending…');
    try {
      const { result } = await api('/api/admin/test-notification', { method: 'POST', body: { channel: ch, to: el.querySelector('#tto').value } });
      toast(result.status === 'sent' ? 'Test message sent' : `${result.status}: ${result.error}`, result.status === 'sent' ? 'ok' : 'err');
    } catch (err) { toast(err.message, 'err'); }
    busy(btn, false);
  });
}

// Settings → Shipping → Shiprocket: pickup address, default parcel, automatic status updates.
function shiprocketSettings(p, d, save) {
  const sr = d.settings.shiprocket || {};
  const ready = d.integrations?.shiprocket;
  const v = (x) => (x == null ? '' : esc(x));
  const hook = `${API_BASE}/api/courier/webhook`;
  p.insertAdjacentHTML('beforeend', `<form class="card form" id="srSet" novalidate style="margin-top:16px"><h3>Shiprocket pickups</h3>
    ${ready ? '' : `<div class="alert warn" style="margin:0">Not connected yet. In Shiprocket go to <b>Settings → API → Add New API User</b> (use an email different from your login), then add its email and password to the server as <code>SHIPROCKET_EMAIL</code> and <code>SHIPROCKET_PASSWORD</code>. You can fill these settings in now.</div>`}
    <div class="form-row">
      <div class="field" data-field="pickup_location"><label for="srPl">Pickup address</label>
        <select id="srPl"><option value="">${ready ? 'Loading your Shiprocket addresses…' : 'Your primary Shiprocket address'}</option>${sr.pickup_location ? `<option value="${v(sr.pickup_location)}" selected>${v(sr.pickup_location)}</option>` : ''}</select>
        <div class="hint" id="srPlHint">Where the courier collects parcels. Add or edit addresses in Shiprocket → Settings → Pickup Addresses.</div></div>
      <div class="field" data-field="courier_id"><label for="srCi">Courier id <i>(optional)</i></label><input id="srCi" type="number" min="0" value="${sr.courier_id ? v(sr.courier_id) : ''}" placeholder="Shiprocket picks" inputmode="numeric"><div class="hint">Empty = Shiprocket's choice (your courier priority in Shiprocket).</div></div>
    </div>
    <h4 style="margin:6px 0 -4px">Default parcel <span class="muted" style="font-weight:400">(editable on each order)</span></h4>
    <div class="form-row three" style="grid-template-columns:repeat(4,1fr)">
      <div class="field" data-field="weight_kg"><label for="srWk">Weight (kg)</label><input id="srWk" type="number" step="0.01" min="0.01" value="${v(sr.weight_kg)}" inputmode="decimal"></div>
      <div class="field" data-field="length_cm"><label for="srLc">Length (cm)</label><input id="srLc" type="number" step="0.5" min="0.5" value="${v(sr.length_cm)}" inputmode="decimal"></div>
      <div class="field" data-field="breadth_cm"><label for="srBc">Breadth (cm)</label><input id="srBc" type="number" step="0.5" min="0.5" value="${v(sr.breadth_cm)}" inputmode="decimal"></div>
      <div class="field" data-field="height_cm"><label for="srHc">Height (cm)</label><input id="srHc" type="number" step="0.5" min="0.5" value="${v(sr.height_cm)}" inputmode="decimal"></div>
    </div>
    <label class="switch"><input type="checkbox" id="srAuto" ${sr.auto_status !== false ? 'checked' : ''}><i></i>Move orders to Shipped / Out for delivery / Delivered from courier updates</label>
    <label class="switch"><input type="checkbox" id="srNotify" ${sr.notify_customer !== false ? 'checked' : ''}><i></i>Message the customer when a courier update moves their order</label>
    <div class="alert info" style="margin:0"><b>Instant tracking updates (optional):</b> in Shiprocket → Settings → API → Webhooks, add <code>${esc(hook)}</code>${d.integrations?.shiprocket_webhook ? ' with the same token as <code>SHIPROCKET_WEBHOOK_TOKEN</code>' : ''}. Without it, tracking is refreshed every 2 hours.</div>
    <div><button class="btn btn-primary" type="submit">Save Shiprocket settings</button></div></form>`);
  const f = p.querySelector('#srSet');
  const sel = f.querySelector('#srPl');
  if (ready) {
    api('/api/admin/shiprocket/pickups').then(({ pickups }) => {
      const active = pickups.filter((x) => x.active);
      sel.innerHTML = `<option value="">Primary address${active.find((x) => x.primary) ? ` (${esc(active.find((x) => x.primary).name)})` : ''}</option>` +
        active.map((x) => `<option value="${esc(x.name)}" ${x.name === sr.pickup_location ? 'selected' : ''}>${esc(x.name)} — ${esc([x.city, x.pincode].filter(Boolean).join(' '))}</option>`).join('');
      if (!active.length) f.querySelector('#srPlHint').innerHTML = '<b>No active pickup address in Shiprocket yet.</b> Add one in Shiprocket → Settings → Pickup Addresses (and verify its phone).';
    }).catch((e) => { f.querySelector('#srPlHint').textContent = e.message; sel.querySelector('option').textContent = 'Your primary Shiprocket address'; });
  }
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (id) => f.querySelector(id).value;
    save('shiprocket', {
      pickup_location: sel.value, courier_id: val('#srCi') === '' ? 0 : Number(val('#srCi')),
      weight_kg: Number(val('#srWk')), length_cm: Number(val('#srLc')), breadth_cm: Number(val('#srBc')), height_cm: Number(val('#srHc')),
      auto_status: f.querySelector('#srAuto').checked, notify_customer: f.querySelector('#srNotify').checked,
    }, f.querySelector('[type=submit]'), f);
  });
}

// "Set" only means the Worker has the secret. "Check connections" actually calls each service (read-only).
const integ = (name, ok, vars, key) => `<div class="integ" data-integ="${key || ''}"><span>${esc(name)}<small data-detail>${esc(vars)}</small></span><span class="pill ${ok ? 'placed' : 'pending'}" data-pill>${ok ? 'Set' : 'Not set'}</span></div>`;

async function checkIntegrations(card, btn) {
  busy(btn, true, 'Checking…');
  try {
    const { results } = await api('/api/admin/integrations/check', { method: 'POST' });
    for (const [k, r] of Object.entries(results)) {
      const row = card.querySelector(`[data-integ="${k}"]`);
      if (!row) continue;
      const pill = row.querySelector('[data-pill]');
      const cls = r.ok === true ? 'live' : r.ok === false ? 'cancelled' : r.set ? 'placed' : 'pending';
      const label = r.ok === true ? 'Connected' : r.ok === false ? 'Failed' : r.set ? 'Set' : 'Not set';
      pill.className = `pill ${cls}`;
      pill.textContent = label;
      row.querySelector('[data-detail]').textContent = r.detail + (r.ms != null && r.ok !== null ? ` · ${r.ms} ms` : '');
    }
    toast('Connections checked', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  busy(btn, false);
}

function panel(p, d, root) {
  const s = d.settings;
  const save = async (key, body, btn, form) => saveMany({ [key]: body }, btn, form);
  const saveMany = async (values, btn, form) => {
    busy(btn, true);
    try {
      const next = await api('/api/admin/settings', { method: 'PUT', body: values });
      Object.assign(d, next);
      toast('Settings saved', 'ok');
      draw(root, d);
    } catch (e) {
      busy(btn, false);
      if (e.data?.fields) {
        const fields = Object.fromEntries(Object.entries(e.data.fields).map(([k, v]) => [k.replace(/^(otp|sms|store|shipping|payments|notify|invoice|shiprocket)\./, '').replace('custom.', 'custom_'), v]));
        showFieldErrors(form, fields);
      }
      toast(e.message, 'err');
    }
  };

  if (tab === 'store') {
    p.innerHTML = `<form class="card form" novalidate><h3>Store</h3>
      <div class="field" data-field="name"><label for="sn">Store name</label><input id="sn" value="${esc(s.store.name)}" maxlength="80"></div>
      <div class="form-row">
        <div class="field" data-field="whatsapp"><label for="sw">WhatsApp number (customers)</label><input id="sw" value="${esc(s.store.whatsapp)}" inputmode="tel" placeholder="919876543210"><div class="hint">With country code, digits only. Used for “Chat on WhatsApp” buttons on the website.</div></div>
        <div class="field" data-field="email"><label for="se">Contact email</label><input id="se" type="email" value="${esc(s.store.email)}" placeholder="support@earthenbeauty.in"><div class="hint">Shown to customers everywhere: website footer and policy pages, order emails and WhatsApp messages.</div></div>
      </div>
      <div class="field" data-field="shop_url"><label for="su">Website address</label><input id="su" type="url" value="${esc(s.store.shop_url)}" placeholder="https://gomo.earthenbeauty.in"><div class="hint">Used for “Track your order” links in messages.</div></div>
      <div><button class="btn btn-primary" type="submit">Save store</button></div></form>`;
    const f = p.querySelector('form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      save('store', { name: f.querySelector('#sn').value, whatsapp: f.querySelector('#sw').value, email: f.querySelector('#se').value, shop_url: f.querySelector('#su').value }, f.querySelector('[type=submit]'), f);
    });
  }

  if (tab === 'shipping') {
    const sh = s.shipping, v = (x) => (x == null ? '' : esc(x));
    p.innerHTML = `<form class="card form" novalidate><h3>Shipping</h3>
      <h4 style="margin:4px 0 -4px">Cash on Delivery orders</h4>
      <div class="form-row">
        <div class="field" data-field="fee"><label for="sf">Delivery charge (₹)</label><input id="sf" type="number" min="0" value="${v(sh.fee)}" inputmode="numeric"><div class="hint" id="sfHint"></div></div>
        <div class="field" data-field="free_above"><label for="sa">Free delivery above (₹) <i>(optional)</i></label><input id="sa" type="number" min="0" value="${v(sh.free_above)}" inputmode="numeric" placeholder="Never free"><div class="hint">Empty = Cash on Delivery always pays the charge.</div></div>
      </div>
      <label class="switch"><input type="checkbox" id="si" ${sh.include_equal ? 'checked' : ''}><i></i>Orders of exactly this amount also ship free</label>
      <h4 style="margin:14px 0 -4px">Prepaid (online payment) orders</h4>
      <div class="form-row">
        <div class="field" data-field="prepaid_fee"><label for="spp">Delivery charge (₹)</label><input id="spp" type="number" min="0" value="${v(sh.prepaid_fee)}" inputmode="numeric" placeholder="Same as Cash on Delivery"><div class="hint" id="sppHint"></div></div>
      </div>
      <div class="alert info" style="margin:0" id="shipSummary"></div>
      <div><button class="btn btn-primary" type="submit">Save shipping</button></div></form>`;
    const f = p.querySelector('form');
    const val = (id) => f.querySelector(id).value;
    const money = (n) => (Number(n) === 0 ? '<b>Free</b>' : `<b>₹${esc(Number(n))}</b>`);
    const pph = () => {
      const fee = val('#sf') || 0, above = val('#sa'), pre = val('#spp');
      f.querySelector('#sfHint').innerHTML = Number(fee) === 0 ? 'Shown to customers as <b>Free</b>.' : `Customers pay ${money(fee)}.`;
      f.querySelector('#sppHint').innerHTML = pre === '' ? 'Empty = same as Cash on Delivery.' : Number(pre) === 0 ? 'Shown to customers as <b>Free delivery</b>.' : `Customers pay ${money(pre)}.`;
      const codLine = Number(fee) === 0 ? 'Free' : `${money(fee)}${above !== '' ? `, free above ₹${esc(Number(above))}` : ''}`;
      const preFee = pre === '' ? fee : pre;
      const preLine = Number(preFee) === 0 ? '<b>Free</b>' : `${money(preFee)}${above !== '' ? `, free above ₹${esc(Number(above))}` : ''}`;
      f.querySelector('#shipSummary').innerHTML = `Cash on Delivery: ${codLine}<br>Prepaid: ${preLine}`;
    };
    ['#sf', '#sa', '#spp'].forEach((id) => f.querySelector(id).addEventListener('input', pph)); pph();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      save('shipping', { fee: Number(val('#sf') || 0), free_above: val('#sa') === '' ? null : Number(val('#sa')), include_equal: f.querySelector('#si').checked, prepaid_fee: val('#spp') === '' ? null : Number(val('#spp')) }, f.querySelector('[type=submit]'), f);
    });
    shiprocketSettings(p, d, save);
  }

  if (tab === 'payments') {
    p.innerHTML = `<form class="card form" novalidate><h3>Payment methods</h3>
      <div class="integ"><span><b>Cash on Delivery</b><small>Customer pays when the order arrives.</small></span><label class="switch"><input type="checkbox" id="pc" ${s.payments.cod ? 'checked' : ''}><i></i></label></div>
      <div class="integ" data-field="razorpay"><span><b>Razorpay (online)</b><small>${d.integrations.razorpay ? 'Keys detected on the Worker.' : 'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as Worker secrets to enable.'}</small><span class="err"></span></span>
        <label class="switch"><input type="checkbox" id="pr" ${s.payments.razorpay ? 'checked' : ''} ${d.integrations.razorpay || s.payments.razorpay ? '' : 'disabled'}><i></i></label></div>
      ${d.integrations.razorpay && !d.integrations.razorpay_webhook ? '<div class="alert warn" style="margin:0">Also set RAZORPAY_WEBHOOK_SECRET and add the webhook <code>/api/razorpay/webhook</code> in Razorpay so payments are confirmed even if the customer closes the page.</div>' : ''}
      <div><button class="btn btn-primary" type="submit">Save payments</button></div></form>`;
    const f = p.querySelector('form');
    f.addEventListener('submit', (e) => { e.preventDefault(); save('payments', { cod: f.querySelector('#pc').checked, razorpay: f.querySelector('#pr').checked }, f.querySelector('[type=submit]'), f); });
  }

  if (tab === 'notify') {
    const n = s.notify;
    p.innerHTML = `<form class="card form" novalidate><h3>Who gets notified</h3>
      <div class="integ"><span><b>WhatsApp to customers</b><small>Order placed, confirmed, shipped, delivered…</small></span><label class="switch"><input type="checkbox" id="ncw" ${n.customer_whatsapp ? 'checked' : ''}><i></i></label></div>
      <div class="integ"><span><b>Email to customers</b><small>Only when the customer gave an email.</small></span><label class="switch"><input type="checkbox" id="nce" ${n.customer_email ? 'checked' : ''}><i></i></label></div>
      <div class="field" data-field="admin_whatsapp"><label for="naw">New-order alerts on WhatsApp</label><textarea id="naw" rows="2" placeholder="919876543210">${esc(n.admin_whatsapp.join('\n'))}</textarea><div class="hint">One number per line (up to 5).</div></div>
      <div class="field" data-field="admin_emails"><label for="nae">New-order alerts by email</label><div class="hint" style="margin:-2px 0 6px">If both alert lists are empty, new-order emails go to the super admin (${esc(d.admin_emails.join(", "))}).</div><textarea id="nae" rows="2" placeholder="orders@your-domain.com">${esc(n.admin_emails.join('\n'))}</textarea></div>
      <div><button class="btn btn-primary" type="submit">Save notifications</button></div></form>`;
    const f = p.querySelector('form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      save('notify', { customer_whatsapp: f.querySelector('#ncw').checked, customer_email: f.querySelector('#nce').checked, admin_whatsapp: f.querySelector('#naw').value, admin_emails: f.querySelector('#nae').value }, f.querySelector('[type=submit]'), f);
    });
  }

  if (tab === 'templates') {
    const t = s.templates;
    p.innerHTML = `<form class="card form" novalidate><h3>Message templates</h3>
      <div><p class="muted" style="font-size:.84rem;margin-bottom:8px">Placeholders you can use:</p><div class="placeholders">${d.placeholders.map((x) => `<code>{{${esc(x)}}}</code>`).join('')}</div></div>
      ${d.events.map((ev) => `<details class="tpl" data-ev="${ev}"><summary>${esc(EVENT_LABELS[ev] || ev)} ${icon('arrow')}</summary>
        <div class="field"><label>WhatsApp message</label><textarea rows="5" data-k="whatsapp">${esc(t[ev].whatsapp)}</textarea><div class="hint">*bold* works on WhatsApp.</div></div>
        <div class="field"><label>Email subject</label><input data-k="email_subject" value="${esc(t[ev].email_subject)}"></div>
        <div class="field"><label>Email opening text</label><textarea rows="3" data-k="email_intro">${esc(t[ev].email_intro)}</textarea><div class="hint">The email also includes the item list, totals, address and a Track button automatically.</div></div>
        <button type="button" class="btn btn-ghost btn-sm" data-reset="${ev}">Reset to default</button></details>`).join('')}
      <div><button class="btn btn-primary" type="submit">Save templates</button></div></form>`;
    const f = p.querySelector('form');
    f.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
      const ev = b.dataset.reset, def = d.defaults.templates[ev];
      const box = f.querySelector(`[data-ev="${ev}"]`);
      for (const k of ['whatsapp', 'email_subject', 'email_intro']) box.querySelector(`[data-k="${k}"]`).value = def[k];
      toast('Reset — remember to save', '');
    }));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = {};
      f.querySelectorAll('[data-ev]').forEach((box) => {
        body[box.dataset.ev] = Object.fromEntries(['whatsapp', 'email_subject', 'email_intro'].map((k) => [k, box.querySelector(`[data-k="${k}"]`).value]));
      });
      save('templates', body, f.querySelector('[type=submit]'), f);
    });
  }

  if (tab === 'signin') signinPanel(p, d, saveMany);
  if (tab === 'storage') storagePanel(p, d);
  if (tab === 'invoice') invoicePanel(p, s, save);
  if (tab === 'team') teamPanel(p);
}

async function invoicePanel(p, s, save) {
  const iv = s.invoice;
  let states = [];
  try { states = (await api('/api/states')).states || []; } catch { /* fall back to free text below */ }
  p.innerHTML = `<form class="card form" novalidate><h3>GST &amp; invoices</h3>
    <div class="alert ${iv.gstin ? 'ok' : 'info'}" style="margin:0">${iv.gstin
      ? 'GSTIN set: invoices print as <b>Tax Invoice</b>. Customers in your state get CGST + SGST, others get IGST. Tax is worked out backwards from your GST-inclusive prices.'
      : 'No GSTIN yet: invoices print as a plain <b>Invoice</b> with no tax lines. Add your GSTIN here once you have it. Invoices already issued keep their original format.'}</div>
    <div class="field" data-field="legal_name"><label for="il">Legal / business name <i>(optional)</i></label><input id="il" value="${esc(iv.legal_name)}" maxlength="120" placeholder="${esc(s.store.name)}"><div class="hint">Leave empty to use the store name.</div></div>
    <div class="form-row">
      <div class="field" data-field="gstin"><label for="ig">GSTIN <i>(optional)</i></label><input id="ig" value="${esc(iv.gstin)}" maxlength="15" style="text-transform:uppercase" placeholder="19ABCDE1234F1Z5"></div>
      <div class="field" data-field="state"><label for="is">Your state</label>${states.length
        ? `<select id="is"><option value="">—</option>${states.map((x) => `<option ${x === iv.state ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`
        : `<input id="is" value="${esc(iv.state)}" maxlength="60">`}</div>
    </div>
    <div class="field" data-field="address"><label for="ia">Business address</label><textarea id="ia" rows="2" maxlength="300">${esc(iv.address)}</textarea><div class="hint">Printed on every invoice. Required with a GSTIN.</div></div>
    <div class="form-row">
      <div class="field" data-field="hsn"><label for="ih">Default HSN code</label><input id="ih" value="${esc(iv.hsn)}" maxlength="8" inputmode="numeric"><div class="hint">Used for products with no HSN of their own (Products → edit → GST).</div></div>
      <div class="field" data-field="gst_rate"><label for="ir">Default GST rate (%)</label><input id="ir" type="number" min="0" max="40" step="0.01" value="${esc(iv.gst_rate)}"><div class="hint">Please confirm the rate with your CA.</div></div>
      <div class="field" data-field="prefix"><label for="ip">Number prefix</label><input id="ip" value="${esc(iv.prefix)}" maxlength="8" style="text-transform:uppercase"><div class="hint">e.g. ${esc(iv.prefix || 'GM')}/26-27/0001, restarting each April.</div></div>
    </div>
    <div><button class="btn btn-primary" type="submit">Save invoice settings</button></div></form>`;
  const f = p.querySelector('form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => f.querySelector(id).value;
    save('invoice', { legal_name: v('#il'), gstin: v('#ig'), state: v('#is'), address: v('#ia'), hsn: v('#ih'), gst_rate: Number(v('#ir')), prefix: v('#ip') }, f.querySelector('[type=submit]'), f);
  });
}

const SMS_HELP = {
  none: 'No SMS — codes go on WhatsApp only.',
  msg91: 'MSG91 Flow API. Template id = your Flow id (DLT-approved). Variable name = the variable in your flow, e.g. otp or var1.',
  fast2sms: 'Fast2SMS. With a DLT message id + sender id the DLT route is used; leave both empty to use the Fast2SMS OTP route.',
  '2factor': '2Factor.in OTP SMS. Template = your approved template name (optional).',
  custom: 'Any HTTP SMS gateway. Use {{phone}} (10 digits), {{phone91}}, {{code}}, {{message}} and {{api_key}} in the URL, headers or body.',
};

function signinPanel(p, d, saveMany) {
  const o = d.settings.otp, sm = d.settings.sms, ig = d.integrations;
  const ch = d.otp_channels || [];
  p.innerHTML = `<form class="card form" id="otpForm" novalidate><h3>Sign-in &amp; verification codes</h3>
      <div class="alert ${ch.length ? 'ok' : 'warn'}" style="margin:0">${ch.length
        ? `Codes are delivered by: <b>${ch.map((c) => (c === 'whatsapp' ? 'WhatsApp' : c === 'sms' ? 'SMS' : 'test mode')).join(' → ')}</b>.`
        : 'No delivery channel is set up, so customers cannot sign in with their mobile or verify it (email and Google sign-in still work). Connect OpenWA and/or an SMS provider.'}
        ${ig.otp_secret ? '' : '<br><b>OTP_SECRET is missing</b> — set it with <code>npx wrangler secret put OTP_SECRET</code>.'}</div>
      <div class="integ"><span><b>WhatsApp first</b><small>Send codes on WhatsApp when the number is on WhatsApp (recommended).</small></span><label class="switch"><input type="checkbox" id="owf" ${o.whatsapp_first ? 'checked' : ''}><i></i></label></div>
      <div class="integ"><span><b>Bulk SMS fallback</b><small>Use SMS when WhatsApp is not available or the customer asks for SMS.</small></span><label class="switch"><input type="checkbox" id="osf" ${o.sms_fallback ? 'checked' : ''}><i></i></label></div>
      <div class="form-row">
        <div class="field" data-field="daily_sms_cap"><label for="ocap">Daily SMS limit</label><input id="ocap" type="number" min="0" value="${esc(o.daily_sms_cap)}" inputmode="numeric"><div class="hint">Protects your SMS balance from abuse. 0 = no SMS.</div></div>
        <div class="field" data-field="turnstile_site_key"><label for="ots">Turnstile site key <i>(optional)</i></label><input id="ots" value="${esc(o.turnstile_site_key)}" placeholder="0x4AAAAAAA…"><div class="hint">Adds a bot check before mobile sign-in. Needs TURNSTILE_SECRET.</div><div class="hint">Not used by the shop yet — saving a key has no effect, so sign-in can never be blocked by it.</div></div>
      </div>
      <div class="field" data-field="message"><label for="omsg">Code message (WhatsApp and custom SMS)</label><textarea id="omsg" rows="2" maxlength="300">${esc(o.message)}</textarea><div class="hint">Must contain {{code}}. Also available: {{store_name}}, {{minutes}}. DLT SMS providers use their approved template instead.</div></div>

      <h3 class="mt">Bulk SMS provider</h3>
      <div class="field" data-field="provider"><label for="spv">Provider</label><select id="spv">${[['none', 'None'], ['msg91', 'MSG91'], ['fast2sms', 'Fast2SMS'], ['2factor', '2Factor.in'], ['custom', 'Custom HTTP gateway']].map(([k, l]) => `<option value="${k}" ${sm.provider === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="hint" id="smsHelp">${esc(SMS_HELP[sm.provider] || '')}</div><div class="err"></div></div>
      <div class="form-row three" id="smsStd">
        <div class="field" data-field="template_id"><label for="stp">Template / Flow / DLT id</label><input id="stp" value="${esc(sm.template_id)}" maxlength="64"></div>
        <div class="field" data-field="sender_id"><label for="ssd">Sender id</label><input id="ssd" value="${esc(sm.sender_id)}" maxlength="11" placeholder="GOMOCN"></div>
        <div class="field" data-field="var_name"><label for="svn">Variable name</label><input id="svn" value="${esc(sm.var_name)}" maxlength="30" placeholder="otp"></div>
      </div>
      <div id="smsCustom" class="form">
        <div class="form-row"><div class="field" data-field="custom_url" style="flex:3"><label for="scu">URL</label><input id="scu" value="${esc(sm.custom.url)}" placeholder="https://api.example.com/sms?to={{phone91}}"></div>
          <div class="field"><label for="scm">Method</label><select id="scm">${['POST', 'GET', 'PUT'].map((m) => `<option ${sm.custom.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
        <div class="field" data-field="custom_headers"><label for="sch">Headers (JSON)</label><input id="sch" value="${esc(sm.custom.headers)}" placeholder='{"Authorization":"Bearer {{api_key}}"}'></div>
        <div class="field" data-field="custom_body"><label for="scb">Body</label><textarea id="scb" rows="3" placeholder='{"to":"{{phone91}}","text":"{{message}}"}'>${esc(sm.custom.body)}</textarea></div>
        <div class="field"><label for="scs">Success when the response contains <i>(optional)</i></label><input id="scs" value="${esc(sm.custom.success_match)}" placeholder='"status":"ok"'></div>
      </div>
      <p class="muted" style="font-size:.78rem">The provider API key is the Worker secret <code>SMS_API_KEY</code> (${ig.sms_key ? 'set' : 'not set yet'}). India requires DLT registration for SMS — register your sender id and OTP template with your provider first.</p>
      <div><button class="btn btn-primary" type="submit">Save sign-in settings</button></div></form>

    <form class="card form mt" id="otpTest" novalidate><h3>Send a test code</h3>
      <p class="muted" style="font-size:.84rem">Sends a real code to check delivery (the code itself is discarded).</p>
      <div class="form-row">
        <div class="field" data-field="phone"><label for="otn">Mobile number</label><input id="otn" inputmode="tel" placeholder="9876543210"></div>
        <div class="field"><label>Send by</label><div class="seg" id="otc"><button type="button" class="on" data-c="auto">Auto</button><button type="button" data-c="whatsapp">WhatsApp</button><button type="button" data-c="sms">SMS</button></div></div>
      </div>
      <div id="otRes"></div>
      <div><button class="btn btn-dark" type="submit" id="otb">Send test code</button></div></form>`;

  const f = p.querySelector('#otpForm');
  const sync = () => {
    const v = f.querySelector('#spv').value;
    f.querySelector('#smsHelp').textContent = SMS_HELP[v] || '';
    f.querySelector('#smsStd').hidden = v === 'none' || v === 'custom';
    f.querySelector('#smsCustom').hidden = v !== 'custom';
  };
  f.querySelector('#spv').addEventListener('change', sync);
  sync();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    saveMany({
      otp: { whatsapp_first: f.querySelector('#owf').checked, sms_fallback: f.querySelector('#osf').checked, daily_sms_cap: Number(f.querySelector('#ocap').value || 0), message: f.querySelector('#omsg').value, turnstile_site_key: f.querySelector('#ots').value },
      sms: {
        provider: f.querySelector('#spv').value, template_id: f.querySelector('#stp').value, sender_id: f.querySelector('#ssd').value, var_name: f.querySelector('#svn').value,
        custom: { url: f.querySelector('#scu').value, method: f.querySelector('#scm').value, headers: f.querySelector('#sch').value, body: f.querySelector('#scb').value, success_match: f.querySelector('#scs').value },
      },
    }, f.querySelector('[type=submit]'), f);
  });

  const t = p.querySelector('#otpTest');
  let channel = 'auto';
  t.querySelectorAll('#otc [data-c]').forEach((b) => b.addEventListener('click', () => { channel = b.dataset.c; t.querySelectorAll('#otc [data-c]').forEach((x) => x.classList.toggle('on', x === b)); }));
  t.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = t.querySelector('#otb');
    busy(btn, true, 'Sending…');
    const out = t.querySelector('#otRes');
    try {
      const { result } = await api('/api/admin/test-otp', { method: 'POST', body: { phone: t.querySelector('#otn').value, channel } });
      out.innerHTML = `<div class="alert ok">Sent ${result.channel === 'whatsapp' ? 'on WhatsApp' : result.channel === 'sms' ? 'by SMS' : 'in test mode'} to ${esc(result.masked)}.${result.whatsapp === false ? ' This number is not on WhatsApp.' : ''}${result.note ? ` <br><small>${esc(result.note)}</small>` : ''}</div>`;
    } catch (err) {
      out.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      if (err.data?.fields) showFieldErrors(t, err.data.fields);
    }
    busy(btn, false);
  });
}

const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`);

async function storagePanel(p, d) {
  p.innerHTML = `<div class="card">${loading('Checking storage…')}</div>`;
  let s;
  try { s = await api('/api/admin/storage'); } catch (e) { p.innerHTML = `<div class="card"><div class="alert err">${esc(e.message)}</div></div>`; return; }
  const by = s.by_status || {};
  const last = s.last_cleanup;
  p.innerHTML = `<div class="card form"><h3>Photo storage (RustFS / S3)</h3>
      ${s.configured
        ? `<div class="alert ok" style="margin:0">Connected to <b>${esc(s.endpoint)}</b>, bucket <b>${esc(s.bucket)}</b>. Photos are served ${s.public_url ? `from <b>${esc(s.public_url)}</b>` : 'through the Worker (<code>/media/…</code>) with long browser caching'}.</div>`
        : `<div class="alert warn" style="margin:0">Not set up. Add these Worker secrets: <code>S3_ENDPOINT</code> (e.g. https://s3.your-domain.com), <code>S3_BUCKET</code>, <code>S3_ACCESS_KEY_ID</code>, <code>S3_SECRET_ACCESS_KEY</code>. Optional: <code>S3_PUBLIC_URL</code> if the bucket is public behind a CDN.</div>`}
      <div class="g-4 grid">
        <div class="kpi"><small>On products</small><b>${by.attached || 0}</b><span>${mb(s.attached_bytes || 0)}</span></div>
        <div class="kpi"><small>Not saved yet</small><b>${(by.uploaded || 0) + (by.uploading || 0)}</b><span>auto-deleted after 24 h</span></div>
        <div class="kpi"><small>Waiting for delete</small><b>${by.trash || 0}</b><span>removed / replaced</span></div>
        <div class="kpi"><small>Last cleanup</small><b style="font-size:1rem">${last ? esc(fmtAgo(last.at)) : 'Never'}</b><span>${last ? `${last.deleted + last.expired + last.orphans} files removed${last.aborted ? `, ${last.aborted} stuck uploads cleared` : ''}` : 'runs every 30 minutes'}</span></div>
      </div>
      ${last?.errors?.length ? `<div class="alert err" style="margin:0"><b>Last cleanup had problems:</b><br>${last.errors.slice(0, 5).map(esc).join('<br>')}</div>` : ''}
      <p class="muted" style="font-size:.82rem;line-height:1.6">How it works: big photos upload in 8 MB parts and can resume. When you remove or replace a photo and save the product, the old files are deleted from the bucket by the cleanup job (every 30 minutes). Uploads that are never saved are deleted automatically after 24 hours, and unfinished multipart uploads are aborted.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-dark" id="stTest" ${s.configured ? '' : 'disabled'}>Test connection</button><button class="btn btn-line" id="stClean" ${s.configured ? '' : 'disabled'}>Run cleanup now</button></div>
      <div id="stRes"></div></div>`;
  const res = p.querySelector('#stRes');
  p.querySelector('#stTest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Testing…');
    try {
      const r = await api('/api/admin/storage/test', { method: 'POST' });
      res.innerHTML = `<div class="alert ${r.ok ? 'ok' : 'err'}">${r.steps.map((st) => `${st.ok ? '✓' : '✗'} ${esc(st.name)}${st.ms != null ? ` (${st.ms} ms)` : ''}${st.error ? ` — ${esc(st.error)}` : ''}`).join('<br>')}</div>`;
    } catch (err) { res.innerHTML = `<div class="alert err">${esc(err.message)}</div>`; }
    busy(btn, false);
  });
  p.querySelector('#stClean').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Cleaning…');
    try {
      const { summary: sm } = await api('/api/admin/storage/cleanup', { method: 'POST' });
      toast(`Cleanup done: ${sm.deleted + sm.expired + sm.orphans} file group(s) removed`, sm.errors.length ? 'err' : 'ok');
      storagePanel(p, d);
    } catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
  if ((window.GOMO_ADMIN?.areas || []).includes('*')) backupCard(p);
}

// Daily database backups (super admin): stored privately in the bucket under gomo/backups/.
async function backupCard(p) {
  const box = document.createElement('div');
  box.className = 'card mt';
  box.innerHTML = loading('Checking backups…');
  p.appendChild(box);
  let b;
  try { b = await api('/api/admin/backups'); } catch (e) { box.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; return; }
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  box.innerHTML = `<div class="row-between"><h3 style="margin:0">Database backups</h3><button class="btn btn-line btn-sm" id="bkRun">${icon('refresh')} Back up now</button></div>
    <p class="muted" style="font-size:.84rem;line-height:1.6;margin-top:8px">Every day the whole database — orders, customers, products, offers, coupons, settings and team — is saved to your private RustFS bucket. The last ${b.keep_days} days are kept.
      ${b.last ? `Last backup: <b>${esc(fmtAgo(b.last.last_at))}</b> (${kb(b.last.bytes)}).` : '<b>No backup yet</b> — the first one runs within 30 minutes, or click “Back up now”.'}</p>
    ${b.files.length ? `<div class="bk-list">${b.files.slice(0, 7).map((f) => { const name = f.key.split('/').pop(); return `<div class="bk-row"><span class="mono">${esc(name.replace('.json.gz', ''))}</span><span class="muted">${kb(f.size)}</span><button class="btn btn-ghost btn-sm" data-dl="${esc(name)}">Download</button></div>`; }).join('')}</div>` : ''}
    <p class="muted" style="font-size:.76rem;margin-top:10px">To restore: download, unzip the .gz, then Firebase console → Realtime Database → ⋮ → Import JSON (import the <code>data</code> part).</p>`;
  box.querySelector('#bkRun').addEventListener('click', async (e) => {
    const btn = e.currentTarget; busy(btn, true, 'Backing up…');
    try { const { backup } = await api('/api/admin/backups/run', { method: 'POST' }); toast(`Backup saved (${kb(backup.bytes)})`, 'ok'); box.remove(); backupCard(p); }
    catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
  box.querySelectorAll('[data-dl]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const { getToken } = await import('../auth.js');
      const { API_BASE } = await import('../firebase-config.js');
      const res = await fetch(`${API_BASE}/api/admin/backups/${btn.dataset.dl}`, { headers: { authorization: `Bearer ${await getToken()}` } });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `gomo-backup-${btn.dataset.dl}` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) { toast(err.message, 'err'); }
  }));
}

function fmtAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-IN');
}


// ------------------------------------------------------------------ team (staff access)
const ROLE_HELP = {
  manager: 'Orders, payments, products, offers, coupons, customers, messages and exports. No settings.',
  packer: 'Orders only: status, tracking, packing slips and invoices. Can’t change payments.',
  custom: 'Tick exactly which pages this person can open (just for them).',
};
const roleHelp = (d, id) => ROLE_HELP[id] || (() => { const r = d.roles.find((x) => x.id === id); return r ? r.areas.map((a) => d.areas.find((x) => x.id === a)?.label || a).join(' · ') : ''; })();
const roleButtons = (d, current) => `<div class="role-pick">${d.roles.map((r) => `<button type="button" data-role="${esc(r.id)}" class="${r.id === current ? 'on' : ''}">${esc(r.label)}</button>`).join('')}<a class="role-pick-add" href="#/roles">${icon('plus')} New role</a></div>`;
function areaPicker(d, chosen, id) {
  const groups = [...new Set(d.areas.map((a) => a.group))];
  return `<div class="area-pick" id="${id}">${groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${d.areas.filter((a) => a.group === g).map((a) =>
    `<label class="check"><input type="checkbox" value="${esc(a.id)}" ${chosen.includes(a.id) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('')}</fieldset>`).join('')}</div>`;
}
const picked = (root) => [...root.querySelectorAll('.area-pick input:checked')].map((i) => i.value);

async function teamPanel(p) {
  p.innerHTML = `<div class="card">${loading('Loading team…')}</div>`;
  let d;
  try { d = await api('/api/admin/staff'); } catch (e) { p.innerHTML = `<div class="card"><div class="alert err">${esc(e.message)}</div></div>`; return; }
  const ago = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
  const label = (id) => d.areas.find((a) => a.id === id)?.label || id;
  const reqs = d.requests || [];
  p.innerHTML = `
    ${reqs.length ? `<div class="card req-card"><h3>Waiting for approval <span class="pill placed">${reqs.length}</span></h3>
      <p class="muted" style="font-size:.84rem;margin-top:-4px">These people signed in to the admin panel and pressed Request access. Choose what each can open, then approve.</p>
      ${reqs.map((r) => `<div class="req-row" data-req="${esc(r.email)}">
        <div class="team-row"><span class="avatar">${esc((r.name || r.email).charAt(0).toUpperCase())}</span>
          <span class="who"><b>${esc(r.name || r.email)}</b><small>${r.name ? esc(r.email) + ' · ' : ''}asked ${esc(ago(r.at))}</small>${r.note ? `<small class="req-note">“${esc(r.note)}”</small>` : ''}</span></div>
        <label class="req-role"><span>Access</span><select data-req-role aria-label="Access for ${esc(r.email)}">${d.roles.map((x) => `<option value="${esc(x.id)}">${esc(x.id === 'custom' ? 'Custom (pick pages)' : x.label)}</option>`).join('')}</select></label>
        <div class="hint" data-req-help>${esc(roleHelp(d, d.roles.find((x) => x.id !== 'custom')?.id || d.roles[0]?.id))}</div>
        <div data-req-areas hidden>${areaPicker(d, ['orders'], `rq-${esc(r.email).replace(/[^a-z0-9]/gi, '')}`)}</div>
        <div class="req-acts">
          <button class="btn btn-primary btn-sm" data-approve>Approve</button>
          <button class="btn btn-ghost btn-sm" data-decline>Decline</button></div>
      </div>`).join('')}</div>`
    : `<div class="card req-empty"><h3>Access requests</h3>
      <p class="muted" style="font-size:.86rem;line-height:1.6;margin:0">No one is waiting. To add someone, ask them to open the admin panel, sign in with their own Google or email account and press <b>Request access</b>. Their request appears here for you to approve and choose what they can open.</p>
      <div class="quick"><button class="btn btn-line btn-sm" id="copyAdminLink">${icon('copy')} Copy admin link</button></div></div>`}
    <div class="card mt"><h3>Team</h3>
      ${d.owners.map((e) => `<div class="team-row"><span class="avatar">${esc(e.charAt(0).toUpperCase())}</span><span class="who"><b>${esc(e)}</b><small>Super admin · everything</small></span><span class="pill live">Super admin</span></div>`).join('')}
      ${d.staff.map((m) => `<div class="team-row" data-email="${esc(m.email)}"><span class="avatar">${esc((m.name || m.email).charAt(0).toUpperCase())}</span>
        <span class="who"><b>${esc(m.name || m.email)}</b><small>${m.name ? esc(m.email) + ' · ' : ''}last active ${esc(ago(m.last_seen_at))}</small>
          <small class="area-sum">${m.areas.map((a) => esc(label(a))).join(' · ')}</small></span>
        <button class="btn btn-line btn-sm" data-editm>${icon('edit')} ${esc(m.role_label)}</button>
        <label class="switch" title="Allow sign-in (off also disables their Google / email sign-in)"><input type="checkbox" data-active ${m.active ? 'checked' : ''}><i></i></label>
        <button class="btn btn-ghost btn-sm" data-remove aria-label="Remove">${icon('trash')}</button></div>`).join('') || '<p class="muted" style="font-size:.86rem;margin-top:8px">No staff yet.</p>'}
    </div>`;

  p.querySelectorAll('[data-req]').forEach((row) => {
    const email = row.dataset.req;
    const r = reqs.find((x) => x.email === email);
    const sel = row.querySelector('[data-req-role]'), areasBox = row.querySelector('[data-req-areas]');
    // default to the first ready-made role; "Custom" opens the page picker
    const first = d.roles.find((x) => x.id !== 'custom');
    if (first) sel.value = first.id;
    const sync = () => { areasBox.hidden = sel.value !== 'custom'; row.querySelector('[data-req-help]').textContent = roleHelp(d, sel.value); };
    sel.addEventListener('change', sync);
    sync();
    row.querySelector('[data-approve]').addEventListener('click', async (e) => {
      const role = sel.value, areas = role === 'custom' ? picked(row) : undefined;
      if (role === 'custom' && !areas.length) { toast('Tick at least one page they can open.', 'err'); return; }
      busy(e.currentTarget, true);
      try { await api('/api/admin/staff', { method: 'PUT', body: { email, name: r.name, role, areas } }); toast(`${r.name || email} approved`, 'ok'); teamPanel(p); }
      catch (err) { busy(e.currentTarget, false); toast(err.message, 'err'); }
    });
    row.querySelector('[data-decline]').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Decline this request?', message: `${email} won’t be able to open the admin panel or ask again.`, confirmText: 'Decline', danger: true }))) return;
      try { await api(`/api/admin/access-requests/${encodeURIComponent(email)}/decline`, { method: 'POST' }); toast('Declined', 'ok'); teamPanel(p); } catch (err) { toast(err.message, 'err'); }
    });
  });
  p.querySelector('#copyAdminLink')?.addEventListener('click', () => copyText(location.origin + '/'));

  p.querySelectorAll('.team-row[data-email]').forEach((row) => {
    const email = row.dataset.email;
    const m = d.staff.find((x) => x.email === email);
    const save = async (patch) => {
      try { const r = await api('/api/admin/staff', { method: 'PUT', body: { email, name: m.name, role: m.role, areas: m.areas, active: m.active, ...patch } }); toast(r.auth ? `Saved · ${r.auth}` : 'Saved', /could not/.test(r.auth || '') ? 'err' : 'ok'); teamPanel(p); }
      catch (err) { toast(err.message, 'err'); teamPanel(p); }
    };
    row.querySelector('[data-active]').addEventListener('change', (e) => save({ active: e.target.checked }));
    row.querySelector('[data-editm]').addEventListener('click', () => {
      let r = m.role;
      openDialog({
        title: `Access for ${m.name || m.email}`,
        body: `<div class="form">${roleButtons(d, r)}
          <div class="hint" id="em-h">${esc(roleHelp(d, r))}</div>
          <div id="em-areas" ${r === 'custom' ? '' : 'hidden'}>${areaPicker(d, m.areas, 'em-pick')}</div></div>`,
        foot: '<button class="btn btn-line" data-dismiss>Cancel</button><button class="btn btn-primary" id="em-save">Save access</button>',
        onMount(h) {
          const dlg = h.el;
          dlg.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
            r = b.dataset.role;
            dlg.querySelectorAll('[data-role]').forEach((x) => x.classList.toggle('on', x === b));
            dlg.querySelector('#em-h').textContent = roleHelp(d, r);
            dlg.querySelector('#em-areas').hidden = r !== 'custom';
          }));
          dlg.querySelector('#em-save').addEventListener('click', async () => { h.close(true); await save({ role: r, areas: r === 'custom' ? picked(dlg) : undefined }); });
        },
      });
    });
    row.querySelector('[data-remove]').addEventListener('click', async () => {
      if (!confirm(`Remove ${email} from the team?\n\nThey lose admin access immediately, and their Google / email sign-in is deleted, so they can't sign in to the shop with this email either. Their past orders are kept.`)) return;
      try { const r = await api(`/api/admin/staff/${encodeURIComponent(email)}`, { method: 'DELETE' }); toast(`Removed · ${r.auth || 'done'}`, 'ok'); teamPanel(p); } catch (err) { toast(err.message, 'err'); }
    });
  });
}
