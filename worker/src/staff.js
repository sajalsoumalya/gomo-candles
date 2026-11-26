// Staff access for the admin panel — permissions per admin page.
// Owners = emails in ADMIN_EMAILS (always everything; can't be changed from the panel).
// Staff  = staff/{safeKey(email)} = { email, name, role: manager|packer|custom, areas?: [...], active, added_by, added_at, last_seen_at }
//   role manager / packer = preset page lists below; role custom = the ticked `areas`.

import { HttpError, json, nowIso } from './util.js';
import { db, safeKey, values } from './db.js';
import { isValidEmail } from './validate.js';

/** Every admin page that can be granted. `group` is only for display. */
export const AREAS = [
  { id: 'orders', label: 'Orders & dashboard', group: 'Work' },
  { id: 'payments_edit', label: 'Mark orders paid / refunded', group: 'Work' },
  { id: 'catalog', label: 'Products & offers', group: 'Work' },
  { id: 'coupons', label: 'Coupons', group: 'Work' },
  { id: 'customers', label: 'Customers', group: 'Work' },
  { id: 'messages', label: 'Messages log', group: 'Work' },
  { id: 'exports', label: 'Export orders (CSV)', group: 'Work' },
  { id: 'set_store', label: 'Store', group: 'Settings' },
  { id: 'set_shipping', label: 'Shipping', group: 'Settings' },
  { id: 'set_payments', label: 'Payments', group: 'Settings' },
  { id: 'set_invoice', label: 'GST & invoices', group: 'Settings' },
  { id: 'set_notify', label: 'Notifications', group: 'Settings' },
  { id: 'set_templates', label: 'Message templates', group: 'Settings' },
  { id: 'set_signin', label: 'Sign-in & SMS', group: 'Settings' },
  { id: 'set_storage', label: 'Photo storage', group: 'Settings' },
  { id: 'set_integrations', label: 'Integrations & test messages', group: 'Settings' },
];
const AREA_IDS = new Set(AREAS.map((a) => a.id));

// Built-in roles (always available). The super admin can add more on the Roles page (stored in roles/{id}).
export const ROLES = {
  owner: { label: 'Super admin', areas: ['*'] },
  manager: { label: 'Manager', areas: ['orders', 'payments_edit', 'catalog', 'coupons', 'customers', 'messages', 'exports'] },
  packer: { label: 'Packer', areas: ['orders'] },
  custom: { label: 'Custom', areas: [] },
};
const BUILTIN = new Set(Object.keys(ROLES));

/** Settings sections (top-level keys of the settings object) → the page that may change them. */
export const SETTINGS_AREA = {
  store: 'set_store', shipping: 'set_shipping', payments: 'set_payments', invoice: 'set_invoice',
  notify: 'set_notify', templates: 'set_templates', otp: 'set_signin', sms: 'set_signin', shiprocket: 'set_shipping',
};

/** Which permission an admin API call needs. Reading settings is allowed with any settings page; writes are checked per section. */
export function areaFor(method, path) {
  if (path === '/api/admin/me' || path === '/api/admin/changes') return 'any'; // changes = timestamps only
  if (path === '/api/admin/settings') return method === 'GET' ? 'settings_any' : 'settings_write';
  if (/^\/api\/admin\/(staff|roles|access-requests|backups)/.test(path)) return 'owner'; // super admin only
  if (/^\/api\/admin\/storage/.test(path)) return 'set_storage';
  if (/^\/api\/admin\/shiprocket/.test(path)) return 'set_shipping'; // pickup addresses for Settings → Shipping
  if (/^\/api\/admin\/test-otp/.test(path)) return 'set_signin';
  if (/^\/api\/admin\/(test-notification|integrations)/.test(path)) return 'set_integrations';
  if (/^\/api\/admin\/coupons/.test(path)) return 'coupons';
  if (/^\/api\/admin\/(products|offers|media)/.test(path)) return 'catalog';
  if (/^\/api\/admin\/customers/.test(path)) return 'customers';
  if (/^\/api\/admin\/notifications/.test(path)) return 'messages';
  if (/^\/api\/admin\/exports/.test(path)) return 'exports';
  if (/^\/api\/admin\/orders\/[^/]+\/refund$/.test(path)) return 'payments_edit'; // moves money
  if (/^\/api\/admin\/(orders|stats)/.test(path)) return 'orders';
  return 'owner'; // anything new is owner-only until it is given an area
}

/** Pages for a role. `saved` = roles stored by the super admin ({id: {label, areas}}). */
export const areasOf = (role, custom, saved = {}) => {
  if (role === 'custom') return (custom || []).filter((a) => AREA_IDS.has(a));
  if (ROLES[role]) return ROLES[role].areas;
  return (saved[role]?.areas || []).filter((a) => AREA_IDS.has(a));
};
export async function savedRoles(env) { return (await db(env).get('roles')) || {}; }
export const roleLabel = (role, saved = {}) => ROLES[role]?.label || saved[role]?.label || role;

export function can(areas, need) {
  const a = areas || [];
  if (a.includes('*')) return true;
  if (need === 'any' || need === 'settings_write') return true; // settings_write is checked per section in the handler
  if (need === 'settings_any') return a.some((x) => x.startsWith('set_'));
  if (need === 'owner') return false;
  return a.includes(need);
}

/** Look up a non-owner's staff record; null if not staff or switched off. */
export async function staffRecord(env, email) {
  const rec = await db(env).get(`staff/${safeKey(email)}`);
  // safeKey maps "a.b@x.com" and "a_b@x.com" to one key: only the exact email the owner approved gets in.
  if (rec && String(rec.email || '').toLowerCase() !== String(email || '').toLowerCase()) return null;
  return rec && rec.active !== false && rec.role && rec.role !== 'owner' ? rec : null;
}

export async function touchStaff(env, email) {
  try { await db(env).patch(`staff/${safeKey(email)}`, { last_seen_at: nowIso() }); } catch { /* never block a request */ }
}

const pub = (r, saved) => ({ email: r.email, name: r.name || '', role: r.role, role_label: roleLabel(r.role, saved), areas: areasOf(r.role, r.areas, saved),
  active: r.active !== false, added_by: r.added_by || null, added_at: r.added_at || null, last_seen_at: r.last_seen_at || null });

const audit = (env, admin, action, detail) =>
  db(env).put(`audit/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, { at: nowIso(), uid: admin.uid, action, detail, by: admin.email });

function roleList(saved) {
  const builtin = ['manager', 'packer'].map((id) => ({ id, label: ROLES[id].label, areas: ROLES[id].areas, builtin: true }));
  const custom = Object.entries(saved).filter(([, v]) => v?.label).map(([id, v]) => ({ id, label: v.label, description: v.description || '', areas: areasOf(id, null, saved), builtin: false }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...builtin, ...custom, { id: 'custom', label: 'Custom (pick pages)', areas: [], builtin: true }];
}

export async function adminListStaff(env, ownerEmails) {
  const d = db(env);
  const [staffMap, saved, reqMap] = await Promise.all([d.get('staff'), savedRoles(env), d.get('access_requests')]);
  const rows = values(staffMap).filter((r) => r?.email).map((r) => pub(r, saved)).sort((a, b) => a.email.localeCompare(b.email));
  const requests = values(reqMap).filter((r) => r?.email && r.status === 'pending').sort((a, b) => (a.at < b.at ? 1 : -1));
  return json({ owners: ownerEmails, staff: rows, requests, areas: AREAS, roles: roleList(saved) });
}

/** Add, approve or edit a staff member (super admin only — enforced by the router). */
export async function adminSaveStaff(env, body, admin, ownerEmails) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) throw new HttpError(422, 'Enter a valid email address.', { fields: { email: 'Enter a valid email address.' } });
  if (ownerEmails.includes(email)) throw new HttpError(409, 'This email is already a super admin.', { fields: { email: 'Already a super admin.' } });
  const saved = await savedRoles(env);
  const role = String(body.role || '');
  if (role === 'owner' || !(ROLES[role] || saved[role])) throw new HttpError(422, 'Choose a role.', { fields: { role: 'Choose a role.' } });
  const areas = role === 'custom' ? [...new Set((Array.isArray(body.areas) ? body.areas : []).filter((a) => AREA_IDS.has(a)))] : null;
  if (role === 'custom' && !areas.length) throw new HttpError(422, 'Tick at least one page this person can use.', { fields: { areas: 'Tick at least one page.' } });
  const d = db(env);
  const path = `staff/${safeKey(email)}`;
  const existing = await d.get(path);
  const rec = {
    email, role, areas, name: String(body.name || existing?.name || '').trim().slice(0, 80),
    active: body.active === undefined ? existing?.active !== false : body.active !== false,
    added_by: existing?.added_by || admin.email, added_at: existing?.added_at || nowIso(), updated_at: nowIso(),
    last_seen_at: existing?.last_seen_at || null,
  };
  await d.put(path, rec);
  const req = await d.get(`access_requests/${safeKey(email)}`);
  if (req?.status === 'pending') await d.patch(`access_requests/${safeKey(email)}`, { status: 'approved', decided_by: admin.email, decided_at: nowIso() });
  await audit(env, admin, existing ? 'staff_updated' : req ? 'staff_approved' : 'staff_added', `${email} → ${role}${areas ? ` (${areas.join(',')})` : ''}`);
  return json({ staff: pub(rec, saved) }, existing ? 200 : 201);
}

export async function adminRemoveStaff(env, email, admin) {
  const e = String(email || '').toLowerCase();
  await db(env).remove(`staff/${safeKey(e)}`);
  await audit(env, admin, 'staff_removed', e);
  return json({ ok: true });
}

// ------------------------------------------------------------------ access requests
// Someone signs in to the admin panel with a verified email that isn't staff yet → a request waits for the super admin.

export async function recordAccessRequest(env, claims, note = '') {
  const email = String(claims.email || '').toLowerCase();
  if (!email) return null;
  const d = db(env);
  const path = `access_requests/${safeKey(email)}`;
  const cur = await d.get(path);
  if (cur?.status === 'declined') return cur;
  if (!cur || cur.status !== 'pending') {
    const rec = { email, name: claims.name || '', uid: claims.sub, at: nowIso(), status: 'pending', ...(note ? { note } : {}) };
    await d.put(path, rec);
    return rec;
  }
  return cur;
}

export async function adminDeclineRequest(env, email, admin) {
  const e = String(email || '').toLowerCase();
  await db(env).patch(`access_requests/${safeKey(e)}`, { status: 'declined', decided_by: admin.email, decided_at: nowIso() });
  await audit(env, admin, 'access_declined', e);
  return json({ ok: true });
}

// ------------------------------------------------------------------ roles (super admin)

const ROLE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

export async function adminListRoles(env) {
  const saved = await savedRoles(env);
  const staff = values(await db(env).get('staff'));
  const count = (id) => staff.filter((m) => m?.role === id).length;
  return json({ areas: AREAS, roles: roleList(saved).filter((r) => r.id !== 'custom').map((r) => ({ ...r, members: count(r.id) })) });
}

export async function adminSaveRole(env, body, admin) {
  const label = String(body.label || '').trim().slice(0, 40);
  if (label.length < 2) throw new HttpError(422, 'Give the role a name.', { fields: { label: 'Give the role a name, e.g. Packing team.' } });
  const areas = [...new Set((Array.isArray(body.areas) ? body.areas : []).filter((a) => AREA_IDS.has(a)))];
  if (!areas.length) throw new HttpError(422, 'Tick at least one page.', { fields: { areas: 'Tick at least one page.' } });
  const saved = await savedRoles(env);
  let id = body.id ? String(body.id) : slug(label);
  if (BUILTIN.has(id)) throw new HttpError(409, 'Built-in roles can’t be changed. Create a new role instead.');
  if (!ROLE_ID.test(id)) throw new HttpError(422, 'Use letters or numbers in the name.', { fields: { label: 'Use letters or numbers.' } });
  if (!body.id && saved[id]) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
  const rec = { label, description: String(body.description || '').trim().slice(0, 140), areas, updated_at: nowIso(), created_at: saved[id]?.created_at || nowIso(), created_by: saved[id]?.created_by || admin.email };
  await db(env).put(`roles/${id}`, rec);
  await audit(env, admin, saved[id] ? 'role_updated' : 'role_created', `${id}: ${areas.join(',')}`);
  return json({ role: { id, ...rec } }, saved[id] ? 200 : 201);
}

export async function adminDeleteRole(env, id, admin) {
  if (BUILTIN.has(id)) throw new HttpError(409, 'Built-in roles can’t be deleted.');
  const inUse = values(await db(env).get('staff')).filter((m) => m?.role === id).length;
  if (inUse) throw new HttpError(409, `${inUse} team member${inUse === 1 ? ' uses' : 's use'} this role. Move them to another role first.`);
  await db(env).remove(`roles/${id}`);
  await audit(env, admin, 'role_deleted', id);
  return json({ ok: true });
}
