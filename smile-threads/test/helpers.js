'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/util');

async function start(opts = {}) {
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  process.env.THREADS_WAIT_MS = '0';
  const app = createApp({ dbFile: ':memory:', appSecret: 'test-secret-test-secret-1234', passwordHash: hashPassword('pw-test'), ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, path, body, extra = {}) => {
    const h = { 'content-type': 'application/json', ...(extra.noCsrf ? {} : { 'x-requested-by': 'smile' }), ...(extra.noCookie ? {} : { cookie }), ...(extra.headers || {}) };
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    const sc = res.headers.get('set-cookie'); if (sc && path === '/api/login' && res.ok) cookie = sc.split(';')[0];
    return { status: res.status, json, headers: res.headers };
  };
  return { app, db: app.db, svc: app.svc, base, call, login: () => call('POST', '/api/login', { password: 'pw-test' }), close: () => { app.server.close(); app.db.close(); } };
}
// モックのThreads / LINE サーバー
function mockServer(handler) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    calls.push({ method: req.method, url: req.url, body, headers: req.headers });
    const out = handler({ method: req.method, url: req.url, body, calls }) || { status: 200, json: {} };
    res.writeHead(out.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.json ?? {}));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ calls, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}
const lineSig = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64');
module.exports = { start, mockServer, lineSig };
