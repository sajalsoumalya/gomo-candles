// Live updates for the admin panel. The server stamps changes/<topic> on every save (orders, catalog, customers,
// messages, coupons, settings, staff); this polls those stamps while the tab is visible and tells listeners which
// topics moved, so the open page can reload itself without a browser refresh.
import { api } from './api.js';

const POLL_MS = 5000;
let last = null, timer = 0, failures = 0, started = false;
const subs = new Set();

export const onChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };

function indicator(ok, flash) {
  const el = document.getElementById('tbLive');
  if (!el) return;
  el.classList.toggle('off', !ok);
  el.title = ok ? 'Live — updates appear on their own' : 'Offline — reconnecting…';
  if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, failures > 2 ? POLL_MS * 4 : POLL_MS);
}

async function tick() {
  if (document.visibilityState !== 'visible') return; // resumes on visibilitychange
  try {
    const { changes = {} } = await api('/api/admin/changes');
    failures = 0;
    const moved = last ? Object.keys(changes).filter((k) => changes[k] !== last[k]) : [];
    last = changes;
    indicator(true, moved.length > 0);
    if (moved.length) subs.forEach((fn) => { try { fn(new Set(moved)); } catch (e) { console.error(e); } });
  } catch {
    failures++;
    if (failures > 1) indicator(false);
  }
  schedule();
}

/** Start polling (once). Coming back to the tab checks straight away. */
export function startLive() {
  if (started) return;
  started = true;
  tick();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { clearTimeout(timer); tick(); } });
  addEventListener('online', () => { clearTimeout(timer); tick(); });
}
