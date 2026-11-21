import { API_BASE } from './firebase-config.js';
import { getToken } from './auth.js';

let onAuthError = () => {};
export function setAuthErrorHandler(fn) { onAuthError = fn; }

export async function api(path, { method = 'GET', body, query } = {}) {
  let url = API_BASE + path;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString();
    if (qs) url += '?' + qs;
  }
  const send = async (force) => {
    const token = await getToken(force);
    return fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  let res;
  try {
    res = await send(false);
    if (res.status === 401) res = await send(true); // token may have just expired
  } catch {
    throw Object.assign(new Error('Cannot reach the API. Is the Worker running and is API_BASE correct?'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    if (res.status === 401 || res.status === 403) onAuthError(err);
    throw err;
  }
  return data;
}
