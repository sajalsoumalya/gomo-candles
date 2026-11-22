import { api } from '../api.js';
import { getToken } from '../auth.js';
import { API_BASE } from '../firebase-config.js';
import { esc, inr, fmtDate, timeAgo, statusPill, paymentPill, STATUSES, STATUS_LABELS, loading, errorBox, icon, debounce, toast, orderCard, moreOnScroll } from '../ui.js';
import { getStats } from '../stats.js';

const filters = { status: '', payment: '', q: '', from: '', to: '', page: 1 };

export async function render(el, ctx) {
  // allow deep links like #/orders?status=placed
  if (ctx.query.has('status')) filters.status = ctx.query.get('status');
  if (ctx.query.has('payment')) filters.payment = ctx.query.get('payment');
  if (ctx.query.toString()) filters.page = 1;

  el.innerHTML = `
    <div class="page-head"><div><h1>Orders</h1><p>Confirm, pack, ship — customers are notified at each step.</p></div>
      ${window.GOMO_ADMIN?.areas?.some((x) => x === '*' || x === 'exports') ? `<div class="actions"><button class="btn btn-line" id="exportCsv">${icon('print')} <span>Export CSV</span></button></div>` : ''}</div>
    <div class="filters"><div class="chips" id="statusChips"></div></div>
    <div class="filters">
      <label class="search">${icon('search')}<input id="q" type="search" placeholder="Order no, name, phone or email" value="${esc(filters.q)}" aria-label="Search orders"></label>
      <button class="btn btn-line f-toggle" id="fBtn" type="button" aria-expanded="false" aria-controls="moreF">${icon('filter')} Filters<span class="count" id="fN" hidden></span></button>
      <div class="more-filters" id="moreF">
      <select class="date-in" id="pay" aria-label="Payment filter">
        <option value="">All payments</option>
        <option value="cod_due" ${filters.payment === 'cod_due' ? 'selected' : ''}>COD to collect</option>
        <option value="unpaid_online" ${filters.payment === 'unpaid_online' ? 'selected' : ''}>Online — unpaid</option>
      </select>
      <input class="date-in" type="date" id="from" value="${esc(filters.from)}" aria-label="From date">
      <input class="date-in" type="date" id="to" value="${esc(filters.to)}" aria-label="To date">
      <button class="btn btn-ghost btn-sm" id="reset">Reset</button>
      </div>
    </div>
    <div id="results">${loading()}</div>`;

  el.querySelector('#exportCsv')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'Preparing…';
    try {
      const qs = new URLSearchParams(Object.entries({ status: filters.status, payment: filters.payment, q: filters.q, from: filters.from, to: filters.to }).filter(([, v]) => v)).toString();
      const res = await fetch(`${API_BASE}/api/admin/exports/orders.csv${qs ? '?' + qs : ''}`, { headers: { authorization: `Bearer ${await getToken()}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Export failed (${res.status})`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'gomo-orders.csv';
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('CSV downloaded — opens in Excel or Google Sheets', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    btn.disabled = false; btn.innerHTML = label;
  });

  const counts = await getStats().then((s) => s.by_status).catch(() => ({}));
  if (!ctx.isCurrent()) return;
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const chips = el.querySelector('#statusChips');
  const drawChips = () => {
    chips.innerHTML = [['', 'All', totalAll], ...STATUSES.map((s) => [s, STATUS_LABELS[s], counts[s] || 0])]
      .map(([k, label, n]) => `<button class="chip ${filters.status === k ? 'on' : ''}" data-status="${k}">${esc(label)}<span class="n">${n}</span></button>`).join('');
  };
  drawChips();
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    filters.status = b.dataset.status; filters.page = 1; drawChips(); load();
  });

  const results = el.querySelector('#results');
  // phones: payment and date filters fold behind the Filters button, which shows how many are set
  const moreF = el.querySelector('#moreF'), fBtn = el.querySelector('#fBtn');
  const markFilters = () => { const n = [filters.payment, filters.from, filters.to].filter(Boolean).length; const b = el.querySelector('#fN'); b.textContent = n; b.hidden = !n; };
  fBtn.addEventListener('click', () => { const open = !moreF.classList.contains('open'); moreF.classList.toggle('open', open); fBtn.setAttribute('aria-expanded', String(open)); });
  markFilters();
  const load = async () => {
    markFilters();
    results.innerHTML = loading();
    try {
      const d = await api('/api/admin/orders', { query: filters });
      if (!ctx.isCurrent()) return;
      results.innerHTML = table(d);
      results.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
      moreOnScroll(results, { d, noun: 'orders', items: (p) => p.orders, key: (o) => o.order_no, card: orderCard, fetchPage: (page) => api('/api/admin/orders', { query: { ...filters, page } }) });
      results.querySelector('[data-prev]')?.addEventListener('click', () => { filters.page--; load(); });
      results.querySelector('[data-next]')?.addEventListener('click', () => { filters.page++; load(); });
    } catch (e) { results.innerHTML = errorBox(e); }
  };

  el.querySelector('#q').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); filters.page = 1; load(); }, 350));
  el.querySelector('#pay').addEventListener('change', (e) => { filters.payment = e.target.value; filters.page = 1; load(); });
  el.querySelector('#from').addEventListener('change', (e) => { filters.from = e.target.value; filters.page = 1; load(); });
  el.querySelector('#to').addEventListener('change', (e) => { filters.to = e.target.value; filters.page = 1; load(); });
  el.querySelector('#reset').addEventListener('click', () => {
    Object.assign(filters, { status: '', payment: '', q: '', from: '', to: '', page: 1 });
    history.replaceState(null, '', '#/orders');
    render(el, { ...ctx, query: new URLSearchParams() });
  });
  load();
}

function table(d) {
  if (!d.orders.length) return '<div class="card empty"><b>No orders found</b>Try a different filter.</div>';
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  const rows = d.orders.map((o) => `<tr data-href="#/orders/${esc(o.order_no)}">
      <td><b class="mono">${esc(o.order_no)}</b><small>${esc(fmtDate(o.created_at))}</small></td>
      <td>${esc(o.customer_name)}<small>+91 ${esc(o.phone)}${o.phone_verified === false ? ' (not verified)' : ''} · ${esc(o.city)}</small></td>
      <td>${o.item_count} item${o.item_count === 1 ? '' : 's'}</td>
      <td>${statusPill(o.status)}</td>
      <td>${paymentPill(o)}<small>${o.payment_method === 'cod' ? 'Cash on Delivery' : 'Online'}</small></td>
      <td class="num"><b>${inr(o.total)}</b></td></tr>`).join('');
  const cards = d.orders.map(orderCard).join('');
  return `<div class="table-wrap responsive"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Status</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="list-cards o-list">${cards}</div>
    <div class="pager"><span>${d.total} order${d.total === 1 ? '' : 's'} · page ${d.page} of ${pages}</span>
      <span style="display:flex;gap:8px"><button class="btn btn-line btn-sm" data-prev ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-line btn-sm" data-next ${d.page >= pages ? 'disabled' : ''}>Next</button></span></div>`;
}
