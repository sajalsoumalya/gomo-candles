import { getStats } from '../stats.js';
import { esc, inr, fmtDate, timeAgo, statusPill, paymentPill, STATUSES, STATUS_LABELS, loading, icon, orderCard } from '../ui.js';

export async function render(el, ctx) {
  el.innerHTML = loading('Loading dashboard…');
  const s = await getStats();
  if (!ctx.isCurrent()) return;
  const total = Object.values(s.by_status).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...Object.values(s.by_status));
  const placed = s.by_status.placed || 0;

  const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = String(window.GOMO_ADMIN?.name || '').trim().split(/\s+/)[0];

  el.innerHTML = `
    <section class="m-hero m-only">
      <small>${esc(hello)}${first ? ', ' + esc(first) : ''}</small>
      <b>${inr(s.today.amount)}</b>
      <span>${s.today.n} order${s.today.n === 1 ? '' : 's'} today · ${esc(new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
      <div class="m-hero-acts"><a class="btn btn-primary btn-sm" href="#/orders?status=placed">${placed ? `Review ${placed} new` : 'Open orders'} ${icon('arrow')}</a><a class="btn btn-glass btn-sm" href="#/offers/new?type=combo">${icon('plus')} New combo</a></div>
    </section>
    <div class="page-head dash-head"><div><h1>Dashboard</h1><p>${esc(new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}</p></div>
      <div class="actions"><a class="btn btn-line" href="#/offers/new?type=combo">${icon('plus')} New combo</a><a class="btn btn-primary" href="#/orders?status=placed">Review new orders ${icon('arrow')}</a></div></div>
    ${s.failed_notifications_7d ? `<a class="alert warn with-ic" href="#/notifications?status=failed">${icon('alert')}<span>${s.failed_notifications_7d} message${s.failed_notifications_7d > 1 ? 's' : ''} failed to send in the last 7 days. <b>Review — retry or dismiss</b></span></a>` : ''}
    ${s.low_stock?.length ? `<a class="alert warn with-ic" href="#/products">${icon('products')}<span><b>Low stock:</b> ${s.low_stock.map((p) => `${esc(p.name)} — ${p.stock === 0 ? '<b>sold out</b>' : `${p.stock} left`}`).join(' · ')}. <b>Update stock</b></span></a>` : ''}
    <div class="grid g-4 kpis">
      <a class="kpi accent" href="#/orders?status=placed"><i class="kpi-ic">${icon('clock')}</i><small>Awaiting confirmation</small><b>${placed}</b><span>${placed ? 'Confirm and notify customers' : 'All caught up'}</span></a>
      <a class="kpi kpi-today" href="#/orders"><i class="kpi-ic">${icon('orders')}</i><small>Today</small><b>${s.today.n}</b><span>${inr(s.today.amount)} in orders</span></a>
      <a class="kpi kpi-cod" href="#/orders?payment=cod_due"><i class="kpi-ic">${icon('cash')}</i><small>COD to collect</small><b>${inr(s.cod_due.amount)}</b><span>${s.cod_due.n} order${s.cod_due.n === 1 ? '' : 's'}</span></a>
      <div class="kpi kpi-rev"><i class="kpi-ic">${icon('trend')}</i><small>Revenue · 7 days</small><b>${inr(s.revenue_7d)}</b><span>${inr(s.revenue_30d)} in 30 days</span></div>
    </div>
    <div class="grid g-main mt">
      <div class="card recent-card"><h3>Recent orders <a class="btn btn-ghost btn-sm" href="#/orders">View all ${icon('arrow')}</a></h3>
        ${s.recent.length ? `<div class="table-wrap responsive" style="box-shadow:none;border:0"><table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>
          ${s.recent.map((o) => `<tr data-href="#/orders/${esc(o.order_no)}"><td><b class="mono">${esc(o.order_no)}</b><small>${esc(timeAgo(o.created_at))}</small></td><td>${esc(o.customer_name)}</td><td>${statusPill(o.status)}</td><td>${paymentPill(o)}</td><td class="num"><b>${inr(o.total)}</b></td></tr>`).join('')}
          </tbody></table></div>
          <div class="list-cards o-list">${s.recent.map(orderCard).join('')}</div>`
          : '<div class="empty"><b>No orders yet</b>Orders placed on the website will appear here.</div>'}
      </div>
      <div class="card"><h3>Orders by status <span class="muted" style="font-family:var(--f-b);text-transform:none;font-size:.8rem">${total} total</span></h3>
        <div class="bars">${STATUSES.map((st) => `<a class="bar-row" style="text-decoration:none" href="#/orders?status=${st}"><span>${esc(STATUS_LABELS[st])}</span><span class="track"><i style="width:${Math.round(((s.by_status[st] || 0) / max) * 100)}%"></i></span><b>${s.by_status[st] || 0}${s.amount_by_status ? `<small>${inr(s.amount_by_status[st] || 0)}</small>` : ''}</b></a>`).join('')}</div>
        <p class="muted mt" style="font-size:.8rem">${s.orders_30d} orders in the last 30 days.</p>
      </div>
    </div>`;
  el.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
  ctx.refreshCounts?.();
}
