import { api } from '../api.js';
import { esc, inr, artSvg, ART, loading, icon, toast, busy, showFieldErrors, openDialog, confirmDialog } from '../ui.js';
import { prepare, upload, discard, mediaUrl, pendingUploads, forgetPending, ACCEPT } from '../upload.js';

let products = [];

export async function render(el, ctx) {
  el.innerHTML = loading('Loading products…');
  const d = await api('/api/admin/products');
  if (!ctx.isCurrent()) return;
  products = d.products;
  draw(el);
}

function draw(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Products</h1><p>Single items with their photos. Combos and packs are built from these on the Offers page.</p></div>
      <div class="actions"><button class="btn btn-primary" id="new">${icon('plus')} New product</button></div></div>
    ${products.length ? `<div class="prod-list">${products.map(card).join('')}</div>` : '<div class="card empty"><b>No products</b>Add your first product.</div>'}`;

  el.querySelector('#new').addEventListener('click', () => editDialog(null, el));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editDialog(products.find((p) => p.id === b.dataset.edit), el)));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove(products.find((p) => p.id === b.dataset.del), el)));
  el.querySelectorAll('[data-toggle]').forEach((input) => input.addEventListener('change', async () => {
    const [id, key] = input.dataset.toggle.split(':');
    input.disabled = true;
    try {
      const { product } = await api(`/api/admin/products/${id}`, { method: 'PUT', body: { [key]: input.checked } });
      products = products.map((p) => (p.id === id ? { ...p, ...product } : p));
      toast(`${product.name}: ${key === 'published' ? (product.published ? 'visible on site' : 'hidden') : (product.in_stock ? 'in stock' : 'out of stock')}`, 'ok');
      draw(el);
    } catch (e) { input.checked = !input.checked; input.disabled = false; toast(e.message, 'err'); }
  }));
}

function card(p) {
  const cover = p.images?.[0];
  return `<div class="p-card">
    <div class="vis${cover ? ' has-photo' : ''}">${p.published ? '<span class="pill live">On site</span>' : '<span class="pill draft">Hidden</span>'}
      ${cover ? `<img src="${esc(mediaUrl(cover.thumb))}" alt="" loading="lazy" style="background:${esc(cover.color || '#eee')}">${p.images.length > 1 ? `<span class="photo-n">${p.images.length} photos</span>` : ''}` : artSvg(p.art)}</div>
    <div class="body">
      <b>${esc(p.name)}</b>
      <small>${esc(p.category)}${p.tag ? ' · ' + esc(p.tag) : ''}</small>
      <div class="price">${p.orderable && p.price > 0 ? inr(p.price) + (p.mrp > p.price ? ` <s class="muted" style="font-size:.8rem;font-weight:500">${inr(p.mrp)}</s>` : '') : '<span class="muted" style="font-size:1rem">Enquiry only</span>'}</div>
      ${p.stock != null ? `<small class="${p.stock === 0 ? 'stock-out' : p.stock <= (p.low_stock_at ?? 5) ? 'stock-low' : 'muted'}">${p.stock === 0 ? 'Sold out — 0 left' : `${p.stock} in stock${p.stock <= (p.low_stock_at ?? 5) ? ' · running low' : ''}`}</small>` : ''}
      ${p.used_in_offers.length ? `<small>In: ${esc(p.used_in_offers.join(', '))}</small>` : ''}
      ${cover ? '' : '<small class="muted">No photo yet — the illustration is shown</small>'}
    </div>
    <div class="foot">
      <label class="switch"><input type="checkbox" data-toggle="${esc(p.id)}:published" ${p.published ? 'checked' : ''}><i></i>On site</label>
      <label class="switch"><input type="checkbox" data-toggle="${esc(p.id)}:in_stock" ${(p.in_stock_switch ?? p.in_stock) ? 'checked' : ''}><i></i>In stock</label>
      <span style="display:flex;gap:6px"><button class="icon-btn" data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">${icon('edit')}</button>
      <button class="icon-btn" data-del="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button></span>
    </div></div>`;
}

// ---------------------------------------------------------------- photos editor

/**
 * Photo list for one product. Items:
 *   { key, id, alt, thumb (storage key) | preview (blob URL), w, h, color, state: saved|uploading|uploaded|interrupted|error,
 *     isNew, progress, label, error, ctrl, prep, media, file }
 */
export function photosEditor(product, host) {
  const items = (product.images || []).map((im) => ({ key: im.id, id: im.id, alt: im.alt || '', thumb: im.thumb, color: im.color, state: 'saved', isNew: false }));
  const initialIds = items.map((i) => i.id).join(',');
  let dragKey = null;

  const busyCount = () => items.filter((i) => i.state === 'uploading').length;
  const newOnes = () => items.filter((i) => i.isNew && (i.state === 'uploaded' || i.state === 'uploading'));
  const usable = () => items.filter((i) => i.state === 'saved' || i.state === 'uploaded');

  function tile(it, idx) {
    const img = it.preview || (it.thumb ? mediaUrl(it.thumb) : '');
    const pct = Math.round((it.progress || 0) * 100);
    const isCover = usable()[0] === it;
    let overlay = '';
    if (it.state === 'uploading') overlay = `<div class="ph-prog"><div class="bar"><i style="width:${pct}%"></i></div><small>${esc(it.label || 'Uploading')} · ${pct}%</small><button type="button" class="btn btn-ghost btn-sm" data-ph="cancel" data-k="${it.key}">Cancel</button></div>`;
    if (it.state === 'error') overlay = `<div class="ph-err"><small>${esc(it.error)}</small><span>${it.retryable ? `<button type="button" class="btn btn-line btn-sm" data-ph="retry" data-k="${it.key}">Retry</button>` : ''}${it.duplicate ? `<button type="button" class="btn btn-line btn-sm" data-ph="force" data-k="${it.key}">Upload anyway</button>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-ph="drop" data-k="${it.key}">Remove</button></span></div>`;
    if (it.state === 'interrupted') overlay = `<div class="ph-err"><small>Upload of <b>${esc(it.filename || 'a photo')}</b> was interrupted.</small><span><label class="btn btn-line btn-sm">Pick it again to resume<input type="file" accept="${ACCEPT}" data-resume="${it.key}" hidden></label><button type="button" class="btn btn-ghost btn-sm" data-ph="drop" data-k="${it.key}">Discard</button></span></div>`;
    const ready = it.state === 'saved' || it.state === 'uploaded';
    const n = items.indexOf(it) + 1;
    return `<div class="ph-tile ${it.state}${isCover ? ' is-cover' : ''}" data-tile="${it.key}" draggable="${ready}">
      <div class="ph-img" style="background:${esc(it.color || 'var(--tile)')}">${img ? `<img src="${esc(img)}" alt="">` : ''}
        <span class="ph-n">${isCover ? 'Cover' : n}</span>${it.isNew && it.state === 'uploaded' ? '<span class="ph-new">Not saved</span>' : ''}
        ${ready ? `<div class="ph-tools">
          <button type="button" data-ph="left" data-k="${it.key}" aria-label="Move left" ${idx === 0 ? 'disabled' : ''}>‹</button>
          <button type="button" data-ph="right" data-k="${it.key}" aria-label="Move right" ${idx === items.length - 1 ? 'disabled' : ''}>›</button>
          ${isCover ? '' : `<button type="button" data-ph="cover" data-k="${it.key}" class="ph-mk" title="Make this the cover photo">★ Cover</button>`}
          <button type="button" data-ph="remove" data-k="${it.key}" aria-label="Remove photo" class="ph-rm">${icon('trash')}</button></div>` : ''}
        ${overlay}</div>
      ${ready ? `<input class="ph-alt" data-alt="${it.key}" value="${esc(it.alt)}" maxlength="140" placeholder="Alt text (optional)" aria-label="Photo description" title="Describe the photo for screen readers and Google">` : ''}
    </div>`;
  }

  function redraw() {
    host.innerHTML = `
      <div class="ph-grid">${items.map(tile).join('')}
        ${items.length < 10 ? `<label class="ph-drop" id="phDrop">${icon('plus')}<b>Add photos</b><small>Drop here or click</small><input type="file" accept="${ACCEPT}" multiple hidden id="phInput"></label>` : ''}</div>
      <p class="hint">${items.length}/10 photos · JPEG, PNG or WebP up to 50 MB · drag to reorder — the first one is the cover.</p>`;
    host.querySelector('#phInput')?.addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  }

  function find(k) { return items.find((i) => i.key === k); }
  function move(it, to) {
    const from = items.indexOf(it);
    if (to < 0 || to >= items.length || from === to) return;
    items.splice(from, 1);
    items.splice(to, 0, it);
    redraw();
  }

  async function run(it, { allowDuplicate = false } = {}) {
    it.state = 'uploading'; it.progress = 0; it.error = ''; it.duplicate = false; it.label = 'Preparing photo';
    it.ctrl = new AbortController();
    redraw();
    try {
      if (!it.prep) {
        it.prep = await prepare(it.file);
        it.preview = it.prep.preview; it.color = it.prep.color;
        redraw();
      }
      let last = 0;
      const media = await upload(it.prep, {
        productId: product.id, alt: it.alt, signal: it.ctrl.signal, media: it.media, allowDuplicate,
        onProgress: (f, label) => {
          it.progress = f; if (label) it.label = label;
          if (Date.now() - last > 150 || f >= 1) { last = Date.now(); redraw(); }
        },
      });
      Object.assign(it, { id: media.id, media, state: 'uploaded', thumb: media.variants.thumb?.key || media.variants.web.key });
      if (!it.alt && media.alt) it.alt = media.alt;
    } catch (e) {
      if (e.cancelled) { return; }
      it.state = 'error';
      it.error = e.message;
      it.duplicate = e.data?.code === 'duplicate';
      it.retryable = !it.duplicate && !e.data?.fields && e.status !== 422;
      if (e.data?.media_id && !it.media) it.media = null;
    }
    redraw();
  }

  function addFiles(files) {
    const room = 10 - items.length;
    if (files.length > room) toast(`Only ${room} more photo${room === 1 ? '' : 's'} can be added (10 per product).`, 'err');
    for (const file of files.slice(0, Math.max(0, room))) {
      const it = { key: `n${Math.random().toString(36).slice(2)}`, file, alt: '', state: 'uploading', isNew: true, progress: 0 };
      items.push(it);
      run(it);
    }
    redraw();
  }

  host.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ph]');
    if (!b) return;
    e.preventDefault();
    const it = find(b.dataset.k);
    if (!it) return;
    const act = b.dataset.ph;
    if (act === 'left') move(it, items.indexOf(it) - 1);
    if (act === 'right') move(it, items.indexOf(it) + 1);
    if (act === 'cover') move(it, 0);
    if (act === 'cancel') { it.ctrl?.abort(); if (it.media?.id || it.id) discard(it.media?.id || it.id); items.splice(items.indexOf(it), 1); redraw(); }
    if (act === 'retry') run(it);
    if (act === 'force') { it.media = null; run(it, { allowDuplicate: true }); }
    if (act === 'drop') { if (it.media?.id || it.id) discard(it.media?.id || it.id); items.splice(items.indexOf(it), 1); redraw(); }
    if (act === 'remove') {
      if (it.isNew) discard(it.id); // never saved → delete now
      items.splice(items.indexOf(it), 1); // saved → trashed by the server when the product is saved
      redraw();
    }
  });
  host.addEventListener('input', (e) => { const k = e.target.dataset?.alt; if (k && find(k)) find(k).alt = e.target.value; });
  host.addEventListener('change', (e) => {
    const k = e.target.dataset?.resume;
    if (!k) return;
    const it = find(k);
    const file = e.target.files[0];
    if (!it || !file) return;
    if (file.size !== it.size || file.name !== it.filename) { toast('That is a different file. Pick the same photo to resume, or discard the interrupted upload.', 'err'); return; }
    Object.assign(it, { file, prep: null });
    run(it);
  });
  // drag & drop: files onto the drop zone, tiles to reorder
  host.addEventListener('dragover', (e) => { e.preventDefault(); host.querySelector('#phDrop')?.classList.add('over'); });
  host.addEventListener('dragleave', (e) => { if (!host.contains(e.relatedTarget)) host.querySelector('#phDrop')?.classList.remove('over'); });
  host.addEventListener('dragstart', (e) => { const t = e.target.closest('[data-tile]'); if (t) { dragKey = t.dataset.tile; e.dataTransfer.effectAllowed = 'move'; } });
  host.addEventListener('drop', (e) => {
    e.preventDefault();
    host.querySelector('#phDrop')?.classList.remove('over');
    if (dragKey) {
      const target = e.target.closest('[data-tile]');
      const it = find(dragKey);
      dragKey = null;
      if (it && target) move(it, items.indexOf(find(target.dataset.tile)));
      return;
    }
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) addFiles(files);
  });

  // uploads finished earlier but never saved, or interrupted
  (async () => {
    try {
      const { media } = await api('/api/admin/media', { query: { product_id: product.id } });
      const local = pendingUploads();
      for (const m of media) {
        if (items.some((i) => i.id === m.id)) continue;
        if (m.status === 'uploaded') items.push({ key: m.id, id: m.id, media: m, alt: m.alt, thumb: m.variants.thumb?.key || m.variants.web.key, color: m.color, state: 'uploaded', isNew: true });
        else if (local[m.id]) items.push({ key: m.id, id: m.id, media: m, alt: m.alt, color: m.color, state: 'interrupted', isNew: true, filename: local[m.id].name, size: local[m.id].size });
      }
      for (const id of Object.keys(local)) if (!media.some((m) => m.id === id)) forgetPending(id);
      redraw();
      if (items.some((i) => i.state === 'interrupted' || (i.isNew && i.state === 'uploaded'))) toast('Found photos from an earlier session that were not saved yet.', '');
    } catch { /* storage may not be configured */ }
  })();

  redraw();
  return {
    busy: () => busyCount() > 0,
    changed: () => newOnes().length > 0 || usable().map((i) => i.id).join(',') !== initialIds || items.some((i) => i.state === 'saved' && i.alt !== ((product.images || []).find((x) => x.id === i.id)?.alt || '')),
    hasFailed: () => items.some((i) => i.state === 'error' || i.state === 'interrupted'),
    payload: () => usable().map((i) => ({ id: i.id, alt: i.alt })),
    newCount: () => newOnes().length,
    discardNew: () => { for (const it of items) if (it.isNew) { it.ctrl?.abort(); if (it.id || it.media?.id) discard(it.id || it.media.id, { keepalive: true }); } },
  };
}

// ---------------------------------------------------------------- product dialog

function editDialog(p, el, { focusPhotos = false } = {}) {
  const v = p || { name: '', category: '', tag: '', description: '', chips: [], price: 0, mrp: 0, details: [], art: 'candle', in_stock: true, orderable: true, published: false, sort: 100 };
  let photos = null;
  let saved = false;
  const unload = (e) => { if (photos && (photos.busy() || photos.newCount())) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  openDialog({
    title: p ? `Edit ${p.name}` : 'New product',
    size: 'lg',
    body: `<form class="form pe" id="pf" novalidate>
      <section class="pe-sec">
        <div class="pe-h"><h4>Photos</h4><span>Shown on the product page and in the shop</span></div>
        <div class="field" data-field="images">
          ${p ? '<div id="photos"></div><div class="err"></div>' : '<div class="alert info" style="margin:0">Create the product first — the photo uploader opens right after.</div>'}</div>
        <details class="pe-more"><summary>Illustration when there is no photo</summary>
          <div class="field" data-field="art"><div class="art-pick">${Object.keys(ART).map((a) => `<label><input type="radio" name="art" value="${a}" ${v.art === a ? 'checked' : ''}>${artSvg(a)}</label>`).join('')}</div></div></details>
      </section>

      <section class="pe-sec">
        <div class="pe-h"><h4>Basics</h4></div>
        <div class="field" data-field="name"><label for="pn">Product name</label><input id="pn" value="${esc(v.name)}" maxlength="80" required placeholder="Evil Eye Candle"></div>
        <div class="form-row">
          <div class="field" data-field="category"><label for="pc">Category</label><input id="pc" value="${esc(v.category)}" maxlength="60" placeholder="Scented Candle"></div>
          <div class="field" data-field="tag"><label for="pt">Badge <i>(optional)</i></label><input id="pt" value="${esc(v.tag)}" maxlength="30" placeholder="Bestseller"></div>
        </div>
      </section>

      <section class="pe-sec">
        <div class="pe-h"><h4>Pricing &amp; stock</h4><span>Prices include GST</span></div>
        <div class="form-row">
          <div class="field" data-field="price"><label for="pp">Selling price</label><div class="pe-money"><span>₹</span><input id="pp" type="number" min="0" step="1" value="${esc(v.price)}" inputmode="numeric"></div></div>
          <div class="field" data-field="mrp"><label for="pm">MRP <i>(optional)</i></label><div class="pe-money"><span>₹</span><input id="pm" type="number" min="0" step="1" value="${v.mrp ? esc(v.mrp) : ''}" inputmode="numeric" placeholder="Shown struck through"></div></div>
        </div>
        <div class="form-row">
          <div class="field" data-field="stock"><label for="pst">Stock quantity <i>(optional)</i></label><input id="pst" type="number" min="0" step="1" value="${v.stock == null ? '' : esc(v.stock)}" inputmode="numeric" placeholder="Not tracked"><div class="hint">Goes down with each order, back up if cancelled.</div></div>
          <div class="field" data-field="low_stock_at"><label for="plo">“Only a few left” at</label><input id="plo" type="number" min="0" step="1" value="${esc(v.low_stock_at ?? 5)}" inputmode="numeric"></div>
        </div>
      </section>

      <section class="pe-sec">
        <div class="pe-h"><h4>Description</h4></div>
        <div class="field" data-field="description"><label for="pd">About this product</label><textarea id="pd" maxlength="1000" rows="3">${esc(v.description)}</textarea></div>
        <div class="field" data-field="chips"><label for="pk">Highlights <i>(comma separated, up to 6)</i></label><input id="pk" value="${esc((v.chips || []).join(', '))}" placeholder="Long Burn Time, Calming Scent"></div>
        <div class="field" data-field="details"><label for="pdt">Product details <i>(one per line, “Label: value”)</i></label><textarea id="pdt" rows="3" placeholder="Expiry: 1 year&#10;Quantity: 100 ml">${esc((v.details || []).map((d) => `${d.label}: ${d.value}`).join('\n'))}</textarea><div class="hint">Shown as a table on the product page. MRP and selling price are added automatically.</div></div>
      </section>

      <section class="pe-sec">
        <div class="pe-h"><h4>Visibility</h4></div>
        <div class="pe-toggles">
          <label class="pe-tg"><span><b>Show on website</b><small>Hidden products can still be edited here</small></span><span class="switch"><input type="checkbox" id="pv" ${v.published ? 'checked' : ''}><i></i></span></label>
          <label class="pe-tg"><span><b>In stock</b><small>Off = “Sold out”, can’t be ordered</small></span><span class="switch"><input type="checkbox" id="pi" ${(v.in_stock_switch ?? v.in_stock) ? 'checked' : ''}><i></i></span></label>
          <label class="pe-tg"><span><b>Can be ordered online</b><small>Off = enquiry only, shows a WhatsApp button</small></span><span class="switch"><input type="checkbox" id="po" ${v.orderable ? 'checked' : ''}><i></i></span></label>
        </div>
        <div class="field" data-field="sort" style="max-width:220px"><label for="ps">Sort order</label><input id="ps" type="number" min="0" value="${esc(v.sort)}"><div class="hint">Lower numbers appear first.</div></div>
      </section>
    </form>`,
    foot: `<button class="btn btn-line" data-dismiss>Cancel</button><button class="btn btn-primary" id="psave">${p ? 'Save changes' : 'Create product'}</button>`,
    onBeforeClose: async () => {
      if (saved || !photos) return true;
      if (photos.busy() || photos.newCount()) {
        const n = photos.newCount();
        const ok = await confirmDialog({ title: 'Discard new photos?', message: `${n} new photo${n === 1 ? ' has' : 's have'} not been saved to this product. Close and delete ${n === 1 ? 'it' : 'them'}?`, confirmText: 'Discard', danger: true });
        if (!ok) return false;
        photos.discardNew();
      }
      return true;
    },
    onClose: () => window.removeEventListener('beforeunload', unload),
    onMount: ({ el: dlg, close }) => {
      const f = dlg.querySelector('#pf');
      if (p) {
        photos = photosEditor(p, dlg.querySelector('#photos'));
        if (focusPhotos) setTimeout(() => dlg.querySelector('#photos')?.scrollIntoView({ block: 'center' }), 120);
      }
      const save = async () => {
        const btn = dlg.querySelector('#psave');
        if (photos?.busy()) return toast('Please wait for the photos to finish uploading.', 'err');
        const body = {
          name: f.querySelector('#pn').value, price: Number(f.querySelector('#pp').value || 0), mrp: Number(f.querySelector('#pm').value || 0),
          category: f.querySelector('#pc').value, details: f.querySelector('#pdt').value,
          tag: f.querySelector('#pt').value, description: f.querySelector('#pd').value, chips: f.querySelector('#pk').value,
          art: f.querySelector('input[name="art"]:checked')?.value, sort: Number(f.querySelector('#ps').value || 0),
          orderable: f.querySelector('#po').checked, in_stock: f.querySelector('#pi').checked, stock: f.querySelector('#pst').value === '' ? null : Number(f.querySelector('#pst').value), low_stock_at: Number(f.querySelector('#plo').value || 5), published: f.querySelector('#pv').checked,
        };
        if (photos) body.images = photos.payload();
        busy(btn, true);
        try {
          const r = await api(p ? `/api/admin/products/${p.id}` : '/api/admin/products', { method: p ? 'PUT' : 'POST', body });
          saved = true;
          toast(p ? 'Product saved' : 'Product created — now add photos', 'ok');
          if (photos?.hasFailed()) toast('Some photos failed and were not added.', 'err');
          close(true);
          products = (await api('/api/admin/products')).products;
          draw(el);
          if (!p) editDialog(products.find((x) => x.id === r.product.id), el, { focusPhotos: true });
        } catch (e) {
          busy(btn, false);
          if (e.data?.fields) showFieldErrors(f, e.data.fields);
          toast(e.message, 'err');
        }
      };
      dlg.querySelector('#psave').addEventListener('click', save);
      f.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    },
  });
}

async function remove(p, el) {
  if (!(await confirmDialog({ title: 'Delete product?', message: `Delete “${p.name}”? Its photos are deleted from storage too. Past orders keep their details. You can also just hide it instead.`, confirmText: 'Delete', danger: true }))) return;
  try {
    await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
    products = products.filter((x) => x.id !== p.id);
    toast('Product deleted', 'ok');
    draw(el);
  } catch (e) { toast(e.message, 'err'); }
}
