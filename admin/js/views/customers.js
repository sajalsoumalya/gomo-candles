import { api } from '../api.js';
import { esc, inr, fmtDate, timeAgo, statusPill, loading, errorBox, icon, toast, busy, debounce, confirmDialog } from '../ui.js';

const filters = { q: '', filter: '', via: '', page: 1 };
const FILTERS = [['', 'All'], ['phone_unverified', 'Mobile not verified'], ['whatsapp_pending', 'WhatsApp to confirm'], ['email_unverified', 'Email not confirmed'], ['no_email', 'No email'], ['disabled', 'Disabled']];
const VIA = { phone: 'Mobile OTP', password: 'Email & password', google: 'Google' };
const ACTIONS = {
  signup_phone: 'Signed up with mobile', signup_password: 'Signed up with email', signup_google: 'Signed up with Google',
  phone_verified: 'Mobile verified', phone_changed: 'Mobile changed', whatsapp_verified: 'WhatsApp confirmed', email_verified: 'Email confirmed',
  merged: 'Combined another account into this one', merged_into: 'Combined into another account', squatting_guard: 'Unverified data detached (email taken over)',
  disabled: 'Disabled by admin', enabled: 'Enabled by admin', auth_admin_error: 'Sign-in service error',
};

const check = (ok, label) => `<span class="vchip ${ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'no'}">${ok === true ? '✓' : ok === 'warn' ? '!' : '–'} ${esc(label)}</span>`;
function badges(c) {
  return [
    check(c.phone_verified ? true : false, 'Mobile'),
    c.phone_verified ? check(c.whatsapp_status === 'verified' ? true : c.whatsapp_status === 'unavailable' ? 'warn' : false, c.whatsapp_status === 'unavailable' ? 'No WhatsApp' : 'WhatsApp') : '',
    check(c.email ? (c.email_verified ? true : 'warn') : false, c.email ? (c.email_verified ? 'Email' : 'Email unconfirmed') : 'No email'),
  ].join('');
}

export async function render(el, ctx) {
  if (ctx.id) return detail(el, ctx);
  el.innerHTML = `
    <div class="page-head"><div><h1>Customers</h1><p>Accounts created on the website. Each mobile number and email belongs to one account.</p></div></div>
    <div class="filters"><div class="chips" id="fchips"></div></div>
    <div class="filters">
      <label class="search">${icon('search')}<input id="q" type="search" placeholder="Name, email or mobile" value="${esc(filters.q)}" aria-label="Search customers"></label>
      <select class="date-in" id="via" aria-label="Signed up with"><option value="">Any sign-up</option>${Object.entries(VIA).map(([k, l]) => `<option value="${k}" ${filters.via === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div id="res">${loading()}</div>`;
  const chips = el.querySelector('#fchips');
  const drawChips = () => { chips.innerHTML = FILTERS.map(([k, l]) => `<button class="chip ${filters.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join(''); };
  drawChips();
  chips.addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filters.filter = b.dataset.f; filters.page = 1; drawChips(); load(); });
  const res = el.querySelector('#res');
  const load = async () => {
    res.innerHTML = loading();
    try {
      const d = await api('/api/admin/customers', { query: filters });
      if (!ctx.isCurrent()) return;
      res.innerHTML = list(d);
      res.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
      res.querySelector('[data-prev]')?.addEventListener('click', () => { filters.page--; load(); });
      res.querySelector('[data-next]')?.addEventListener('click', () => { filters.page++; load(); });
    } catch (e) { res.innerHTML = errorBox(e); }
  };
  el.querySelector('#q').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); filters.page = 1; load(); }, 350));
  el.querySelector('#via').addEventListener('change', (e) => { filters.via = e.target.value; filters.page = 1; load(); });
  load();
}

function list(d) {
  if (!d.customers.length) return '<div class="card empty"><b>No customers found</b>Customers appear here after they sign in on the website.</div>';
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  const rows = d.customers.map((c) => `<tr data-href="#/customers/${esc(c.uid)}">
      <td><b>${esc(c.name || '—')}</b>${c.disabled ? ' <span class="pill failed">Disabled</span>' : ''}<small>${esc(VIA[c.created_via] || c.created_via)} · ${esc(timeAgo(c.created_at))}</small></td>
      <td class="mono">${c.phone ? '+91 ' + esc(c.phone) : '<span class="muted">—</span>'}<small>${esc(c.email || '')}</small></td>
      <td><div class="vchips">${badges(c)}</div></td>
      <td>${c.has_orders ? 'Yes' : '<span class="muted">No</span>'}</td>
      <td class="num"><small>${c.last_login_at ? 'Seen ' + esc(timeAgo(c.last_login_at)) : ''}</small></td></tr>`).join('');
  const cards = d.customers.map((c) => `<a class="list-card" href="#/customers/${esc(c.uid)}">
      <div class="top"><b>${esc(c.name || c.email || ('+91 ' + (c.phone || '')))}</b>${c.disabled ? '<span class="pill failed">Disabled</span>' : ''}</div>
      <div class="meta"><span>${c.phone ? '+91 ' + esc(c.phone) : 'No mobile'}${c.email ? ' · ' + esc(c.email) : ''}</span></div>
      <div class="vchips">${badges(c)}</div></a>`).join('');
  return `<div class="table-wrap responsive"><table><thead><tr><th>Customer</th><th>Contact</th><th>Verified</th><th>Orders</th><th class="num">Last seen</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="list-cards">${cards}</div>
    <div class="pager"><span>${d.total} customer${d.total === 1 ? '' : 's'} · page ${d.page} of ${pages}</span>
      <span style="display:flex;gap:8px"><button class="btn btn-line btn-sm" data-prev ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-line btn-sm" data-next ${d.page >= pages ? 'disabled' : ''}>Next</button></span></div>`;
}

async function detail(el, ctx) {
  el.innerHTML = loading('Loading customer…');
  let d;
  try { d = await api(`/api/admin/customers/${encodeURIComponent(ctx.id)}`); } catch (e) { el.innerHTML = `<a class="back-link" href="#/customers">${icon('back')} Customers</a>${errorBox(e)}`; return; }
  if (!ctx.isCurrent()) return;
  const c = d.customer;
  if (c.merged_into) {
    el.innerHTML = `<a class="back-link" href="#/customers">${icon('back')} Customers</a>
      <div class="card"><h3>Combined account</h3><p>This account was combined into <a href="#/customers/${esc(c.merged_into)}">another account</a> on ${esc(fmtDate(c.merged_at))} after the customer proved they own both.</p></div>`;
    return;
  }
  const prov = c.providers || [];
  el.innerHTML = `<a class="back-link" href="#/customers">${icon('back')} Customers</a>
    <div class="page-head"><div><h1>${esc(c.name || 'Customer')}</h1><p>Joined ${esc(fmtDate(c.created_at))} with ${esc(VIA[c.created_via] || c.created_via)}${c.last_login_at ? ` · last seen ${esc(timeAgo(c.last_login_at))}` : ''}</p></div>
      <div class="actions">${c.disabled ? '<span class="pill failed">Disabled</span>' : ''}
        <button class="btn ${c.disabled ? 'btn-primary' : 'btn-danger'}" id="toggle">${c.disabled ? 'Enable account' : 'Disable account'}</button></div></div>
    <div class="grid g-main">
      <div class="grid" style="align-content:start">
        <div class="card"><h3>Orders</h3>
          ${d.orders.length ? `<div class="items-list">${d.orders.map((o) => `<a class="item-row" href="#/orders/${esc(o.order_no)}"><span><b class="mono">${esc(o.order_no)}</b><small>${esc(fmtDate(o.created_at))} · ${esc(o.payment_label)}</small></span><span style="display:flex;gap:10px;align-items:center">${statusPill(o.status)}<b>${inr(o.total)}</b></span></a>`).join('')}</div>` : '<p class="muted">No orders yet.</p>'}
          ${d.orphaned_orders.length ? `<div class="alert warn mt">Detached for safety (email was taken over by someone else): ${d.orphaned_orders.map((n) => `<a href="#/orders/${esc(n)}">${esc(n)}</a>`).join(', ')}</div>` : ''}
        </div>
        <div class="card"><h3>Account history</h3>
          ${d.audit.length ? `<ul class="timeline">${d.audit.map((a) => `<li><b>${esc(ACTIONS[a.action] || a.action)}</b>${a.detail ? ` <span class="muted">· ${esc(a.detail)}</span>` : ''}<small>${esc(fmtDate(a.at))}</small></li>`).join('')}</ul>` : '<p class="muted">Nothing recorded.</p>'}
        </div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>Contact</h3>
          <dl class="kv">
            <dt>Mobile</dt><dd>${c.phone ? `+91 ${esc(c.phone)} ${c.phone_verified ? `<span class="pill live">Verified${c.phone_verified_via ? ' · ' + esc(c.phone_verified_via === 'sms' ? 'SMS' : c.phone_verified_via === 'whatsapp' ? 'WhatsApp' : c.phone_verified_via) : ''}</span>` : '<span class="pill pending">Not verified</span>'}` : '<span class="muted">—</span>'}</dd>
            <dt>WhatsApp</dt><dd>${c.whatsapp_status === 'verified' ? '<span class="pill live">Confirmed</span>' : c.whatsapp_status === 'unavailable' ? '<span class="pill failed">Not on WhatsApp</span>' : '<span class="pill pending">Not confirmed</span>'}</dd>
            <dt>Email</dt><dd>${c.email ? `${esc(c.email)} ${c.email_verified ? '<span class="pill live">Confirmed</span>' : '<span class="pill pending">Not confirmed</span>'}` : '<span class="muted">—</span>'}</dd>
            <dt>Sign-in</dt><dd>${[c.phone_verified && 'Mobile OTP', prov.includes('password') && 'Email & password', prov.includes('google.com') && 'Google'].filter(Boolean).map(esc).join(', ') || '—'}</dd>
          </dl>
          ${c.phone ? `<div class="quick"><a class="btn btn-line btn-sm" href="tel:+91${esc(c.phone)}">${icon('phone')} Call</a><a class="btn btn-line btn-sm" href="https://wa.me/91${esc(c.phone)}" target="_blank" rel="noopener">${icon('wa')} WhatsApp</a></div>` : ''}
        </div>
        <div class="card"><h3>Saved addresses</h3>
          ${c.addresses.length ? c.addresses.map((a) => `<div class="addr" style="margin-bottom:10px"><b>${esc(a.label || a.name || 'Address')}</b>${a.default ? ' <span class="pill live">Default</span>' : ''}<br>${esc([a.line1, a.line2, a.landmark].filter(Boolean).join(', '))}<br>${esc(`${a.city}, ${a.state} ${a.pincode}`)}
            ${a.lat ? `<br><a href="https://www.google.com/maps?q=${a.lat},${a.lng}" target="_blank" rel="noopener">${icon('ext')} Open map pin</a>` : ''}</div>`).join('') : '<p class="muted">None.</p>'}
        </div>
        ${d.merged_from.length ? `<div class="card"><h3>Combined accounts</h3><p class="muted" style="font-size:.84rem">${d.merged_from.length} earlier account${d.merged_from.length === 1 ? ' was' : 's were'} combined into this one: ${d.merged_from.map((m) => esc(fmtDate(m.at))).join(', ')}.</p></div>` : ''}
        <div class="card"><h3>Account ID</h3><p class="mono" style="font-size:.78rem;word-break:break-all">${esc(c.uid)}</p></div>
      </div>
    </div>`;
  el.querySelector('#toggle').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const disable = !c.disabled;
    if (disable && !(await confirmDialog({ title: 'Disable this account?', message: 'The customer will be signed out and cannot sign in or order until you enable the account again. Their orders are not changed.', confirmText: 'Disable', danger: true }))) return;
    busy(btn, true, disable ? 'Disabling…' : 'Enabling…');
    try {
      await api(`/api/admin/customers/${encodeURIComponent(c.uid)}/${disable ? 'disable' : 'enable'}`, { method: 'POST' });
      toast(disable ? 'Account disabled' : 'Account enabled', 'ok');
      detail(el, ctx);
    } catch (err) { toast(err.message, 'err'); busy(btn, false); }
  });
}
