// Dashboard numbers. Home, the orders chips and the menu badge all need them at the same moment;
// calls within a couple of seconds share one request.
import { api } from './api.js';

let pending = null, at = 0;
export function getStats() {
  if (!pending || Date.now() - at > 2500) {
    at = Date.now();
    pending = api('/api/admin/stats').catch((e) => { pending = null; throw e; });
  }
  return pending;
}
