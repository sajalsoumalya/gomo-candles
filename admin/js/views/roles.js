// Roles (super admin only): named sets of pages that can be given to team members.
import { api } from '../api.js';
import { esc, loading, icon, toast, busy, showFieldErrors, confirmDialog, openDialog } from '../ui.js';

export async function render(el, ctx) {
  el.innerHTML = loading('Loading roles…');
  const d = await api('/api/admin/roles');
  if (!ctx.isCurrent()) return;
  draw(el, d, ctx);
}

const label = (d, id) => d.areas.find((a) => a.id === id)?.label || id;

function picker(d, chosen) {
  const groups = [...new Set(d.areas.map((a) => a.group))];
  return `<div class="area-pick">${groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${d.areas.filter((a) => a.group === g).map((a) =>
    `<label class="check"><input type="checkbox" value="${esc(a.id)}" ${chosen.includes(a.id) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('')}</fieldset>`).join('')}</div>`;
}

function draw(el, d, ctx) {
  el.innerHTML = `
    <div class="page-head"><div><small class="eyebrow-sm">Super admin</small><h1>Roles</h1><p>A role is a set of pages. Give a role to a team member on the Team page, and changing a role here updates everyone who has it.</p></div>
      <div class="actions"><button class="btn btn-primary" id="newRole">${icon('plus')} New role</button></div></div>
    <div class="role-grid">
      <div class="card role-card super"><div class="rc-h"><b>Super admin</b><span class="pill live">Everything</span></div>
        <p class="muted">Emails in <code>ADMIN_EMAILS</code>. Approves staff, manages roles and the team, and can open every page.</p></div>
      ${d.roles.map((r) => `<div class="card role-card" data-id="${esc(r.id)}">
        <div class="rc-h"><b>${esc(r.label)}</b>${r.builtin ? '<span class="pill pending">Built-in</span>' : ''}<span class="rc-n">${r.members} ${r.members === 1 ? 'person' : 'people'}</span></div>
        ${r.description ? `<p class="muted">${esc(r.description)}</p>` : ''}
        <ul class="rc-areas">${r.areas.map((a) => `<li>${esc(label(d, a))}</li>`).join('')}</ul>
        ${r.builtin ? '' : `<div class="rc-act"><button class="btn btn-line btn-sm" data-edit>${icon('edit')} Edit</button><button class="btn btn-ghost btn-sm" data-del aria-label="Delete">${icon('trash')}</button></div>`}
      </div>`).join('')}
    </div>`;

  const open = (r) => openDialog({
    title: r ? `Edit ${r.label}` : 'New role',
    body: `<form class="form" id="rf" novalidate>
      <div class="field" data-field="label"><label for="rl">Role name</label><input id="rl" maxlength="40" value="${esc(r?.label || '')}" placeholder="Packing team"></div>
      <div class="field" data-field="description"><label for="rd">Description <i>(optional)</i></label><input id="rd" maxlength="140" value="${esc(r?.description || '')}" placeholder="Packs and ships orders"></div>
      <div class="field" data-field="areas"><label>Pages this role can open</label>${picker(d, r?.areas || ['orders'])}<div class="err"></div></div>
    </form>`,
    foot: `<button class="btn btn-line" data-dismiss>Cancel</button><button class="btn btn-primary" id="rsave">${r ? 'Save role' : 'Create role'}</button>`,
    onMount(h) {
      const f = h.el.querySelector('#rf');
      h.el.querySelector('#rsave').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        busy(btn, true);
        try {
          await api('/api/admin/roles', { method: 'PUT', body: { id: r?.id, label: f.querySelector('#rl').value, description: f.querySelector('#rd').value, areas: [...f.querySelectorAll('.area-pick input:checked')].map((i) => i.value) } });
          toast(r ? 'Role saved' : 'Role created', 'ok'); h.close(true); render(el, ctx);
        } catch (err) { busy(btn, false); if (err.data?.fields) showFieldErrors(f, err.data.fields); toast(err.message, 'err'); }
      });
    },
  });

  el.querySelector('#newRole').addEventListener('click', () => open(null));
  el.querySelectorAll('.role-card[data-id]').forEach((c) => {
    const r = d.roles.find((x) => x.id === c.dataset.id);
    c.querySelector('[data-edit]')?.addEventListener('click', () => open(r));
    c.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Delete ${r.label}?`, message: 'People must be moved to another role first.', confirmText: 'Delete', danger: true }))) return;
      try { await api(`/api/admin/roles/${r.id}`, { method: 'DELETE' }); toast('Role deleted', 'ok'); render(el, ctx); } catch (err) { toast(err.message, 'err'); }
    });
  });
}
