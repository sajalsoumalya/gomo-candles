import { api } from '../api.js';
import { photosEditor } from './products.js';
import { esc, inr, artSvg, loading, icon, toast, busy, showFieldErrors, confirmDialog, toLocalInput, fromLocalInput, fmtDate, fmtIst } from '../ui.js';

export async function render(el, ctx) {
  el.innerHTML = loading('Loading offers…');
  const d = await api('/api/admin/offers');
  if (!ctx.isCurrent()) return;
  if (ctx.editor) return editor(el, ctx, d);
  list(el, d);
}

function offerState(o) {
  if (!o.published) return ['draft', 'Draft'];
  const now = Date.now();
  if (o.starts_at && Date.parse(o.starts_at) > now) return ['scheduled', `Starts ${fmtIst(o.starts_at)}`];
  if (o.ends_at && Date.parse(o.ends_at) < now) return ['cancelled', 'Ended'];
  return ['live', o.ends_at ? `Live · ends ${fmtIst(o.ends_at)}` : 'Live'];
}

function offerArt(o) {
  const arts = o.items.map((i) => i.art);
  if (o.type === 'pack') return `<span style="display:flex">${artSvg(arts[0])}${artSvg(arts[0])}</span>`;
  return `<span style="display:flex">${arts.slice(0, 3).map(artSvg).join('')}</span>`;
}

function list(el, d) {
  const combos = d.offers.filter((o) => o.type === 'combo');
  const packs = d.offers.filter((o) => o.type === 'pack');
  const section = (title, items, type) => `
    <div class="row-between mt" style="margin-bottom:12px"><h2 style="font-family:var(--f-d);text-transform:uppercase;font-size:1.2rem">${title}</h2>
      <a class="btn btn-line btn-sm" href="#/offers/new?type=${type}">${icon('plus')} New ${type}</a></div>
    ${items.length ? `<div class="prod-list">${items.map(card).join('')}</div>` : `<div class="card empty"><b>No ${type}s yet</b>${type === 'combo' ? 'Bundle different products at a special price.' : 'Sell several of the same product for less.'}</div>`}`;

  el.innerHTML = `
    <div class="page-head"><div><h1>Offers</h1><p>Combos and packs shown on the website. The “worth” price and savings are calculated from product prices.</p></div>
      <div class="actions"><a class="btn btn-line" href="#/offers/new?type=pack">${icon('plus')} New pack</a><a class="btn btn-primary" href="#/offers/new?type=combo">${icon('plus')} New combo</a></div></div>
    ${section('Combos', combos, 'combo')}
    ${section('Packs', packs, 'pack')}`;

  el.querySelectorAll('[data-pub]').forEach((input) => input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await api(`/api/admin/offers/${input.dataset.pub}/publish`, { method: 'POST', body: { published: input.checked } });
      toast(input.checked ? 'Published — now on the website' : 'Unpublished', 'ok');
      render(el, { isCurrent: () => true });
    } catch (e) { input.checked = !input.checked; input.disabled = false; toast(e.message, 'err'); }
  }));
  el.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => {
    const o = d.offers.find((x) => x.id === b.dataset.dup);
    try {
      const { offer } = await api('/api/admin/offers', { method: 'POST', body: { ...o, name: `${o.name} (copy)`, published: false, items: o.items.map((i) => ({ product_id: i.product_id, qty: i.qty })) } });
      toast('Duplicated as draft', 'ok');
      location.hash = `#/offers/${offer.id}`;
    } catch (e) { toast(e.message, 'err'); }
  }));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const o = d.offers.find((x) => x.id === b.dataset.del);
    if (!(await confirmDialog({ title: 'Delete offer?', message: `Delete “${o.name}”? Past orders keep their details.`, confirmText: 'Delete', danger: true }))) return;
    try { await api(`/api/admin/offers/${o.id}`, { method: 'DELETE' }); toast('Offer deleted', 'ok'); render(el, { isCurrent: () => true }); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

function card(o) {
  const [cls, label] = offerState(o);
  return `<div class="p-card">
    <div class="vis"><span class="pill ${cls}">${esc(label)}</span>${offerArt(o)}</div>
    <div class="body">
      <small>${esc(o.badge || (o.type === 'pack' ? 'Pack' : 'Combo'))}</small>
      <b>${esc(o.name)}</b>
      <small>${esc(o.contents)}</small>
      <div class="price">${inr(o.price)}${o.savings ? `<s>${inr(o.compare_at)}</s><em>Save ${inr(o.savings)}</em>` : ''}</div>
      ${o.price >= o.compare_at ? '<small style="color:var(--err)">Offer price is not lower than buying separately.</small>' : ''}
    </div>
    <div class="foot">
      <label class="switch"><input type="checkbox" data-pub="${esc(o.id)}" ${o.published ? 'checked' : ''}><i></i>Published</label>
      <span style="display:flex;gap:6px">
        <a class="icon-btn" href="#/offers/${esc(o.id)}" aria-label="Edit">${icon('edit')}</a>
        <button class="icon-btn" data-dup="${esc(o.id)}" aria-label="Duplicate">${icon('dup')}</button>
        <button class="icon-btn" data-del="${esc(o.id)}" aria-label="Delete">${icon('trash')}</button></span>
    </div></div>`;
}

// ------------------------------------------------------------------ editor

function editor(el, ctx, d) {
  const isNew = ctx.id === 'new';
  const existing = isNew ? null : d.offers.find((o) => o.id === ctx.id);
  if (!isNew && !existing) { el.innerHTML = '<div class="alert err">Offer not found.</div>'; return; }
  const products = d.products.filter((p) => p.price > 0);
  const byId = Object.fromEntries(d.products.map((p) => [p.id, p]));
  const type0 = existing?.type || (ctx.query.get('type') === 'pack' ? 'pack' : 'combo');
  const st = {
    type: type0,
    name: existing?.name || '',
    badge: existing?.badge || '',
    description: existing?.description || '',
    price: existing?.price || '',
    published: existing ? existing.published : false,
    starts_at: existing?.starts_at || null,
    ends_at: existing?.ends_at || null,
    countdown: existing?.countdown !== false,
    sort: existing?.sort ?? 50,
    items: existing ? existing.items.map((i) => ({ product_id: i.product_id, qty: i.qty }))
      : type0 === 'pack' ? [{ product_id: products[0]?.id || '', qty: 3 }]
        : products.slice(0, 2).map((p) => ({ product_id: p.id, qty: 1 })),
    nameTouched: !!existing,
  };

  const mrpOf = (id) => Math.max(byId[id]?.mrp || 0, byId[id]?.price || 0);
  const compare = () => st.items.reduce((s, i) => s + mrpOf(i.product_id) * (Number(i.qty) || 0), 0);
  const autoName = () => {
    if (st.nameTouched) return;
    if (st.type === 'pack') {
      const p = byId[st.items[0]?.product_id];
      st.name = p ? `${p.name} — Pack of ${st.items[0].qty}` : '';
      st.badge = `Pack of ${st.items[0]?.qty || ''}`;
    } else {
      st.badge = `Combo of ${st.items.reduce((s, i) => s + (Number(i.qty) || 0), 0)}`;
    }
  };

  const syncFromDom = () => {
    const f = el.querySelector('#of');
    if (!f) return;
    st.price = f.querySelector('#op').value;
    st.badge = f.querySelector('#ob').value;
    st.name = f.querySelector('#on').value;
    st.description = f.querySelector('#od').value;
    st.starts_at = fromLocalInput(f.querySelector('#os').value);
    st.ends_at = fromLocalInput(f.querySelector('#oe').value);
    st.countdown = f.querySelector('#ocd')?.checked ?? true;
    st.sort = f.querySelector('#oo').value;
    st.published = f.querySelector('#opub').checked;
  };

  const draw = () => {
    const cmp = compare();
    const price = Number(st.price) || 0;
    const save = cmp - price;
    el.innerHTML = `
      <a class="back-link" href="#/offers">${icon('back')} All offers</a>
      <div class="page-head"><div><h1>${isNew ? `New ${st.type}` : 'Edit offer'}</h1><p>${st.type === 'pack' ? 'One product, several units, one price.' : 'Two or more different products at one price.'}</p></div></div>
      <div class="grid g-main">
        <form class="card form pe" id="of" novalidate>
          ${isNew ? `<section class="pe-sec">
            <div class="pe-h"><h4>Offer type</h4></div>
            <div class="seg pe-seg"><button type="button" data-type="combo" class="${st.type === 'combo' ? 'on' : ''}"><b>Combo</b><small>2+ different products</small></button><button type="button" data-type="pack" class="${st.type === 'pack' ? 'on' : ''}"><b>Pack</b><small>Several of one product</small></button></div>
          </section>` : ''}

          <section class="pe-sec">
            <div class="pe-h"><h4>${st.type === 'pack' ? 'Product &amp; quantity' : 'Products in this combo'}</h4><span>Total MRP ${inr(cmp)}</span></div>
            <div class="field" data-field="items">
              <div class="item-rows">${st.items.map((it, i) => `<div class="item-row">
                <span class="ir-n">${i + 1}</span>
                <select data-i="${i}" data-k="product_id" aria-label="Product">${products.map((p) => `<option value="${esc(p.id)}" ${p.id === it.product_id ? 'selected' : ''}>${esc(p.name)} — ${inr(p.price)}</option>`).join('')}</select>
                <span class="ir-qty"><span>×</span><input data-i="${i}" data-k="qty" type="number" min="${st.type === 'pack' ? 2 : 1}" max="50" value="${esc(it.qty)}" aria-label="Quantity" inputmode="numeric"></span>
                ${st.type === 'combo' && st.items.length > 2 ? `<button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove">${icon('x')}</button>` : '<span></span>'}
              </div>`).join('')}</div>
              ${st.type === 'combo' ? '<button type="button" class="btn btn-line btn-sm" id="addItem" style="justify-self:start;margin-top:10px">' + icon('plus') + ' Add product</button>' : `<div class="chips" style="margin-top:10px">${[2, 3, 4, 6].map((n) => `<button type="button" class="chip ${Number(st.items[0]?.qty) === n ? 'on' : ''}" data-qty="${n}">Pack of ${n}</button>`).join('')}</div>`}
              <div class="err"></div>
            </div>
          </section>

          <section class="pe-sec">
            <div class="pe-h"><h4>Photos <i style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(optional)</i></h4><span>Shown on the combo banner and its page</span></div>
            ${isNew ? '<div class="alert info" style="margin:0">Create the offer first — then you can add its own photos. Until then the product photos are used.</div>'
              : '<div class="field" data-field="images"><div id="offerPhotos"></div><div class="err"></div></div><p class="hint" style="margin:0;font-size:.78rem">No photos? The shop shows the products’ photos together instead.</p>'}
          </section>

          <section class="pe-sec">
            <div class="pe-h"><h4>Price &amp; name</h4><span>Price includes GST</span></div>
            <div class="form-row">
              <div class="field" data-field="price"><label for="op">Offer price</label><div class="pe-money"><span>₹</span><input id="op" type="number" min="1" step="1" value="${esc(st.price)}" inputmode="numeric" placeholder="${cmp ? Math.round(cmp * 0.87) : ''}"></div>
                ${price ? `<div class="hint ${save > 0 ? 'ok-txt' : 'err-txt'}">${save > 0 ? `Customer saves ${inr(save)} (${Math.round((save / cmp) * 100)}%)` : 'Higher than the total MRP'}</div>` : '<div class="hint">Lower than the worth above.</div>'}</div>
              <div class="field" data-field="badge"><label for="ob">Badge</label><input id="ob" value="${esc(st.badge)}" maxlength="30" placeholder="Combo of 3"></div>
            </div>
            <div class="field" data-field="name"><label for="on">Offer name</label><input id="on" value="${esc(st.name)}" maxlength="100" placeholder="${st.type === 'pack' ? 'Evil Eye Candle — Pack of 3' : 'The Complete GoMo Ritual'}"></div>
            <div class="field" data-field="description"><label for="od">Short description <i>(optional)</i></label><textarea id="od" maxlength="500" rows="2" placeholder="One of each — light, freshen and mist your way to calmer evenings.">${esc(st.description)}</textarea></div>
          </section>

          <section class="pe-sec">
            <div class="pe-h"><h4>Schedule</h4><span>India time (IST)</span></div>
            <div class="form-row">
              <div class="field" data-field="starts_at"><label for="os">Starts <i>(optional)</i></label><input id="os" type="datetime-local" value="${esc(toLocalInput(st.starts_at))}"></div>
              <div class="field" data-field="ends_at"><label for="oe">Ends <i>(optional)</i></label><input id="oe" type="datetime-local" value="${esc(toLocalInput(st.ends_at))}"><div class="hint">Removed from the website at this time.</div></div>
            </div>
            <div class="pe-toggles">
              <label class="pe-tg"><span><b>Show countdown</b><small>“Offer ends in 2 days 04 hrs…” on the banner — needs an end time</small></span><span class="switch"><input type="checkbox" id="ocd" ${st.countdown !== false ? 'checked' : ''}><i></i></span></label>
            </div>
          </section>

          <section class="pe-sec">
            <div class="pe-h"><h4>Visibility</h4></div>
            <div class="pe-toggles">
              <label class="pe-tg"><span><b>Publish on website</b><small>Off = saved as a draft, hidden from customers</small></span><span class="switch"><input type="checkbox" id="opub" ${st.published ? 'checked' : ''}><i></i></span></label>
            </div>
            <div class="field" data-field="sort" style="max-width:220px"><label for="oo">Sort order</label><input id="oo" type="number" min="0" value="${esc(st.sort)}"><div class="hint">Lower numbers appear first.</div></div>
          </section>

          <div class="pe-savebar">
            <a class="btn btn-line" href="#/offers">Cancel</a>
            <button class="btn btn-primary" type="submit" id="osave">${isNew ? 'Create offer' : 'Save changes'}</button>
          </div>
        </form>
        <div class="grid" style="align-content:start">
          <div class="card"><h3>Price check</h3>
            <div class="price-preview">
              ${st.items.map((i) => `<div><span>${esc(i.qty)} × ${esc(byId[i.product_id]?.name || '—')} <small class="muted">MRP</small></span><span>${inr(mrpOf(i.product_id) * (Number(i.qty) || 0))}</span></div>`).join('')}
              <div style="border-top:1px dashed var(--line);padding-top:6px;margin-top:4px"><span>Total MRP</span><b>${inr(cmp)}</b></div>
              <div><span>Offer price</span><b>${price ? inr(price) : '—'}</b></div>
              ${price ? `<div class="${save > 0 ? 'save' : 'loss'}"><span>${save > 0 ? 'Customer saves' : 'No saving'}</span><span>${save > 0 ? inr(save) + ` (${Math.round((save / cmp) * 100)}%)` : inr(save)}</span></div>` : ''}
            </div>
            ${price && save <= 0 ? '<div class="alert warn mt" style="margin-bottom:0">The offer price should be lower than buying the items separately.</div>' : ''}
          </div>
          <div class="card"><h3>How it shows</h3>
            <p class="muted" style="font-size:.86rem;line-height:1.6">${st.type === 'combo'
              ? 'Combos appear as the large banner in the “On Offer” section and on the Shop page (with the countdown, if an end time is set), and in the top offer bar.'
              : 'Packs appear in the “On Offer” list and as a “Pack” option on the product card.'}
              Unpublished or scheduled offers are hidden until they go live.</p>
          </div>
        </div>
      </div>`;
    bind();
  };

  let photos = null;
  const bind = () => {
    const host = el.querySelector('#offerPhotos');
    if (host && existing) {
      if (!photos) { photos = photosEditor({ id: `offer-${existing.id}`, images: existing.images || [] }, host); bind.host = host; }
      else if (bind.host !== host) { host.replaceWith(bind.host); } // keep uploads in progress across redraws
    }
    const f = el.querySelector('#of');
    el.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
      syncFromDom();
      st.type = b.dataset.type;
      st.items = st.type === 'pack' ? [{ product_id: st.items[0]?.product_id || products[0]?.id, qty: 3 }] : products.slice(0, 2).map((p) => ({ product_id: p.id, qty: 1 }));
      autoName(); draw();
    }));
    el.querySelectorAll('[data-i]').forEach((inp) => inp.addEventListener('change', () => {
      syncFromDom();
      const it = st.items[Number(inp.dataset.i)];
      it[inp.dataset.k] = inp.dataset.k === 'qty' ? Number(inp.value) : inp.value;
      autoName(); draw();
    }));
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { syncFromDom(); st.items.splice(Number(b.dataset.rm), 1); autoName(); draw(); }));
    el.querySelectorAll('[data-qty]').forEach((b) => b.addEventListener('click', () => { syncFromDom(); st.items[0].qty = Number(b.dataset.qty); autoName(); draw(); }));
    el.querySelector('#addItem')?.addEventListener('click', () => {
      syncFromDom();
      const used = new Set(st.items.map((i) => i.product_id));
      const next = products.find((p) => !used.has(p.id));
      if (!next) return toast('All products are already in this combo.', 'err');
      st.items.push({ product_id: next.id, qty: 1 }); autoName(); draw();
    });
    f.querySelector('#op').addEventListener('change', () => { syncFromDom(); draw(); el.querySelector('#op').focus(); });
    f.querySelector('#on').addEventListener('input', () => { st.nameTouched = true; });
    f.querySelector('#ob').addEventListener('input', () => { st.nameTouched = true; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      syncFromDom();
      const btn = f.querySelector('#osave');
      if (photos?.busy()) return toast('Please wait for the photos to finish uploading.', 'err');
      busy(btn, true);
      const body = {
        type: st.type, name: st.name, badge: st.badge, description: st.description, price: Number(st.price),
        published: st.published, starts_at: st.starts_at, ends_at: st.ends_at, countdown: st.countdown, sort: Number(st.sort || 0),
        items: st.items.map((i) => ({ product_id: i.product_id, qty: Number(i.qty) })),
      };
      if (photos) body.images = photos.payload();
      try {
        await api(isNew ? '/api/admin/offers' : `/api/admin/offers/${existing.id}`, { method: isNew ? 'POST' : 'PUT', body });
        toast(st.published ? 'Saved and published' : 'Saved as draft', 'ok');
        location.hash = '#/offers';
      } catch (err) {
        busy(btn, false);
        if (err.data?.fields) showFieldErrors(f, err.data.fields);
        toast(err.message, 'err');
      }
    });
  };

  autoName();
  draw();
}
