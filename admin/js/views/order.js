import { api } from '../api.js';
import { esc, inr, fmtDate, statusPill, paymentPill, STATUSES, STATUS_LABELS, EVENT_LABELS, loading, icon, toast, busy, showFieldErrors, confirmDialog, copyText, initials } from '../ui.js';

const canPay = () => { const a = window.GOMO_ADMIN?.areas || []; return a.includes('*') || a.includes('payments_edit'); };
const FLOW = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
const nextStatus = (s) => FLOW[Math.min(FLOW.indexOf(s) + 1, FLOW.length - 1)] || s;
const EVENT_TEXT = { status: 'Status', payment: 'Payment', tracking: 'Tracking', note: 'Note' };

export async function render(el, ctx) {
  el.innerHTML = loading('Loading order…');
  const d = await api(`/api/admin/orders/${ctx.id}`);
  if (!ctx.isCurrent()) return;
  draw(el, d, ctx);
}

function addressText(o) {
  return [o.customer_name, `+91 ${o.phone}`, o.address_line1, o.address_line2, o.landmark && `Landmark: ${o.landmark}`, `${o.city}, ${o.state} ${o.pincode}`]
    .filter(Boolean).join('\n');
}

function draw(el, d, ctx) {
  const o = d.order;
  const idx = FLOW.indexOf(o.status);
  const locked = o.status === 'cancelled' || o.status === 'delivered';
  const suggested = o.status === 'cancelled' ? 'cancelled' : nextStatus(o.status);
  const canCancel = !['shipped', 'out_for_delivery', 'delivered', 'cancelled'].includes(o.status);
  const units = d.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);

  el.innerHTML = `
    <a class="back-link" href="#/orders">${icon('back')} All orders</a>
    <div class="page-head o-head"><div><h1 class="mono" style="font-family:var(--f-d)">${esc(o.order_no)}</h1>
      <p>Placed ${esc(fmtDate(o.created_at))} · ${statusPill(o.status)} ${paymentPill(o)}</p></div>
      <div class="actions">
        ${o.invoice?.number || o.status !== 'cancelled' ? `<button class="btn btn-line" id="invoice">${icon('print')} ${o.invoice?.number ? 'Invoice ' + esc(o.invoice.number) : 'Create invoice'}</button>` : ''}
        <button class="btn btn-line" id="print">${icon('print')} Packing slip</button></div></div>
    ${['review', 'failed'].includes(o.refund?.status) && o.payment_status === 'paid' ? `<div class="alert err" style="margin-bottom:14px"><b>Refund ${o.refund.status === 'failed' ? 'failed' : 'awaiting review'}.</b> ${esc(o.refund.reason || 'Cancelled')} after an online payment of ${esc(inr(o.total))}. No money has been sent back yet — check the order, then press <b>Process refund</b> in the Payment card.</div>`
      : o.status === 'cancelled' && o.cancelled_by === 'customer' ? `<div class="alert info" style="margin-bottom:14px">Cancelled by the customer.</div>`
      : o.payment_attention && o.payment_status === 'paid' && o.status !== 'cancelled' ? `<div class="alert err" style="margin-bottom:14px"><b>Check this payment.</b> The amount received differs from the order total — see the timeline.</div>` : ''}

    <section class="o-hero m-only st-${esc(o.status)}">
      <div class="oh-top"><span class="o-av" aria-hidden="true">${esc(initials(o.customer_name))}</span>
        <span class="oh-who"><b>${esc(o.customer_name)}</b><small>${esc(o.city)} · ${esc(fmtDate(o.created_at))}</small></span>
        <span class="oh-amt"><b>${inr(o.total)}</b><small>${units} item${units === 1 ? '' : 's'} · ${o.payment_method === 'cod' ? 'COD' : 'Online'}</small></span></div>
      <div class="oh-tags">${statusPill(o.status)}${paymentPill(o)}</div>
      <div class="oh-acts">
        <a href="tel:+91${esc(o.phone)}">${icon('phone')}<span>Call</span></a>
        <a href="https://wa.me/91${esc(o.phone)}" target="_blank" rel="noopener">${icon('wa')}<span>WhatsApp</span></a>
        <button type="button" id="copyAddr2">${icon('copy')}<span>Address</span></button>
        <button type="button" id="print2">${icon('print')}<span>Slip</span></button></div>
    </section>

    <div class="grid g-main order-grid">
      <div class="grid" style="align-content:start">
        <div class="card oc-upd">
          <h3>Update order</h3>
          ${o.status !== 'cancelled' ? `<div class="status-steps">${FLOW.map((s, i) => `<span class="${i <= idx ? 'done' : ''}">${esc(STATUS_LABELS[s])}</span>`).join('')}</div>
            <p class="step-now m-only">Step ${idx + 1} of ${FLOW.length} · <b>${esc(STATUS_LABELS[o.status])}</b>${idx < FLOW.length - 1 ? ` — next: ${esc(STATUS_LABELS[FLOW[idx + 1]])}` : ''}</p>` : '<div class="alert err">This order is cancelled.</div>'}
          ${locked ? '' : `<form class="form" id="upd" novalidate>
            <div class="form-row">
              <div class="field" data-field="status"><label for="st">Status</label>
                <select id="st">${STATUSES.filter((s) => (s === 'cancelled' ? canCancel : FLOW.indexOf(s) >= idx)).map((s) => `<option value="${s}" ${s === suggested ? 'selected' : ''}>${esc(STATUS_LABELS[s])}${s === o.status ? ' (current)' : ''}</option>`).join('')}</select>
                <div class="hint">Orders only move forward — earlier steps can't be picked.</div></div>
              <div class="field" data-field="courier"><label for="cr">Courier <i>(optional)</i></label><input id="cr" value="${esc(o.courier || '')}" maxlength="80" placeholder="e.g. Delhivery"></div>
            </div>
            <div class="form-row">
              <div class="field" data-field="tracking_no"><label for="tn">Tracking number <i>(optional)</i></label><input id="tn" value="${esc(o.tracking_no || '')}" maxlength="80"></div>
              <div class="field" data-field="tracking_url"><label for="tu">Tracking link <i>(optional)</i></label><input id="tu" type="url" value="${esc(o.tracking_url || '')}" maxlength="300" placeholder="https://"></div>
            </div>
            <div class="field" data-field="note"><label for="nt">Internal note <i>(not shown to customer)</i></label><textarea id="nt" maxlength="500" rows="2"></textarea></div>
            <div class="row-between">
              <div style="display:flex;gap:16px;flex-wrap:wrap">
                <label class="check"><input type="checkbox" id="nWa" checked> Notify on WhatsApp</label>
                <label class="check"><input type="checkbox" id="nEm" ${o.email ? 'checked' : 'disabled'}> Notify by email${o.email ? '' : ' (no email)'}</label>
              </div>
              <button class="btn btn-primary" type="submit" id="save">Save update</button>
            </div>
            <p class="muted" style="font-size:.78rem">Customers are notified only when the status changes.</p>
          </form>`}
        </div>

        ${shipCard(d)}

        <div class="card oc-items"><h3>Items</h3>
          <div class="items-list">${d.items.map((i) => `<div class="it"><span>${i.qty} × ${esc(i.name)}${i.contents ? `<small>${esc(i.contents)}</small>` : ''}${i.kind === 'offer' ? '<small>Offer price ' + inr(i.unit_price) + ' (worth ' + inr(i.compare_unit_price) + ')</small>' : ''}</span><b>${inr(i.line_total)}</b></div>`).join('')}</div>
          <div class="sum">
            <div><span>Subtotal</span><span>${inr(o.subtotal)}</span></div>
            ${o.savings ? `<div style="color:var(--ok)"><span>Customer saved</span><span>${inr(o.savings)}</span></div>` : ''}
            ${o.discount ? `<div style="color:var(--ok)"><span>Coupon <b class="mono">${esc(o.coupon_code || '')}</b></span><span>− ${inr(o.discount)}</span></div>` : ''}
            <div><span>Shipping</span><span>${o.shipping ? inr(o.shipping) : 'Free'}</span></div>
            <div class="total"><span>Total</span><span>${inr(o.total)}</span></div>
          </div>
          ${o.notes ? `<div class="alert info mt" style="margin-bottom:0"><b>Customer note:</b> ${esc(o.notes)}</div>` : ''}
        </div>

        <div class="card oc-time"><h3>Timeline</h3>
          <ul class="timeline">${d.events.slice().reverse().map((e) => `<li class="${e.type === 'note' ? 'note' : ''}">
            <b>${e.type === 'status' ? esc(STATUS_LABELS[e.status] || e.status) : esc(EVENT_TEXT[e.type] || e.type)}</b>${e.note ? ` — ${esc(e.note)}` : ''}
            <small>${esc(fmtDate(e.created_at))} · ${esc(e.actor || '')}</small></li>`).join('')}</ul>
        </div>
      </div>

      <div class="grid" style="align-content:start">
        <div class="card oc-cust"><h3>Customer</h3>
          <dl class="kv"><dt>Name</dt><dd>${esc(o.customer_name)}</dd><dt>Mobile</dt><dd>+91 ${esc(o.phone)}${o.phone_verified === false ? ' <span class="pill placed" title="Typed at checkout without a code. Call to confirm before shipping.">Not verified — call to confirm</span>' : ''}</dd><dt>Email</dt><dd>${o.email ? esc(o.email) : '<span class="muted">—</span>'}</dd></dl>
          <div class="quick">
            <a class="btn btn-line btn-sm" href="tel:+91${esc(o.phone)}">${icon('phone')} Call</a>
            <a class="btn btn-line btn-sm" href="https://wa.me/91${esc(o.phone)}" target="_blank" rel="noopener">${icon('wa')} WhatsApp</a>
            ${o.email ? `<a class="btn btn-line btn-sm" href="mailto:${esc(o.email)}?subject=${encodeURIComponent('Your GoMo order ' + o.order_no)}">${icon('mail')} Email</a>` : ''}
          </div>
          <h3 class="mt">Deliver to</h3>
          <div class="addr"><button class="icon-btn copy" id="copyAddr" aria-label="Copy address">${icon('copy')}</button>${esc(addressText(o)).replace(/\n/g, '<br>')}</div>
          ${o.lat != null && o.lng != null ? `<div class="quick"><a class="btn btn-line btn-sm" href="https://www.google.com/maps?q=${encodeURIComponent(o.lat + ',' + o.lng)}" target="_blank" rel="noopener">${icon('pin')} Open map pin</a>${o.location_accuracy ? `<span class="muted" style="font-size:.78rem;align-self:center">±${esc(o.location_accuracy)} m</span>` : ''}</div>` : ''}
          ${o.uid ? `<p class="mt" style="font-size:.84rem"><a href="#/customers/${esc(o.uid)}">${icon('users')} View customer account</a></p>` : ''}
        </div>

        <div class="card oc-pay"><h3>Payment</h3>
          <dl class="kv"><dt>Method</dt><dd>${o.payment_method === 'cod' ? 'Cash on Delivery' : 'Online (Razorpay)'}</dd>
            <dt>Status</dt><dd>${paymentPill(o)}</dd>
            ${o.razorpay_order_id ? `<dt>Razorpay order</dt><dd class="mono">${esc(o.razorpay_order_id)}</dd>` : ''}
            ${o.razorpay_payment_id ? `<dt>Payment id</dt><dd class="mono">${esc(o.razorpay_payment_id)}</dd>` : ''}</dl>
          ${refundBox(o)}
          <div class="quick">
            ${o.payment_method === 'razorpay' && !['paid', 'refunded'].includes(o.payment_status) ? `<button class="btn btn-line btn-sm" id="checkPay" title="Asks Razorpay directly whether the customer paid (for when money left their account but the website never heard back).">${icon('refresh')} Check payment with Razorpay</button>` : ''}
            ${!canPay() ? '<span class="muted" style="font-size:.8rem">Payment changes need the “Mark orders paid / refunded” permission.</span>' : ''}
            ${canPay() && o.payment_status !== 'paid' && o.payment_status !== 'refunded' && o.status !== 'cancelled' ? `<button class="btn btn-primary btn-sm" id="markPaid">${o.payment_method === 'cod' ? 'Mark cash collected' : 'Mark as paid'}</button>` : ''}
            ${canPay() && o.payment_status === 'paid' && !['review', 'processing', 'failed'].includes(o.refund?.status) ? `<button class="btn btn-ghost btn-sm" id="markRefund">${o.payment_method === 'razorpay' ? 'Mark refunded (done outside)' : 'Mark refunded'}</button>` : ''}
          </div>
        </div>

        <div class="card oc-msg"><h3>Messages</h3>
          ${d.notifications.length ? d.notifications.map((n) => `<div class="notif-row"><span>${n.channel === 'email' ? icon('mail') : icon('wa')}</span>
            <span style="flex:1;min-width:0">${esc(EVENT_LABELS[n.event] || n.event)}<small>${esc(n.recipient)} · ${esc(fmtDate(n.created_at))}${n.error ? ' · ' + esc(n.error) : ''}</small></span>
            <span class="pill ${esc(n.status)}">${esc(n.status)}</span></div>`).join('') : '<p class="muted" style="font-size:.86rem">No messages sent yet.</p>'}
          <div class="form mt">
            <div class="form-row"><div class="field"><label for="rsEv">Send again</label><select id="rsEv">
              ${['order_placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'payment_received'].map((ev) => `<option value="${ev}" ${ev === (o.status === 'placed' ? 'order_placed' : o.status) ? 'selected' : ''}>${esc(EVENT_LABELS[ev])}</option>`).join('')}</select></div>
              <div class="field" style="align-self:end"><button class="btn btn-line btn-block" id="resend">${icon('refresh')} Resend to customer</button></div></div>
          </div>
        </div>
      </div>
    </div>`;

  el.querySelector('#copyAddr').addEventListener('click', () => copyText(addressText(o)));
  el.querySelector('#copyAddr2').addEventListener('click', () => copyText(addressText(o)));
  el.querySelector('#print2').addEventListener('click', () => printSlip(d));
  el.querySelector('#print').addEventListener('click', () => printSlip(d));
  el.querySelector('#invoice')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!o.invoice?.number && !(await confirmDialog({ title: 'Create invoice?', message: 'This gives the order the next invoice number. The number never changes afterwards.', confirmText: 'Create invoice' }))) return;
    busy(btn, true, 'Loading…');
    try {
      const { invoice } = await api(`/api/admin/orders/${o.order_no}/invoice`);
      busy(btn, false);
      printInvoice(invoice);
      if (!o.invoice?.number) { o.invoice = { number: invoice.number }; btn.innerHTML = `${icon('print')} Invoice ${esc(invoice.number)}`; }
    } catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });

  const reload = async (data) => { draw(el, data || await api(`/api/admin/orders/${o.order_no}`), ctx); ctx.refreshCounts?.(); };

  const form = el.querySelector('#upd');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = form.querySelector('#st').value;
    if (status === 'cancelled' && !(await confirmDialog({ title: 'Cancel order?', message: `Cancel ${o.order_no}? The customer will be notified if you keep notifications on.`, confirmText: 'Cancel order', danger: true }))) return;
    const btn = form.querySelector('#save');
    busy(btn, true);
    try {
      const res = await api(`/api/admin/orders/${o.order_no}`, {
        method: 'PATCH',
        body: {
          status, courier: form.querySelector('#cr').value, tracking_no: form.querySelector('#tn').value,
          tracking_url: form.querySelector('#tu').value, note: form.querySelector('#nt').value,
          notify: { whatsapp: form.querySelector('#nWa').checked, email: form.querySelector('#nEm').checked },
        },
      });
      const sent = res.sent || [];
      const ok = sent.filter((s) => s.status === 'sent').length;
      const skipped = sent.filter((s) => s.status === 'skipped').length;
      const failed = sent.filter((s) => s.status === 'failed').length;
      toast(`Saved${sent.length ? ` · ${ok} sent${skipped ? `, ${skipped} skipped (provider not set up)` : ''}${failed ? `, ${failed} failed` : ''}` : ''}`, failed ? 'err' : 'ok');
      reload(res);
    } catch (err) {
      busy(btn, false);
      if (err.data?.fields) showFieldErrors(form, err.data.fields);
      toast(err.message, 'err');
    }
  });

  el.querySelector('#markPaid')?.addEventListener('click', async (e) => {
    if (!(await confirmDialog({ title: o.payment_method === 'cod' ? 'Cash collected?' : 'Mark as paid?', message: `Record ${inr(o.total)} as received for ${o.order_no}.`, confirmText: 'Yes, mark paid' }))) return;
    try { reload(await api(`/api/admin/orders/${o.order_no}`, { method: 'PATCH', body: { payment_status: 'paid' } })); toast('Payment recorded', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });
  el.querySelector('#markRefund')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Mark refunded?', message: 'Only do this after you have refunded the customer (e.g. from the Razorpay dashboard).', confirmText: 'Mark refunded', danger: true }))) return;
    try { reload(await api(`/api/admin/orders/${o.order_no}`, { method: 'PATCH', body: { payment_status: 'refunded' } })); }
    catch (err) { toast(err.message, 'err'); }
  });
  // Shiprocket
  const sf = el.querySelector('#srForm');
  sf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sr = o.shiprocket || {};
    const cash = o.payment_method === 'cod' && o.payment_status !== 'paid';
    if (!(await confirmDialog({
      title: sr.shipment_id ? 'Continue booking?' : 'Book pickup with Shiprocket?',
      message: `Shiprocket assigns a courier and charges the shipment to your Shiprocket wallet. ${cash ? `The courier will collect ${inr(o.total)} in cash.` : 'Prepaid: the courier collects nothing.'}`,
      confirmText: sr.shipment_id ? 'Continue booking' : 'Book pickup',
    }))) return;
    const btn = sf.querySelector('#srGo');
    const val = (id) => sf.querySelector(id)?.value ?? '';
    busy(btn, true, 'Booking with Shiprocket…');
    try {
      const r = await api(`/api/admin/orders/${o.order_no}/shiprocket/book`, { method: 'POST', body: {
        weight_kg: val('#srW'), length_cm: val('#srL'), breadth_cm: val('#srB'), height_cm: val('#srH'), pickup_date: val('#srD'),
      } });
      toast(`Pickup booked · ${r.shiprocket.courier_name || 'courier'} · AWB ${r.shiprocket.awb}`, 'ok');
      reload();
    } catch (err) {
      busy(btn, false);
      if (err.data?.fields) showFieldErrors(sf, err.data.fields);
      toast(err.message, 'err');
      if (err.data?.code === 'shiprocket_step') reload();
    }
  });
  el.querySelector('#srSync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Checking…');
    try {
      const r = await api(`/api/admin/orders/${o.order_no}/shiprocket/sync`, { method: 'POST' });
      toast(r.moved ? `Order moved to ${STATUS_LABELS[r.moved] || r.moved}` : `Courier status: ${r.shiprocket.status || r.shiprocket.sync_error || 'no update yet'}`, 'ok');
      reload();
    } catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
  el.querySelector('#srCancel')?.addEventListener('click', async (e) => {
    if (!(await confirmDialog({ title: 'Cancel the Shiprocket booking?', message: 'The pickup and AWB are cancelled in Shiprocket. The order itself stays as it is, and you can book again.', confirmText: 'Cancel booking', danger: true }))) return;
    const btn = e.currentTarget;
    busy(btn, true, 'Cancelling…');
    try { await api(`/api/admin/orders/${o.order_no}/shiprocket/cancel`, { method: 'POST' }); toast('Shiprocket booking cancelled', 'ok'); reload(); }
    catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
  el.querySelector('#srCopy')?.addEventListener('click', () => copyText(o.shiprocket.awb));

  el.querySelector('#checkPay')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Asking Razorpay…');
    try {
      const r = await api(`/api/admin/orders/${o.order_no}/check-payment`, { method: 'POST' });
      const msg = {
        paid: r.already ? 'Already recorded as paid.' : 'Payment found at Razorpay and recorded.',
        authorized: 'The bank approved a payment; Razorpay is still confirming it. Check again in a few minutes.',
        not_paid: 'Razorpay has no completed payment for this order.',
        not_configured: 'Razorpay is not connected on the server.',
      }[r.state] || 'Checked.';
      toast(msg, r.paid ? 'ok' : r.state === 'authorized' ? 'ok' : 'err');
      reload();
    } catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
  const rf = el.querySelector('#refundForm');
  rf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number(rf.querySelector('#rfAmt').value);
    if (!(await confirmDialog({
      title: `Refund ${inr(amount)}?`,
      message: `Razorpay will send ${inr(amount)} back to ${o.customer_name}'s original payment method (usually 5–7 working days). This can't be undone.`,
      confirmText: 'Yes, process refund', danger: true,
    }))) return;
    const btn = rf.querySelector('#rfGo');
    busy(btn, true, 'Sending to Razorpay…');
    try {
      const r = await api(`/api/admin/orders/${o.order_no}/refund`, { method: 'POST', body: { amount, note: rf.querySelector('#rfNote').value } });
      toast(r.refund?.status === 'processed' ? 'Refund completed' : 'Refund initiated at Razorpay', 'ok');
      reload();
    } catch (err) {
      busy(btn, false);
      if (err.data?.fields) showFieldErrors(rf, err.data.fields);
      toast(err.message, 'err');
      if (err.status !== 422) reload();
    }
  });
  el.querySelector('#rfRefresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Checking…');
    try {
      const r = await api(`/api/admin/orders/${o.order_no}/refund/refresh`, { method: 'POST' });
      toast(r.refund?.status === 'processed' ? 'Refund completed' : r.refund?.status === 'failed' ? 'Razorpay reports the refund failed' : 'Still in progress at Razorpay', r.refund?.status === 'failed' ? 'err' : 'ok');
      reload();
    } catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
  el.querySelector('#resend').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Sending…');
    try {
      const r = await api(`/api/admin/orders/${o.order_no}/notify`, { method: 'POST', body: { event: el.querySelector('#rsEv').value } });
      const statuses = r.sent.map((s) => `${s.channel}: ${s.status}`).join(', ');
      toast(statuses || 'Nothing to send (notifications turned off in Settings)', r.sent.some((s) => s.status === 'failed') ? 'err' : 'ok');
      reload();
    } catch (err) { busy(btn, false); toast(err.message, 'err'); }
  });
}

// Courier pickup through Shiprocket: book → (courier picks up) → tracking updates move the order forward
function shipCard(d) {
  const o = d.order, sr = o.shiprocket || {}, ready = d.shipping?.ready;
  const parcel = { ...(d.shipping?.parcel || {}), ...(sr.parcel ? { weight_kg: sr.parcel.weight, length_cm: sr.parcel.length, breadth_cm: sr.parcel.breadth, height_cm: sr.parcel.height } : {}) };
  const booked = sr.awb && sr.pickup_requested;
  const history = (sr.history || []).length ? `<p class="muted" style="font-size:.76rem;margin:8px 0 0">Earlier bookings cancelled: ${sr.history.map((h) => esc(h.awb || `#${h.sr_order_id}`)).join(', ')}</p>` : '';
  if (!ready) {
    if (!booked) return `<div class="card ship-card"><h3>Courier pickup</h3><p class="muted" style="font-size:.84rem;margin:0">Connect Shiprocket to book courier pickups from this page: add <span class="mono">SHIPROCKET_EMAIL</span> and <span class="mono">SHIPROCKET_PASSWORD</span> (an API user from Shiprocket → Settings → API) to the server. Until then, enter the courier and tracking number above.</p></div>`;
  }
  if (booked) {
    const canCancel = !sr.picked_up && !['shipped', 'out_for_delivery', 'delivered'].includes(o.status) && ready;
    const acts = (sr.activities || []).slice(0, 3);
    return `<div class="card ship-card"><h3>Courier pickup · Shiprocket</h3>
      ${sr.attention ? `<div class="alert err" style="margin-bottom:10px"><b>${esc(sr.attention)}</b> — check this shipment in Shiprocket (the order status was not changed).</div>` : ''}
      <dl class="kv">
        <dt>Courier</dt><dd>${esc(sr.courier_name || o.courier || '—')}</dd>
        <dt>AWB</dt><dd><span class="mono">${esc(sr.awb)}</span> <button class="icon-btn" id="srCopy" aria-label="Copy AWB">${icon('copy')}</button></dd>
        <dt>Pickup</dt><dd>${sr.pickup_scheduled_date ? esc(sr.pickup_scheduled_date) : 'Requested'}${sr.pickup_token ? `<small class="muted"> · ${esc(sr.pickup_token)}</small>` : ''}</dd>
        <dt>Status</dt><dd>${esc(sr.status || 'Pickup scheduled')}${sr.etd ? `<small class="muted"> · expected ${esc(sr.etd)}</small>` : ''}</dd>
        <dt>Collect</dt><dd>${sr.cod_amount ? `<b>${inr(sr.cod_amount)} cash</b>` : 'Prepaid'}</dd>
        ${sr.last_sync ? `<dt>Updated</dt><dd>${esc(fmtDate(sr.last_sync))}${sr.sync_error ? `<small class="muted"> · ${esc(sr.sync_error)}</small>` : ''}</dd>` : ''}
      </dl>
      ${acts.length ? `<ul class="ship-acts">${acts.map((a) => `<li><b>${esc(a.activity)}</b><small>${esc(a.date || '')}${a.location ? ` · ${esc(a.location)}` : ''}</small></li>`).join('')}</ul>` : ''}
      <div class="quick">
        ${sr.label_url ? `<a class="btn btn-primary btn-sm" href="${esc(sr.label_url)}" target="_blank" rel="noopener">${icon('print')} Print label</a>` : ''}
        ${sr.manifest_url ? `<a class="btn btn-line btn-sm" href="${esc(sr.manifest_url)}" target="_blank" rel="noopener">Manifest</a>` : ''}
        ${ready ? `<button class="btn btn-line btn-sm" id="srSync">${icon('refresh')} Refresh tracking</button>` : ''}
        ${canCancel ? '<button class="btn btn-ghost btn-sm" id="srCancel">Cancel shipment</button>' : ''}
      </div>
      <p class="muted" style="font-size:.76rem;margin:8px 0 0">Courier updates move the order to Shipped, Out for delivery and Delivered automatically.</p>${history}</div>`;
  }
  if (['cancelled', 'delivered'].includes(o.status)) return '';
  const unpaidOnline = o.payment_method === 'razorpay' && o.payment_status !== 'paid';
  const cash = o.payment_method === 'cod' && o.payment_status !== 'paid';
  const v = (x) => (x == null ? '' : esc(x));
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `<div class="card ship-card"><h3>Courier pickup · Shiprocket</h3>
    ${sr.error ? `<div class="alert err" style="margin-bottom:10px"><b>Booking stopped at: ${esc({ create: 'creating the Shiprocket order', awb: 'assigning a courier', pickup: 'requesting the pickup' }[sr.error.step] || sr.error.step)}.</b> ${esc(sr.error.message)}</div>` : ''}
    ${unpaidOnline ? '<div class="alert info" style="margin-bottom:10px">Waiting for the online payment — book the pickup once it is paid.</div>' : ''}
    <form class="form" id="srForm" novalidate>
      ${sr.shipment_id ? `<p style="font-size:.86rem;margin:0">Shiprocket order <span class="mono">#${esc(sr.sr_order_id)}</span> is created${sr.awb ? ` and courier ${esc(sr.courier_name || '')} assigned (AWB <span class="mono">${esc(sr.awb)}</span>)` : ''}. Continue to finish the booking.</p>`
        : `<div class="form-row">
          <div class="field" data-field="weight_kg"><label for="srW">Weight (kg)</label><input id="srW" type="number" step="0.01" min="0.01" max="50" value="${v(parcel.weight_kg)}" inputmode="decimal"></div>
          <div class="field" data-field="pickup_date"><label for="srD">Pickup date <i>(optional)</i></label><input id="srD" type="date" min="${today}"><div class="hint">Empty = next available slot.</div></div>
        </div>
        <div class="form-row three">
          <div class="field" data-field="length_cm"><label for="srL">Length (cm)</label><input id="srL" type="number" step="0.5" min="0.5" value="${v(parcel.length_cm)}" inputmode="decimal"></div>
          <div class="field" data-field="breadth_cm"><label for="srB">Breadth (cm)</label><input id="srB" type="number" step="0.5" min="0.5" value="${v(parcel.breadth_cm)}" inputmode="decimal"></div>
          <div class="field" data-field="height_cm"><label for="srH">Height (cm)</label><input id="srH" type="number" step="0.5" min="0.5" value="${v(parcel.height_cm)}" inputmode="decimal"></div>
        </div>`}
      <div class="row-between">
        <span style="font-size:.84rem">${cash ? `Courier collects <b>${inr(o.total)}</b> cash` : unpaidOnline ? 'Online payment pending' : 'Prepaid — courier collects nothing'}</span>
        <button class="btn btn-primary" type="submit" id="srGo" ${unpaidOnline ? 'disabled' : ''}>${sr.shipment_id ? 'Continue booking' : 'Book pickup with Shiprocket'}</button>
      </div>
    </form>${history}</div>`;
}

// Online refund: awaiting review → (Process refund) → initiated → refunded
function refundBox(o) {
  const rf = o.refund;
  if (!rf || o.payment_method !== 'razorpay') return '';
  if ((rf.status === 'review' || rf.status === 'failed') && o.payment_status === 'paid') {
    return `<div class="refund-box ${rf.status}">
      <b>${rf.status === 'failed' ? 'Refund failed' : 'Refund: awaiting review'}</b>
      <p>${rf.status === 'failed' ? `${esc(rf.error || 'Razorpay could not complete the refund.')} You can try again.` : `${esc(rf.reason || 'Order cancelled')}. No money has been sent back yet.`}${rf.error && rf.status === 'review' ? ` <br><small>${esc(rf.error)}</small>` : ''}</p>
      ${canPay() ? `<form class="form" id="refundForm" novalidate>
        <div class="form-row">
          <div class="field" data-field="amount"><label for="rfAmt">Refund amount (₹)</label><input id="rfAmt" type="number" min="1" max="${esc(o.total)}" step="1" value="${esc(rf.amount || o.total)}" inputmode="numeric"><div class="hint">Full payment: ${inr(o.total)}. Lower it for a partial refund.</div></div>
          <div class="field" data-field="note"><label for="rfNote">Note <i>(optional, internal)</i></label><input id="rfNote" maxlength="200"></div>
        </div>
        <div><button class="btn btn-primary" type="submit" id="rfGo">Process refund</button></div>
        <p class="muted" style="font-size:.78rem;margin:0">Razorpay returns the money to the customer's original payment method, usually in 5–7 working days.</p>
      </form>` : '<p class="muted" style="font-size:.8rem">Processing refunds needs the “Mark orders paid / refunded” permission.</p>'}</div>`;
  }
  if (rf.status === 'processing') {
    return `<div class="refund-box processing"><b>Refund initiated · ${inr(rf.amount)}</b>
      <p>Razorpay refund <span class="mono">${esc(rf.refund_id || '')}</span>, started ${esc(fmtDate(rf.initiated_at))}${rf.initiated_by ? ` by ${esc(rf.initiated_by)}` : ''}. It changes to Refunded when Razorpay confirms.</p>
      <button class="btn btn-line btn-sm" id="rfRefresh">${icon('refresh')} Refresh refund status</button></div>`;
  }
  if (rf.status === 'processed') {
    return `<div class="refund-box processed"><b>Refunded ${inr(rf.amount)}</b>
      <p>Completed ${esc(fmtDate(rf.processed_at))}${rf.arn ? ` · bank reference <span class="mono">${esc(rf.arn)}</span>` : ''}${rf.refund_id ? ` · <span class="mono">${esc(rf.refund_id)}</span>` : ''}</p></div>`;
  }
  return '';
}

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function printInvoice(v) {
  const tax = v.mode === 'tax';
  const intra = v.tax_type === 'cgst_sgst';
  const s = v.seller, b = v.buyer, t = v.totals;
  // Rates can differ per product, so the % is shown on each line, not in the header.
  const taxCols = !tax ? '' : intra ? '<th>CGST</th><th>SGST</th>' : '<th>IGST</th>';
  const pct = (r, half) => (r == null ? '' : `<br><small>${half ? r / 2 : r}%</small>`);
  const taxCells = (l) => (!tax ? '' : l.is_discount ? (intra ? '<td></td><td></td>' : '<td></td>') : intra ? `<td class="r">${money(l.cgst)}${pct(l.rate, true)}</td><td class="r">${money(l.sgst)}${pct(l.rate, true)}</td>` : `<td class="r">${money(l.igst)}${pct(l.rate)}</td>`);
  const slip = document.getElementById('slip');
  slip.innerHTML = `<div class="inv">
    <div class="inv-head"><div><h1>${esc(v.title)}</h1>${v.cancelled ? '<p><b>CANCELLED</b></p>' : ''}</div>
      <div class="r"><b>${esc(v.number)}</b><br>Date: ${esc(fmtDate(v.issued_at, false))}<br>Order: ${esc(v.order.order_no)}</div></div>
    <div class="inv-parties">
      <div><small>Sold by</small><b>${esc(s.name)}</b>${s.address ? `<br>${esc(s.address)}` : ''}${s.state ? `<br>${esc(s.state)}` : ''}${s.gstin ? `<br>GSTIN: ${esc(s.gstin)}` : ''}${s.email ? `<br>${esc(s.email)}` : ''}</div>
      <div><small>Bill / ship to</small><b>${esc(b.name)}</b><br>${esc(b.address)}<br>${esc(b.city)}, ${esc(b.state)} ${esc(b.pincode)}<br>+91 ${esc(b.phone)}${b.email ? `<br>${esc(b.email)}` : ''}${tax ? `<br>Place of supply: ${esc(b.state)}` : ''}</div>
    </div>
    <table><thead><tr><th>#</th><th>Item</th>${tax ? '<th>HSN/SAC</th>' : ''}<th>Qty</th><th>Rate</th>${tax ? '<th>Taxable</th>' : ''}${taxCols}<th>Amount</th></tr></thead>
    <tbody>${v.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}${l.contents ? `<br><small>${esc(l.contents)}</small>` : ''}</td>${tax ? `<td>${esc(l.hsn)}${l.rate != null ? `<br><small>GST ${l.rate}%</small>` : ''}</td>` : ''}<td>${l.qty}</td><td class="r">${money(l.unit_price)}</td>${tax ? `<td class="r">${l.is_discount ? '' : money(l.taxable)}</td>` : ''}${taxCells(l)}<td class="r">${money(l.amount)}</td></tr>`).join('')}</tbody>
    <tfoot>${tax ? `<tr><td colspan="${5}" class="r">Total taxable value</td><td class="r">${money(t.taxable)}</td>${intra ? `<td class="r">${money(t.cgst)}</td><td class="r">${money(t.sgst)}</td>` : `<td class="r">${money(t.igst)}</td>`}<td></td></tr>` : ''}
      <tr class="grand"><td colspan="${tax ? (intra ? 8 : 7) : 4}" class="r">Total${tax ? ' (incl. GST)' : ''}</td><td class="r">${money(t.gross)}</td></tr></tfoot></table>
    ${tax && (v.rate_summary || []).length > 1 ? `<p><b>GST summary:</b> ${v.rate_summary.map((x) => `${x.rate}% on ${money(x.taxable)} = ${money(x.tax)}`).join(' · ')}</p>` : ''}
    <p>Payment: ${v.order.payment_method === 'cod' ? 'Cash on Delivery' : 'Online (Razorpay)'} · ${esc(v.order.payment_status === 'paid' ? 'Paid' : 'Due')}</p>
    ${tax ? '' : '<p class="muted">Prices are inclusive of all taxes.</p>'}
    <p class="muted">This is a computer-generated invoice and needs no signature.</p></div>`;
  const prev = document.title;
  document.title = v.number.replace(/\//g, '-'); // default "Save as PDF" file name
  window.print();
  document.title = prev;
}

function printSlip(d) {
  const o = d.order;
  const slip = document.getElementById('slip');
  slip.innerHTML = `<h1>GoMo Candles — Packing slip</h1>
    <p><b>${esc(o.order_no)}</b> · ${esc(fmtDate(o.created_at))} · ${o.payment_method === 'cod' && o.payment_status !== 'paid' ? `<b>COD: collect ${inr(o.total)}</b>` : 'PREPAID'}</p>
    <p style="margin-top:12px;white-space:pre-line">${esc(addressText(o))}</p>
    <table><thead><tr><th>Qty</th><th>Item</th><th>Contents</th></tr></thead>
    <tbody>${d.items.map((i) => `<tr><td>${i.qty}</td><td>${esc(i.name)}</td><td>${esc(i.contents || '')}</td></tr>`).join('')}</tbody></table>
    ${o.notes ? `<p style="margin-top:12px"><b>Note:</b> ${esc(o.notes)}</p>` : ''}`;
  window.print();
}
