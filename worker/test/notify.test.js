import { describe, it, expect } from 'vitest';
import { render, orderVars, sendWhatsAppOpenWA, sendEmailPostal, deliver, emailHtml } from '../src/notify.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const order = {
  order_no: 'GM-261111-1234', customer_name: 'Priya Sharma', phone: '9876543210', email: 'priya@example.com',
  address_line1: '12 Lake Road', address_line2: null, landmark: null, city: 'Kolkata', state: 'West Bengal', pincode: '700029',
  subtotal: 999, savings: 148, shipping: 0, total: 999, payment_method: 'cod', payment_status: 'pending', status: 'shipped',
  courier: 'Delhivery', tracking_no: 'DL1', tracking_url: 'https://track.example/DL1',
};
const items = [{ qty: 1, name: 'The Complete GoMo Ritual', contents: '1 × Candle', line_total: 999 }];
const settings = { ...DEFAULT_SETTINGS, store: { ...DEFAULT_SETTINGS.store, shop_url: 'https://gomo.example/' } };

function fakeDb() {
  const rows = [];
  const write = (op) => async (path, value) => { rows.push({ op, path, value }); return null; };
  return { rows, put: write('put'), patch: write('patch'), get: async () => null };
}

describe('templates', () => {
  it('fills placeholders and leaves unknown ones blank', () => {
    expect(render('Hi {{name}} {{ order_no }} {{nope}}!', { name: 'A', order_no: 'B' })).toBe('Hi A B !');
  });
  it('builds order variables', () => {
    const v = orderVars(order, items, settings);
    expect(v.name).toBe('Priya');
    expect(v.track_link).toBe('https://gomo.example/#track/GM-261111-1234');
    expect(v.payment).toBe('Cash on Delivery');
    expect(v.shipping_info).toContain('Courier: *Delhivery*');
    expect(v.items).toBe('▫️ 1 × The Complete GoMo Ritual — *₹999*');
    expect(v.cod_note).toContain('₹999');
  });
  it('escapes customer data in email HTML', () => {
    const evil = { ...order, customer_name: '<script>x</script>' };
    const v = orderVars(evil, items, settings);
    const html = emailHtml({ intro: 'Hi <b>', order: evil, items, vars: v, settings });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('providers', () => {
  it('OpenWA: finds the named session and sends with X-API-Key', async () => {
    const reqs = [];
    const fetchImpl = async (url, init = {}) => {
      reqs.push({ url, init });
      if (url.endsWith('/api/sessions')) return new Response(JSON.stringify([{ id: 'other', name: 'x', status: 'ready' }, { id: 's1', name: 'opt-connection', status: 'ready' }]));
      return new Response(JSON.stringify({ messageId: 'msgid', timestamp: 1 }), { status: 201 });
    };
    const id = await sendWhatsAppOpenWA({ OPENWA_URL: 'https://wa.example/', OPENWA_API_KEY: 'k', OPENWA_SESSION: 'opt-connection' }, { to: '919876543210', text: 'hi' }, fetchImpl);
    expect(id).toBe('msgid');
    const send = reqs.at(-1);
    expect(send.url).toBe('https://wa.example/api/sessions/s1/messages/send-text');
    expect(JSON.parse(send.init.body)).toEqual({ chatId: '919876543210@c.us', text: 'hi' });
    expect(send.init.headers['x-api-key']).toBe('k');
  });
  it('Postal: posts to /api/v1/send/message with server key', async () => {
    let req;
    const fetchImpl = async (url, init) => { req = { url, init }; return new Response(JSON.stringify({ status: 'success', data: { message_id: 'm1' } })); };
    const id = await sendEmailPostal({ POSTAL_URL: 'https://postal.example', POSTAL_API_KEY: 'pk', MAIL_FROM: 'GoMo <o@gomo.example>' }, { to: 'a@b.co', subject: 'S', text: 'T', html: '<p>T</p>' }, fetchImpl);
    expect(id).toBe('m1');
    expect(req.url).toBe('https://postal.example/api/v1/send/message');
    expect(req.init.headers['x-server-api-key']).toBe('pk');
    expect(JSON.parse(req.init.body)).toMatchObject({ to: ['a@b.co'], from: 'GoMo <o@gomo.example>', subject: 'S', plain_body: 'T', html_body: '<p>T</p>' });
  });
  it('Postal: surfaces API errors', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ status: 'error', data: { code: 'NoRecipients' } }), { status: 200 });
    await expect(sendEmailPostal({ POSTAL_URL: 'https://p', POSTAL_API_KEY: 'k', MAIL_FROM: 'x@y.z' }, { to: 'a@b.co', subject: 's', text: 't' }, fetchImpl)).rejects.toThrow(/NoRecipients/);
  });
});

describe('deliver()', () => {
  it('logs a dry run when a provider is not configured', async () => {
    const DB = fakeDb();
    const r = await deliver({ __db: DB }, { channel: 'whatsapp', to: '919876543210', text: 'hi', event: 'confirmed', order_no: order.order_no });
    expect(r.status).toBe('skipped');
    expect(DB.rows[0].path).toMatch(/^notifications\//);
    expect(DB.rows[0].value).toMatchObject({ status: 'skipped', channel: 'whatsapp', order_no: order.order_no });
  });
  it('logs failures without throwing', async () => {
    const DB = fakeDb();
    const fetchImpl = async (url) => (url.endsWith('/api/sessions') ? new Response(JSON.stringify([{ id: 'zz', name: 'n', status: 'ready' }])) : new Response('down', { status: 502 }));
    const r = await deliver({ __db: DB, OPENWA_URL: 'https://wa.example', OPENWA_SESSION: 'n' }, { channel: 'whatsapp', to: '91', text: 'x', event: 'test' }, fetchImpl);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/OpenWA 502/);
  });
});
