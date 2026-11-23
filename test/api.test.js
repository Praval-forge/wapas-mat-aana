// Platform API tests: auth, scopes, validation, quotas, tenancy isolation,
// webhooks (signed delivery), policy patching, admin key lifecycle.
// Runs against a real server on an ephemeral port with an in-memory store.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.CODGUARD_DATA_FILE = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
process.env.CODGUARD_ADMIN_KEY = 'test-admin-key';

const { app, boot } = await import('../src/server.js');
const { DEMO_API_KEY } = await import('../src/demoTenant.js');

let base, server, hookServer, hookReceived = [];
const H = (key) => ({ 'content-type': 'application/json', 'X-API-Key': key });
const AH = { 'content-type': 'application/json', 'X-Admin-Key': 'test-admin-key' };

before(async () => {
  await boot();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hookReceived.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => hookServer.listen(0, r));
});
after(() => { server.close(); hookServer.close(); });

test('auth: no key, bad key, good key', async () => {
  let r = await fetch(`${base}/v1/orders`);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'missing_api_key');
  r = await fetch(`${base}/v1/orders`, { headers: H('wma_test_wrong') });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/v1/orders`, { headers: H(DEMO_API_KEY) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-codguard-key-kind'), 'test');
});

test('meta is public and error shape is consistent', async () => {
  const r = await fetch(`${base}/v1/meta`);
  assert.equal(r.status, 200);
  const meta = await r.json();
  assert.equal(meta.version, '2.0');
  const bad = await fetch(`${base}/v1/nope`, { headers: H(DEMO_API_KEY) });
  assert.equal(bad.status, 404);
  const body = await bad.json();
  assert.ok(body.error.code && body.error.message);
});

test('ingest validates and scores on all signals', async () => {
  const r = await fetch(`${base}/v1/orders`, {
    method: 'POST', headers: H(DEMO_API_KEY),
    body: JSON.stringify({ buyer_name: 'Test Buyer', phone: '9810000003', pin: '560034', address: 'Flat 1, A Street, Koramangala, Bengaluru 560034', amount: 900, external_id: 'EXT-1' }),
  });
  assert.equal(r.status, 201);
  const o = await r.json();
  assert.equal(o.external_id, 'EXT-1');
  assert.equal(o.risk, 'HIGH'); // 2 past returns -> 65 even in a safe pin
  assert.equal(o.status, 'PENDING_REVIEW');
  // invalid payload: every problem reported
  const bad = await fetch(`${base}/v1/orders`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ pin: '123' }) });
  assert.equal(bad.status, 400);
  const e = await bad.json();
  assert.equal(e.error.code, 'invalid_order');
  assert.ok(e.error.details.length >= 2);
});

test('external_id lookup, filters, buyer reply flow', async () => {
  const byExt = await fetch(`${base}/v1/orders/EXT-1`, { headers: H(DEMO_API_KEY) });
  assert.equal(byExt.status, 200);
  const o = await byExt.json();
  const list = await fetch(`${base}/v1/orders?risk=HIGH`, { headers: H(DEMO_API_KEY) });
  assert.ok((await list.json()).orders.every((x) => x.risk === 'HIGH'));
  const reply = await fetch(`${base}/v1/orders/${o.id}/buyer-reply`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ reply: 'paid' }) });
  assert.equal((await reply.json()).status, 'PENDING_REVIEW');
  const badReply = await fetch(`${base}/v1/orders/${o.id}/buyer-reply`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ reply: 'paid' }) });
  assert.equal(badReply.status, 200); // repeated evidence does not decide an order
});

test('seller override requires a note; seller rules refused (422)', async () => {
  const noNote = await fetch(`${base}/v1/orders/CG-1002/actions`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ action: 'override', to: 'ship' }) });
  assert.equal(noNote.status, 400);
  const ok = await fetch(`${base}/v1/orders/CG-1002/actions`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ action: 'override', to: 'ship', note: 'called buyer' }) });
  assert.equal((await ok.json()).status, 'SHIPPED');
  const rule = await fetch(`${base}/v1/seller-rules`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ text: 'Block all buyers from Jaipur' }) });
  assert.equal(rule.status, 422);
  assert.equal((await rule.json()).error.details.code, 'blanket_group_rule');
});

test('policy: read, patch, clamp, reject unknown fields', async () => {
  let r = await fetch(`${base}/v1/policy`, { headers: H(DEMO_API_KEY) });
  const p0 = await r.json();
  assert.equal(p0.lowMax, 29);
  r = await fetch(`${base}/v1/policy`, { method: 'PUT', headers: H(DEMO_API_KEY), body: JSON.stringify({ reminderAfterHours: 6, weights: { pinHigh: 25 } }) });
  const p1 = await r.json();
  assert.equal(p1.reminderAfterHours, 6);
  assert.equal(p1.weights.pinHigh, 25);
  r = await fetch(`${base}/v1/policy`, { method: 'PUT', headers: H(DEMO_API_KEY), body: JSON.stringify({ nope: 1 }) });
  assert.equal(r.status, 422);
  r = await fetch(`${base}/v1/policy`, { method: 'PUT', headers: H(DEMO_API_KEY), body: JSON.stringify({ lowMax: 60, mediumMax: 50 }) });
  assert.equal(r.status, 422);
  // restore defaults for later tests
  await fetch(`${base}/v1/policy`, { method: 'PUT', headers: H(DEMO_API_KEY), body: JSON.stringify({ reminderAfterHours: 12, weights: { pinHigh: 30 } }) });
});

test('webhooks: register, signed delivery on order events, deliveries log', async () => {
  const hookPort = hookServer.address().port;
  const reg = await fetch(`${base}/v1/webhooks`, {
    method: 'POST', headers: H(DEMO_API_KEY),
    body: JSON.stringify({ url: `http://127.0.0.1:${hookPort}/hook`, events: ['order.status_changed'] }),
  });
  assert.equal(reg.status, 201);
  const hook = await reg.json();
  assert.ok(hook.secret.startsWith('whsec_'));
  // secret is shown once
  const list = await fetch(`${base}/v1/webhooks`, { headers: H(DEMO_API_KEY) });
  assert.equal((await list.json()).webhooks[0].secret, undefined);

  hookReceived.length = 0;
  await fetch(`${base}/v1/orders/CG-1004/actions`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify({ action: 'ship' }) });
  assert.equal(hookReceived.length, 1);
  const got = hookReceived[0];
  const expected = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(got.body).digest('hex');
  assert.equal(got.headers['x-codguard-signature'], expected);
  assert.equal(got.headers['x-codguard-event'], 'order.status_changed');
  const log = await fetch(`${base}/v1/webhooks-deliveries`, { headers: H(DEMO_API_KEY) });
  const deliveries = (await log.json()).deliveries;
  assert.ok(deliveries.length >= 1 && deliveries[0].ok === true && deliveries[0].http_status === 200);
});

test('tenancy isolation: a second tenant cannot see demo orders', async () => {
  const t = await fetch(`${base}/admin/api/tenants`, { method: 'POST', headers: AH, body: JSON.stringify({ name: 'Other Brand', plan: 'growth' }) });
  const tenant = await t.json();
  const k = await fetch(`${base}/admin/api/tenants/${tenant.id}/keys`, { method: 'POST', headers: AH, body: JSON.stringify({ label: 'main', kind: 'live' }) });
  const key = (await k.json()).key;
  assert.ok(key.startsWith('wma_live_'));
  const r = await fetch(`${base}/v1/orders`, { headers: H(key) });
  assert.equal((await r.json()).count, 0);
  const demo = await fetch(`${base}/v1/orders/CG-1001`, { headers: H(key) });
  assert.equal(demo.status, 404);
});

test('admin: auth required; key lifecycle rotate/revoke; sandbox plan blocks live keys', async () => {
  let r = await fetch(`${base}/admin/api/tenants`);
  assert.equal(r.status, 401);
  const t = await (await fetch(`${base}/admin/api/tenants`, { method: 'POST', headers: AH, body: JSON.stringify({ name: 'Sandbox Brand', plan: 'sandbox' }) })).json();
  const live = await fetch(`${base}/admin/api/tenants/${t.id}/keys`, { method: 'POST', headers: AH, body: JSON.stringify({ kind: 'live' }) });
  assert.equal(live.status, 402); // sandbox plan: test keys only
  const issued = await (await fetch(`${base}/admin/api/tenants/${t.id}/keys`, { method: 'POST', headers: AH, body: JSON.stringify({ kind: 'test', label: 'ci' }) })).json();
  assert.ok(issued.key.startsWith('wma_test_'));
  const usable = await fetch(`${base}/v1/meta`, { headers: H(issued.key) });
  assert.equal(usable.status, 200);
  const rotated = await (await fetch(`${base}/admin/api/keys/${issued.id}/rotate`, { method: 'POST', headers: AH })).json();
  assert.ok(rotated.key.key && rotated.key.key !== issued.key);
  const oldDead = await fetch(`${base}/v1/orders`, { headers: H(issued.key) });
  assert.equal(oldDead.status, 401);
  await fetch(`${base}/admin/api/keys/${rotated.key.id}/revoke`, { method: 'POST', headers: AH });
  const newDead = await fetch(`${base}/v1/orders`, { headers: H(rotated.key.key) });
  assert.equal(newDead.status, 401);
});

test('scopes: a read-only key cannot ingest', async () => {
  const t = await (await fetch(`${base}/admin/api/tenants`, { method: 'POST', headers: AH, body: JSON.stringify({ name: 'Scoped', plan: 'growth' }) })).json();
  const k = await (await fetch(`${base}/admin/api/tenants/${t.id}/keys`, { method: 'POST', headers: AH, body: JSON.stringify({ kind: 'live', scopes: ['orders:read'] }) })).json();
  const read = await fetch(`${base}/v1/orders`, { headers: H(k.key) });
  assert.equal(read.status, 200);
  const write = await fetch(`${base}/v1/orders`, { method: 'POST', headers: H(k.key), body: JSON.stringify({ buyer_name: 'X', pin: '560034', address: 'Flat 1, A Street, Koramangala 560034' }) });
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error.code, 'insufficient_scope');
});

test('idempotency: retried ingest returns the original, scored once', async () => {
  const payload = { buyer_name: 'Retry Test', phone: '9999900001', pin: '560034', address: 'Flat 9, B Road, Koramangala 560034', amount: 700, external_id: 'RETRY-1' };
  const r1 = await fetch(`${base}/v1/orders`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify(payload) });
  assert.equal(r1.status, 201);
  const o1 = await r1.json();
  const r2 = await fetch(`${base}/v1/orders`, { method: 'POST', headers: H(DEMO_API_KEY), body: JSON.stringify(payload) });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('idempotent-replay'), 'true');
  const o2 = await r2.json();
  assert.equal(o2.id, o1.id);
  // Idempotency-Key header path
  const r3 = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { ...H(DEMO_API_KEY), 'Idempotency-Key': 'idem-123' }, body: JSON.stringify({ ...payload, external_id: 'RETRY-2' }) });
  const r4 = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { ...H(DEMO_API_KEY), 'Idempotency-Key': 'idem-123' }, body: JSON.stringify({ ...payload, external_id: 'RETRY-3' }) });
  assert.equal((await r4.json()).id, (await r3.json()).id);
});

test('health is public and request ids are echoed', async () => {
  const r = await fetch(`${base}/v1/health`, { headers: { 'X-Request-Id': 'req-abc' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-request-id'), 'req-abc');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const body = await r.json();
  assert.equal(body.ok, true);
});

test('usage metering counts requests and orders', async () => {
  const r = await fetch(`${base}/v1/usage`, { headers: H(DEMO_API_KEY) });
  const u = await r.json();
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(u.usage[month].requests > 0);
  assert.ok(u.usage[month].orders >= 1);
  assert.equal(u.plan, 'sandbox');
});
