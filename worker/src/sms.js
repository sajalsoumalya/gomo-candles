// Bulk SMS adapters for OTP fallback (India, DLT). Provider + non-secret options come from settings.sms;
// the API key is the SMS_API_KEY Worker secret. Each adapter returns { provider_id } or throws.

const TIMEOUT_MS = 8000;

async function timed(fetchImpl, url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'SMS provider timed out' : `SMS provider unreachable: ${e?.message || e}`);
  } finally {
    clearTimeout(t);
  }
}

const body = async (res) => {
  const text = await res.text().catch(() => '');
  try { return { text, data: JSON.parse(text) }; } catch { return { text, data: null }; }
};

/** Replace {{phone}} {{phone91}} {{code}} {{message}} {{api_key}} — JSON-escaped when `json` is true. */
export function fillTemplate(tpl, vars, { json = false, url = false } = {}) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k] == null ? '' : String(vars[k]);
    if (json) return JSON.stringify(v).slice(1, -1);
    if (url) return encodeURIComponent(v);
    return v;
  });
}

export const SMS_PROVIDERS = {
  /** MSG91 Flow API — https://docs.msg91.com/sms/send-sms */
  async msg91(env, cfg, { phone, code }, fetchImpl) {
    if (!cfg.template_id) throw new Error('MSG91 needs a template (flow) id');
    const recipient = { mobiles: `91${phone}`, [cfg.var_name || 'otp']: code };
    const res = await timed(fetchImpl, 'https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: env.SMS_API_KEY, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: cfg.template_id, short_url: '0', recipients: [recipient] }),
    });
    const { data, text } = await body(res);
    if (!res.ok || (data && data.type && data.type !== 'success')) throw new Error(`MSG91 ${res.status}: ${(data?.message || text).toString().slice(0, 160)}`);
    return { provider_id: data?.message || data?.request_id || '' };
  },

  /** Fast2SMS — DLT route when a message (template) id is set, otherwise their OTP route. https://docs.fast2sms.com */
  async fast2sms(env, cfg, { phone, code }, fetchImpl) {
    const payload = cfg.template_id
      ? { route: 'dlt', sender_id: cfg.sender_id, message: cfg.template_id, variables_values: code, numbers: phone, flash: 0 }
      : { route: 'otp', variables_values: code, numbers: phone, flash: 0 };
    if (cfg.template_id && !cfg.sender_id) throw new Error('Fast2SMS DLT route needs a sender id');
    const res = await timed(fetchImpl, 'https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: env.SMS_API_KEY, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const { data, text } = await body(res);
    if (!res.ok || !data || data.return !== true) {
      const msg = Array.isArray(data?.message) ? data.message.join(' ') : data?.message || text;
      throw new Error(`Fast2SMS ${res.status}: ${String(msg).slice(0, 160)}`);
    }
    return { provider_id: data.request_id || '' };
  },

  /** 2Factor.in OTP SMS — GET /API/V1/{key}/SMS/{phone}/{otp}/{template_name} */
  async '2factor'(env, cfg, { phone, code }, fetchImpl) {
    const parts = ['https://2factor.in/API/V1', encodeURIComponent(env.SMS_API_KEY), 'SMS', `91${phone}`, code];
    if (cfg.template_id) parts.push(encodeURIComponent(cfg.template_id));
    const res = await timed(fetchImpl, parts.join('/'), { method: 'GET', headers: { accept: 'application/json' } });
    const { data, text } = await body(res);
    if (!res.ok || data?.Status !== 'Success') throw new Error(`2Factor ${res.status}: ${String(data?.Details || text).slice(0, 160)}`);
    return { provider_id: data.Details || '' };
  },

  /** Any HTTP SMS gateway: URL + method + headers (JSON) + body template; success when the response contains `success_match`. */
  async custom(env, cfg, { phone, code, text: message }, fetchImpl) {
    const c = cfg.custom || {};
    if (!/^https:\/\//i.test(c.url || '')) throw new Error('Custom SMS URL must start with https://');
    const vars = { phone, phone91: `91${phone}`, code, message, api_key: env.SMS_API_KEY };
    let headers = {};
    if (c.headers) {
      try { headers = JSON.parse(fillTemplate(c.headers, vars, { json: true })); } catch { throw new Error('Custom SMS headers must be valid JSON'); }
    }
    const method = String(c.method || 'POST').toUpperCase();
    const init = { method, headers };
    if (method !== 'GET' && c.body) {
      const isJson = /^\s*[{[]/.test(c.body);
      init.body = fillTemplate(c.body, vars, { json: isJson });
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
      }
    }
    const res = await timed(fetchImpl, fillTemplate(c.url, vars, { url: true }), init);
    const { text } = await body(res);
    if (!res.ok || (c.success_match && !text.includes(c.success_match))) throw new Error(`SMS gateway ${res.status}: ${text.slice(0, 160)}`);
    return { provider_id: '' };
  },
};

export function smsReady(env, smsSettings) {
  const p = smsSettings?.provider;
  return Boolean(p && p !== 'none' && SMS_PROVIDERS[p] && env.SMS_API_KEY);
}

export async function sendSms(env, smsSettings, msg, fetchImpl = fetch) {
  const fn = SMS_PROVIDERS[smsSettings.provider];
  if (!fn) throw new Error('No SMS provider selected');
  if (!env.SMS_API_KEY) throw new Error('SMS_API_KEY secret is not set');
  return fn(env, smsSettings, msg, fetchImpl);
}
