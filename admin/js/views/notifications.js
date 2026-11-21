import { api } from '../api.js';
import { esc, fmtDate, EVENT_LABELS, CHANNEL_LABELS, loading, icon, toast, busy } from '../ui.js';

const filters = { status: '', page: 1 };

export async function render(el, ctx) {
  if (ctx.query?.has('status')) { filters.status = ctx.query.get('status'); filters.page = 1; }
  el.innerHTML = `
    <div class="page-head"><div><h1>Messages</h1><p>Every WhatsApp, SMS and email sent — order updates and sign-in codes (codes are hidden). “Skipped” means the provider isn’t set up yet (dry run).</p></div></div>
    <div class="filters"><div class="chips" id="chips"></div></div>
    <div id="res">${loading()}</div>`;
  const chips = el.querySelector('#chips');
  const drawChips = () => {
    chips.innerHTML = [['', 'All'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['sent', 'Sent']]
      .map(([k, l]) => `<button class="chip ${filters.status === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('');
  };
  drawChips();
  chips.addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; filters.status = b.dataset.s; filters.page = 1; drawChips(); load(); });

  const res = el.querySelector('#res');
  const load = async () => {
    res.innerHTML = loading();
    try {
      const d = await api('/api/admin/notifications', { query: filters });
      if (!ctx.isCurrent()) return;
      if (!d.notifications.length) { res.innerHTML = '<div class="card empty"><b>No messages</b>Messages appear here when orders are placed or updated.</div>'; return; }
      const pages = Math.max(1, Math.ceil(d.total / d.page_size));
      const retry = (n) => {
        if (n.status === 'sent') return '';
        const r = n.retryable !== false ? `<button class="btn btn-line btn-sm" data-retry="${n.id}">${icon('refresh')} Retry</button>` : '';
        const x = n.status === 'failed' && !n.dismissed ? `<button class="btn btn-ghost btn-sm" data-dismiss-id="${n.id}" title="Hide from the dashboard warning">Dismiss</button>` : '';
        return `<span class="msg-act">${r}${x}</span>`;
      };
      const why = (n) => (n.status === 'failed' && n.is_code ? '<small class="muted">Sign-in code — can’t be resent; the customer just asks for a new one.</small>' : '');
      const chan = (n) => esc(CHANNEL_LABELS[n.channel] || n.channel);
      const openFailed = d.notifications.filter((n) => n.status === 'failed' && !n.dismissed).length;
      res.innerHTML = `
        ${filters.status === 'failed' && openFailed ? `<div class="alert warn row-between" style="margin-bottom:14px"><span>Retry order messages once the provider works again. Old sign-in codes can only be dismissed.</span><button class="btn btn-line btn-sm" id="dismissAll">Dismiss all failed</button></div>` : ''}
        <div class="table-wrap responsive"><table><thead><tr><th>When</th><th>Event</th><th>Channel</th><th>To</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.notifications.map((n) => `<tr style="cursor:default"><td>${esc(fmtDate(n.created_at))}${n.order_no ? `<small><a href="#/orders/${esc(n.order_no)}">${esc(n.order_no)}</a></small>` : ''}</td>
          <td>${esc(EVENT_LABELS[n.event] || n.event)}</td><td>${chan(n)}</td><td class="mono">${esc(n.recipient)}</td>
          <td><span class="pill ${esc(n.status)}">${esc(n.status)}</span>${n.dismissed ? ' <span class="pill pending">dismissed</span>' : ''}${n.error ? `<small>${esc(n.error)}</small>` : ''}${why(n)}${n.attempts > 1 ? `<small>${n.attempts} attempts</small>` : ''}</td>
          <td class="num">${retry(n)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="list-cards">${d.notifications.map((n) => `<div class="list-card"><div class="top"><b>${esc(EVENT_LABELS[n.event] || n.event)}</b><span class="pill ${esc(n.status)}">${esc(n.status)}</span></div>
          <div class="meta"><span>${chan(n)} · ${esc(n.recipient)}</span></div>
          <div class="meta"><span>${esc(fmtDate(n.created_at))}${n.order_no ? ` · <a href="#/orders/${esc(n.order_no)}">${esc(n.order_no)}</a>` : ''}</span>${retry(n)}</div>
          ${n.error ? `<small class="muted">${esc(n.error)}</small>` : ''}${why(n)}</div>`).join('')}</div>
        <div class="pager"><span>${d.total} messages · page ${d.page} of ${pages}</span><span style="display:flex;gap:8px">
          <button class="btn btn-line btn-sm" data-prev ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-line btn-sm" data-next ${d.page >= pages ? 'disabled' : ''}>Next</button></span></div>`;
      res.querySelector('[data-prev]')?.addEventListener('click', () => { filters.page--; load(); });
      res.querySelector('[data-next]')?.addEventListener('click', () => { filters.page++; load(); });
      const dismiss = async (body, b) => {
        if (b) busy(b, true);
        try { const r = await api('/api/admin/notifications/dismiss', { method: 'POST', body }); toast(`${r.dismissed} dismissed`, 'ok'); ctx.refreshCounts?.(); load(); }
        catch (e) { if (b) busy(b, false); toast(e.message, 'err'); }
      };
      res.querySelectorAll('[data-dismiss-id]').forEach((b) => b.addEventListener('click', () => dismiss({ ids: [b.dataset.dismissId] }, b)));
      res.querySelector('#dismissAll')?.addEventListener('click', (e) => dismiss({ all_failed: true }, e.currentTarget));
      res.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
        busy(b, true, 'Sending…');
        try {
          const r = await api(`/api/admin/notifications/${b.dataset.retry}/retry`, { method: 'POST' });
          toast(r.result.status === 'sent' ? 'Sent' : `${r.result.status}: ${r.result.error || ''}`, r.result.status === 'sent' ? 'ok' : 'err');
          load();
        } catch (e) { busy(b, false); toast(e.message, 'err'); }
      }));
    } catch (e) { res.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  };
  load();
}
