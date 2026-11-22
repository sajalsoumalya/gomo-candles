// Coupons: discount codes customers enter at checkout (step 3). Times are IST.
import { api } from '../api.js';
import { esc, inr, loading, icon, toast, busy, showFieldErrors, confirmDialog, openDialog, toLocalInput, fromLocalInput, fmtIst } from '../ui.js';

export async function render(el, ctx) {
  el.innerHTML = loading('Loading coupons…');
  const d = await api('/api/admin/coupons');
  if (!ctx.isCurrent()) return;
  draw(el, d.coupons, ctx);
}

function state(c) {
  const now = Date.now();
  if (!c.active) return ['draft', 'Off'];
  if (c.starts_at && Date.parse(c.starts_at) > now) return ['scheduled', `Starts ${fmtIst(c.starts_at)}`];
  if (c.ends_at && Date.parse(c.ends_at) < now) return ['cancelled', 'Expired'];
  if (c.usage_limit && c.used_count >= c.usage_limit) return ['cancelled', 'Used up'];
  return ['live', c.ends_at ? `Live · ends ${fmtIst(c.ends_at)}` : 'Live'];
}

function draw(el, coupons, ctx) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Coupons</h1><p>Discount codes customers enter at checkout. One code per order; usage is counted when the order is placed and given back if you cancel it.</p></div>
      <div class="actions"><button class="btn btn-primary fab" id="newC">${icon('plus')} New coupon</button></div></div>
    ${coupons.length ? `<div class="table-wrap responsive"><table><thead><tr><th>Code</th><th>Discount</th><th>Used</th><th>Status</th><th></th></tr></thead><tbody>
      ${coupons.map((c) => { const [cls, label] = state(c); return `<tr data-code="${esc(c.code)}">
        <td><b class="mono">${esc(c.code)}</b>${c.description ? `<small class="muted" style="display:block">${esc(c.description)}</small>` : ''}</td>
        <td>${esc(c.summary)}</td>
        <td>${c.used_count || 0}${c.usage_limit ? ` / ${c.usage_limit}` : ''}</td>
        <td><span class="pill ${cls}">${esc(label)}</span></td>
        <td style="white-space:nowrap;text-align:right"><button class="btn btn-line btn-sm" data-edit>${icon('edit')} Edit</button>
          <button class="btn btn-ghost btn-sm" data-del aria-label="Delete">${icon('trash')}</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="list-cards">${coupons.map((c) => { const [cls, label] = state(c); return `<div class="list-card c-card" data-code="${esc(c.code)}">
        <div class="top"><b class="mono c-code">${esc(c.code)}</b><span class="pill ${cls}">${esc(label)}</span></div>
        ${c.summary ? `<div class="c-sum">${esc(c.summary)}</div>` : ''}${c.description ? `<small class="muted">${esc(c.description)}</small>` : ''}
        <div class="meta"><span>Used ${c.used_count || 0}${c.usage_limit ? ` of ${c.usage_limit}` : ''} time${(c.used_count || 0) === 1 && !c.usage_limit ? '' : 's'}</span>
          <span style="display:flex;gap:6px"><button class="btn btn-line btn-sm" data-edit>${icon('edit')} Edit</button><button class="icon-btn" data-del aria-label="Delete ${esc(c.code)}">${icon('trash')}</button></span></div></div>`; }).join('')}</div>` : `<div class="card"><p class="muted">No coupons yet. Create one, e.g. <b class="mono">WELCOME10</b> for 10% off a first order.</p></div>`}`;

  el.querySelector('#newC').addEventListener('click', () => edit(null, () => render(el, ctx)));
  el.querySelectorAll('[data-code]').forEach((tr) => {
    const c = coupons.find((x) => x.code === tr.dataset.code);
    tr.querySelector('[data-edit]').addEventListener('click', () => edit(c, () => render(el, ctx)));
    tr.querySelector('[data-del]').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Delete ${c.code}?`, message: c.used_count ? 'This code has been used, so it will be switched off and kept for your records.' : 'Customers will no longer be able to use it.', confirmText: 'Delete', danger: true }))) return;
      try { const r = await api(`/api/admin/coupons/${c.code}`, { method: 'DELETE' }); toast(r.archived ? 'Switched off (kept for records)' : 'Deleted', 'ok'); render(el, ctx); } catch (e) { toast(e.message, 'err'); }
    });
  });
}

function edit(c, done) {
  const v = c || { code: '', type: 'percent', value: 10, max_discount: null, min_order: 0, usage_limit: null, per_customer_limit: 1, starts_at: null, ends_at: null, active: true, first_order_only: false, description: '' };
  const n = (x) => (x == null ? '' : esc(x));
  openDialog({
    title: c ? `Edit ${c.code}` : 'New coupon',
    body: `<form class="form" id="cForm" novalidate>
      <div class="form-row">
        <div class="field" data-field="code"><label for="cc">Code</label><input id="cc" value="${n(v.code)}" ${c ? 'disabled' : ''} maxlength="20" style="text-transform:uppercase" placeholder="DIWALI20"><div class="hint">${c ? 'Codes can’t be changed.' : 'Letters, numbers and dashes.'}</div></div>
        <div class="field" data-field="type"><label for="ct">Type</label><select id="ct">
          <option value="percent" ${v.type === 'percent' ? 'selected' : ''}>% off</option>
          <option value="flat" ${v.type === 'flat' ? 'selected' : ''}>₹ off</option>
          <option value="free_shipping" ${v.type === 'free_shipping' ? 'selected' : ''}>Free shipping</option></select></div>
      </div>
      <div class="form-row three" id="cValRow">
        <div class="field" data-field="value"><label for="cv" id="cvl">Discount</label><input id="cv" type="number" min="1" value="${n(v.value)}" inputmode="numeric"></div>
        <div class="field" data-field="max_discount"><label for="cm">Max discount (₹) <i>(optional)</i></label><input id="cm" type="number" min="1" value="${n(v.max_discount)}" inputmode="numeric"></div>
        <div class="field" data-field="min_order"><label for="co">Minimum order (₹)</label><input id="co" type="number" min="0" value="${n(v.min_order)}" inputmode="numeric"></div>
      </div>
      <div class="form-row">
        <div class="field" data-field="usage_limit"><label for="cu">Total uses <i>(empty = unlimited)</i></label><input id="cu" type="number" min="1" value="${n(v.usage_limit)}" inputmode="numeric"></div>
        <div class="field" data-field="per_customer_limit"><label for="cp">Uses per customer <i>(empty = unlimited)</i></label><input id="cp" type="number" min="1" value="${n(v.per_customer_limit)}" inputmode="numeric"></div>
      </div>
      <div class="form-row">
        <div class="field" data-field="starts_at"><label for="cs">Starts <i>(IST, optional)</i></label><input id="cs" type="datetime-local" value="${esc(toLocalInput(v.starts_at))}"></div>
        <div class="field" data-field="ends_at"><label for="ce">Ends <i>(IST, optional)</i></label><input id="ce" type="datetime-local" value="${esc(toLocalInput(v.ends_at))}"></div>
      </div>
      <div class="field" data-field="description"><label for="cd">Note <i>(optional, admin only)</i></label><input id="cd" maxlength="140" value="${n(v.description)}" placeholder="Diwali campaign on Instagram"></div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <label class="switch"><input type="checkbox" id="cf" ${v.first_order_only ? 'checked' : ''}><i></i>First order only</label>
        <label class="switch"><input type="checkbox" id="ca" ${v.active ? 'checked' : ''}><i></i>Active</label>
      </div>
    </form>`,
    foot: `<button class="btn btn-line" data-dismiss>Cancel</button><button class="btn btn-primary" id="cSave">${c ? 'Save' : 'Create coupon'}</button>`,
    onMount(h) {
      const dlg = h.el;
      const f = dlg.querySelector('#cForm');
      const sync = () => {
        const t = f.querySelector('#ct').value;
        f.querySelector('#cvl').textContent = t === 'percent' ? 'Discount (%)' : 'Discount (₹)';
        f.querySelector('[data-field="value"]').hidden = t === 'free_shipping';
        f.querySelector('[data-field="max_discount"]').hidden = t !== 'percent';
      };
      f.querySelector('#ct').addEventListener('change', sync); sync();
      dlg.querySelector('#cSave').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const val = (id) => f.querySelector(id).value;
        const body = {
          code: val('#cc'), type: val('#ct'), value: val('#cv') === '' ? null : Number(val('#cv')), max_discount: val('#cm') === '' ? null : Number(val('#cm')),
          min_order: Number(val('#co') || 0), usage_limit: val('#cu') === '' ? null : Number(val('#cu')), per_customer_limit: val('#cp') === '' ? null : Number(val('#cp')),
          starts_at: fromLocalInput(val('#cs')), ends_at: fromLocalInput(val('#ce')), description: val('#cd'),
          first_order_only: f.querySelector('#cf').checked, active: f.querySelector('#ca').checked,
        };
        busy(btn, true);
        try {
          await api(c ? `/api/admin/coupons/${c.code}` : '/api/admin/coupons', { method: c ? 'PUT' : 'POST', body });
          toast(c ? 'Coupon saved' : 'Coupon created', 'ok');
          h.close(true);
          done();
        } catch (err) { busy(btn, false); if (err.data?.fields) showFieldErrors(f, err.data.fields); toast(err.message, 'err'); }
      });
    },
  });
}
