// v2.1 tests: buyer bearer links, simulated payments, buyer evidence never
// decides, same-phone rescoring isolation, undo, CSV replace safety, fee
// ladder boundaries and the preserved human-final policy.
// Real server on an ephemeral port, in-memory store, demo mode (no LLM key).
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

process.env.CODGUARD_DATA_FILE = ':memory:';
process.env.CODGUARD_ADMIN_KEY = 'test-admin-key';
process.env.CODGUARD_DEMO_RATE_LIMIT = '10000'; // this suite intentionally exceeds the public 30/min demo limit
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;

const { app, boot } = await import('../src/server.js');
const { DEMO_API_KEY } = await import('../src/demoTenant.js');
const orders = await import('../src/orders.js');
const { getState } = await import('../src/store.js');
const { feeFor, feeForOrder, bandFor, ladderFor, DEFAULT_POLICY } = await import('../src/policyConfig.js');

let server, base, demoTenant;
const J = { 'content-type': 'application/json' };
const H = (key) => ({ ...J, 'X-API-Key': key });
const AH = { ...J, 'X-Admin-Key': 'test-admin-key' };
const post = (path, body, headers = J) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
const get = (path, headers) => fetch(base + path, headers ? { headers } : undefined);
const tokenOf = (o) => o.buyer_path.split('/').pop();
let seq = 0;
const input = (over = {}) => ({ buyer_name: 'Test Buyer', phone: `98100008${String(++seq).padStart(2, '0')}`, pin: '560034', city: 'Bengaluru', address: 'Flat 1, A Road, HSR Layout, Bengaluru 560034', amount: 1000, ...over });

before(async () => {
  demoTenant = (await boot()).id;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** Create an order in the demo tenant through the dashboard route. */
async function demoOrder(over) {
  const r = await post('/api/orders', input(over));
  assert.equal(r.status, 201);
  return r.json();
}
/** A second tenant with its own live key. */
async function otherTenant(name = 'Other Brand') {
  const t = await (await post('/admin/api/tenants', { name, plan: 'growth' }, AH)).json();
  const k = await (await post(`/admin/api/tenants/${t.id}/keys`, { kind: 'live' }, AH)).json();
  return { tenant: t, key: k.key };
}
const BUYER_VIEW_KEYS = ['address', 'balance_at_delivery_rs', 'brand_name', 'buyer_first_name', 'can_confirm', 'can_fix_address', 'can_pay', 'demo', 'full_online', 'ladder', 'notice', 'order_ref', 'order_value_rs', 'paid_rs', 'pay_now_rs', 'payment', 'payment_mode', 'product', 'read_only', 'requested_action', 'risk_band', 'risk_band_label', 'risk_score', 'status_message', 'upfront_fee_rs', 'upi_apps', 'your_reply'];

test('fee ladder: exact boundaries 29/30/49/50/69/70/84/85/100, fee never above order value', () => {
  const p = DEFAULT_POLICY;
  const cases = [[0, 'LOW', 0], [29, 'LOW', 0], [30, 'MEDIUM', 0], [49, 'MEDIUM', 0], [50, 'HIGH', 49], [69, 'HIGH', 49], [70, 'VERY_HIGH', 99], [84, 'VERY_HIGH', 99], [85, 'EXTREME', 149], [100, 'EXTREME', 149]];
  for (const [score, band, fee] of cases) {
    assert.equal(bandFor(score, p), band, `band at ${score}`);
    assert.equal(feeFor(score, p), fee, `fee at ${score}`);
  }
  assert.equal(feeForOrder(100, p, 120), 120);
  assert.equal(feeForOrder(85, p, 99.9), 99);
  assert.equal(feeForOrder(60, p, 5000), 49);
  assert.deepEqual(ladderFor(p).map((r) => [r.band, r.min, r.max, r.fee_rs]), [['LOW', 0, 29, 0], ['MEDIUM', 30, 49, 0], ['HIGH', 50, 69, 49], ['VERY_HIGH', 70, 84, 99], ['EXTREME', 85, 100, 149]]);
});

test('seed: 40 synthetic orders, 34 COD / 6 prepaid, all five bands, original five ids kept', async () => {
  const all = await (await get('/api/orders')).json();
  assert.equal(all.length, 40);
  assert.equal(all.filter((o) => o.payment_mode === 'prepaid').length, 6);
  assert.deepEqual([...new Set(all.filter((o) => o.payment_mode === 'cod').map((o) => o.risk_band))].sort(), ['EXTREME', 'HIGH', 'LOW', 'MEDIUM', 'VERY_HIGH']);
  assert.deepEqual(all.slice(0, 5).map((o) => [o.id, o.buyer_name]), [['CG-1001', 'Aarav Mehta'], ['CG-1002', 'Sneha Reddy'], ['CG-1003', 'Rohit Verma'], ['CG-1004', 'Priya Nair'], ['CG-1005', 'Kabir Singh']]);
  for (const o of all) {
    assert.equal(o.status, 'PENDING_REVIEW');
    assert.equal(o.decision, null);
    if (o.payment_mode === 'cod') assert.equal(o.balance_at_delivery_rs, Math.round((o.amount - o.pay_now_rs) * 100) / 100);
    assert.ok(o.steps.address_check.source !== 'llm', 'seed never makes LLM calls');
  }
  const meta = await (await get('/api/meta')).json();
  assert.deepEqual(meta.fee_ladder.map((r) => r.fee_rs), [0, 0, 49, 99, 149]);
});

test('buyer token: 192-bit random, narrow view only, global lookup across tenants reveals nothing internal', async () => {
  const o = await demoOrder({ address: 'Near bus stand', pin: '110096' });
  const token = tokenOf(o);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/); // 24 random bytes, base64url
  assert.ok(o.buyer_url.endsWith(o.buyer_path) && o.buyer_url.startsWith('http://127.0.0.1:'), 'buyer URL uses the request origin when no public base is configured');
  const r = await get(`/api/buyer/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const v = await r.json();
  assert.deepEqual(Object.keys(v).sort(), BUYER_VIEW_KEYS);
  const raw = JSON.stringify(v);
  for (const leak of [o.tenant_id, o.phone, token, DEMO_API_KEY, '"events"', '"reasons"', '"score"', '"decision"', '"decision_by"', '"tenant_id"', '"buyer_token"', '"steps"']) assert.ok(!raw.includes(leak), `buyer view leaks ${leak}`);

  // An order of a different tenant (via authenticated /v1) is reachable only by its own token, with the same narrow view.
  const { key } = await otherTenant();
  const other = await (await post('/v1/orders', input(), H(key))).json();
  assert.ok(other.buyer_path && other.buyer_url, '/v1 exposes the buyer path to the owning tenant');
  const ov = await (await get(`/api/buyer/${tokenOf(other)}`)).json();
  assert.deepEqual(Object.keys(ov).sort(), BUYER_VIEW_KEYS);
  assert.equal(ov.brand_name, 'Chhaya Threads');
  assert.ok(!JSON.stringify(ov).includes(other.tenant_id));
  // Tenant isolation is unchanged: the other tenant cannot read demo orders.
  assert.equal((await get(`/v1/orders/${o.id}`, H(key))).status, 404);
});

test('buyer view shows the risk score beside the band, and nothing more private', async () => {
  const o = await demoOrder({ address: 'Near bus stand', pin: '110096', amount: 1500, past_orders: 2, past_returns: 1 });
  const v = await (await get(`/api/buyer/${tokenOf(o)}`)).json();
  assert.equal(v.risk_score, o.score);
  assert.equal(v.risk_band, o.risk_band);
  assert.ok(!('reasons' in v) && !('events' in v) && !('tenant_id' in v) && !('score' in v));
  const pre = await demoOrder({ payment_mode: 'prepaid' });
  assert.equal((await (await get(`/api/buyer/${tokenOf(pre)}`)).json()).risk_score, null);
});

test('invalid tokens: 404 for page and API, malformed or unknown', async () => {
  for (const t of ['nope', 'A'.repeat(32), 'A'.repeat(31) + '!', '../api/orders', 'x'.repeat(200)]) {
    assert.equal((await get(`/api/buyer/${encodeURIComponent(t)}`)).status, 404, t);
    assert.equal((await post(`/api/buyer/${encodeURIComponent(t)}/confirm`)).status, 404, t);
  }
  const page = await get('/buyer/' + 'B'.repeat(32));
  assert.equal(page.status, 404);
  assert.match(await page.text(), /not valid/);
  const good = await demoOrder();
  const ok = await get(good.buyer_path);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /DEMO/);
});

test('simulated payment: upfront adjusts balance, repeat is idempotent, no decision made', async () => {
  // risky order -> HIGH+ band with a fee
  const o = await demoOrder({ buyer_name: 'Pay Test', address: 'Near bus stand', pin: '110096', amount: 1999, past_orders: 3, past_returns: 1 });
  assert.ok(o.commitment_fee_rs > 0, `expected a fee, got band ${o.risk_band}`);
  const t = tokenOf(o);
  const r1 = await (await post(`/api/buyer/${t}/pay`, { type: 'upfront', app: 'phonepe' })).json();
  assert.equal(r1.already_recorded, false);
  assert.equal(r1.payment.amount_rs, o.commitment_fee_rs);
  assert.equal(r1.payment.balance_due_rs, o.amount - o.commitment_fee_rs);
  assert.match(r1.message, /DEMO/);
  assert.match(r1.message, /seller still reviews/i);
  assert.doesNotMatch(r1.message, /will (be )?ship|dispatched|confirmed for shipping/i);
  const r2 = await (await post(`/api/buyer/${t}/pay`, { type: 'upfront', app: 'gpay' })).json();
  assert.equal(r2.already_recorded, true);
  assert.equal(r2.payment.reference, r1.payment.reference);
  const after = orders.getOrder(demoTenant, o.id);
  assert.equal(after.events.filter((e) => e.type === 'payment').length, 1, 'payment recorded once');
  assert.equal(after.status, 'PENDING_REVIEW');
  assert.equal(after.decision, null);
  assert.equal(after.buyer_reply, 'paid');
  assert.equal(after.payment.simulated, true);
  // After recording, nothing asks for payment again: view, amounts, message, reminder.
  const v = r2.view;
  assert.equal(v.pay_now_rs, 0, 'nothing newly due now');
  assert.equal(v.paid_rs, o.commitment_fee_rs);
  assert.equal(v.upfront_fee_rs, o.commitment_fee_rs, 'original request kept for reference');
  assert.equal(v.balance_at_delivery_rs, o.amount - o.commitment_fee_rs);
  assert.equal(v.requested_action, 'none');
  assert.equal(v.can_pay, false);
  assert.equal(after.pay_now_rs, 0);
  assert.equal(after.paid_rs, o.commitment_fee_rs);
  assert.doesNotMatch(after.whatsapp, /please pay|pay a refundable|upfront here/i);
  assert.match(after.whatsapp, /recorded your demo upfront payment/);
  assert.match(after.whatsapp, /remains due at delivery/);
  await orders.timeWarp(demoTenant, 13);
  assert.equal(orders.getOrder(demoTenant, o.id).reminder ?? null, null, 'no payment reminder after a recorded payment');
});

test('5% full online discount is EXTREME-only', async () => {
  const ext = await demoOrder({ buyer_name: 'Xyz', phone: '9999999999', address: 'abc', pin: '421302', amount: 2000 });
  assert.equal(ext.risk_band, 'EXTREME');
  const v = await (await get(`/api/buyer/${tokenOf(ext)}`)).json();
  assert.deepEqual(v.full_online, { available: true, discount_pct: 5, discount_rs: 100, amount_rs: 1900 });
  const r = await (await post(`/api/buyer/${tokenOf(ext)}/pay`, { type: 'full_online', app: 'bhim' })).json();
  assert.equal(r.payment.type, 'full_online');
  assert.equal(r.payment.amount_rs, 1900);
  assert.equal(r.payment.discount_rs, 100);
  assert.equal(r.payment.balance_due_rs, 0);
  assert.match(r.message, /seller still reviews/i);
  assert.deepEqual([r.view.pay_now_rs, r.view.paid_rs, r.view.balance_at_delivery_rs, r.view.full_online.available, r.view.can_pay], [0, 1900, 0, false, false]);
  assert.match(orders.getOrder(demoTenant, ext.id).whatsapp, /Nothing is due at delivery/);

  const high = await demoOrder({ buyer_name: 'High Band', address: 'Near bus stand', pin: '110096', amount: 1500, past_orders: 2, past_returns: 1 });
  assert.ok(['HIGH', 'VERY_HIGH'].includes(high.risk_band), high.risk_band);
  const bad = await post(`/api/buyer/${tokenOf(high)}/pay`, { type: 'full_online', app: 'gpay' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'full_online_not_offered');
  assert.equal(orders.getOrder(demoTenant, high.id).payment, null);
  // MEDIUM has no upfront amount at all
  const med = await demoOrder({ pin: '110096', amount: 900 }); // pin +30 -> MEDIUM
  assert.equal(med.risk_band, 'MEDIUM');
  assert.equal((await post(`/api/buyer/${tokenOf(med)}/pay`, { type: 'upfront' })).status, 400);
});

test('confirmation and address correction are evidence only: no automatic decision, human decision retained', async () => {
  const med = await demoOrder({ pin: '110096', amount: 900 });
  const c = await (await post(`/api/buyer/${tokenOf(med)}/confirm`)).json();
  assert.match(c.message, /seller still reviews/i);
  let o = orders.getOrder(demoTenant, med.id);
  assert.equal(o.buyer_reply, 'confirm');
  assert.equal(o.status, 'PENDING_REVIEW');
  assert.equal(o.decision, null);

  const vague = await demoOrder({ buyer_name: 'Addr Fix', address: 'Near temple', pin: '500081', amount: 900 });
  await post(`/api/orders/${vague.id}/action`, { action: 'hold' }); // human decision first
  const before = orders.getOrder(demoTenant, vague.id).score;
  const fix = await post(`/api/buyer/${tokenOf(vague)}/address`, { address: 'Flat 9, Sector 3, Madhapur, near Cyber Towers, Hyderabad 500081' });
  assert.equal(fix.status, 200);
  o = orders.getOrder(demoTenant, vague.id);
  assert.equal(o.address, 'Flat 9, Sector 3, Madhapur, near Cyber Towers, Hyderabad 500081');
  assert.ok(o.score < before, `rescored down from ${before} to ${o.score}`);
  assert.equal(o.decision, 'hold', 'human decision retained');
  assert.equal(o.status, 'HOLD');
  assert.equal(o.buyer_reply, 'address_fixed');
  assert.ok(o.events.some((e) => e.type === 'address_fixed' && e.by === 'buyer'));
  assert.ok(o.events.some((e) => e.type === 'rescore'));
  assert.equal(o.risk_band, 'LOW', 'complete address moved the order to LOW');
  assert.equal(o.whatsapp, null, 'LOW orders get no buyer message');
  assert.equal((await post(`/api/buyer/${tokenOf(vague)}/address`, { address: 'short' })).status, 400);
});

test('cancelled orders are read-only on the buyer page', async () => {
  const o = await demoOrder({ address: 'Near bus stand', pin: '110096', amount: 1500, past_orders: 2, past_returns: 1 });
  await post(`/api/orders/${o.id}/action`, { action: 'cancel' });
  const v = await (await get(`/api/buyer/${tokenOf(o)}`)).json();
  assert.equal(v.read_only, true);
  assert.equal(v.can_pay || v.can_confirm || v.can_fix_address, false);
  for (const [path, body] of [['/confirm', {}], ['/pay', { type: 'upfront' }], ['/address', { address: 'Flat 1, New Road, near park, Delhi 110096' }]]) {
    const r = await post(`/api/buyer/${tokenOf(o)}${path}`, body);
    assert.equal(r.status, 409, path);
    assert.equal((await r.json()).error.code, 'order_cancelled');
  }
  assert.equal(orders.getOrder(demoTenant, o.id).payment, null);
});

test('same-phone rescoring: same tenant + same IST day only, cached evidence, decisions untouched', async () => {
  const phone = '9810000977';
  const first = await demoOrder({ phone, buyer_name: 'Same Phone' });
  await post(`/api/orders/${first.id}/action`, { action: 'hold' });
  const firstEvidence = JSON.stringify(orders.getOrder(demoTenant, first.id).steps.address_check);
  // An order with the same phone yesterday (IST) must not be touched.
  const old = await demoOrder({ phone: '9810000978', buyer_name: 'Yesterday' });
  const oldRow = getState().orders.find((x) => x.id === old.id);
  oldRow.created_at = new Date(Date.now() - 36 * 3600_000).toISOString();
  const oldScore = oldRow.score;
  // Other tenant, same phone, same day.
  const { key } = await otherTenant('Phone Iso');
  const foreign = await (await post('/v1/orders', input({ phone }), H(key))).json();

  const second = await demoOrder({ phone, buyer_name: 'Same Phone' });
  await demoOrder({ phone: '9810000978', buyer_name: 'Yesterday' });
  const f = orders.getOrder(demoTenant, first.id);
  assert.equal(f.orders_same_phone_today, 2);
  assert.equal(second.orders_same_phone_today, 2);
  assert.equal(f.score, first.score + 15, 'phone frequency added to the earlier order');
  assert.ok(f.events.some((e) => e.type === 'rescore' && e.from === first.score && e.to === f.score));
  assert.equal(f.decision, 'hold');
  assert.equal(f.status, 'HOLD');
  assert.equal(JSON.stringify(f.steps.address_check), firstEvidence, 'cached evidence reused');
  assert.equal(orders.findByToken(tokenOf(foreign)).score, foreign.score, 'other tenant untouched');
  assert.equal(orders.findByToken(tokenOf(foreign)).orders_same_phone_today, 1);
  assert.equal(getState().orders.find((x) => x.id === old.id).score, oldScore, 'previous IST day untouched');
  assert.equal(orders.istDay('2026-11-23T18:29:00Z'), '2026-11-23');
  assert.equal(orders.istDay('2026-11-23T18:31:00Z'), '2026-11-24');
});

test('undo: clears decision, back to PENDING_REVIEW, audited + webhook, and never re-decided automatically', async () => {
  const o = await demoOrder({ address: 'Near bus stand', pin: '110096', amount: 1500, past_orders: 2, past_returns: 1 });
  assert.ok(o.commitment_fee_rs > 0);
  assert.equal((await post(`/api/orders/${o.id}/action`, { action: 'undo' })).status, 400, 'nothing to undo');
  await post(`/api/orders/${o.id}/action`, { action: 'ship' });
  const u = await (await post(`/api/orders/${o.id}/action`, { action: 'undo' })).json();
  assert.equal(u.status, 'PENDING_REVIEW');
  assert.equal(u.decision, null);
  assert.equal(u.decision_by, null);
  assert.equal(u.decided_at, null);
  assert.ok(u.events.some((e) => e.type === 'undo' && e.by === 'seller'));
  await orders.timeWarp(demoTenant, 30); // silent upfront order, but a human acted: no auto-cancel
  const after = orders.getOrder(demoTenant, o.id);
  assert.equal(after.status, 'PENDING_REVIEW');
  assert.equal(after.decision, null);
  const { WEBHOOK_EVENTS } = await import('../src/webhooks.js');
  assert.ok(WEBHOOK_EVENTS.includes('order.decision_undone'));
});

test('reply clear is audited, refused after payment, and blocks auto-cancel', async () => {
  const o = await demoOrder({ address: 'Near bus stand', pin: '110096', amount: 1500, past_orders: 2, past_returns: 1 });
  await post(`/api/orders/${o.id}/reply`, { reply: 'no_reply' });
  const c = await (await post(`/api/orders/${o.id}/reply`, { reply: 'clear' })).json();
  assert.equal(c.buyer_reply, null);
  assert.ok(c.events.some((e) => e.type === 'reply_cleared'));
  await orders.timeWarp(demoTenant, 30);
  assert.equal(orders.getOrder(demoTenant, o.id).status, 'PENDING_REVIEW');
  await post(`/api/buyer/${tokenOf(o)}/pay`, { type: 'upfront', app: 'gpay' });
  assert.equal((await post(`/api/orders/${o.id}/reply`, { reply: 'clear' })).status, 400);
});

test('CSV replace: explicit confirm, validates every row first, demo tenant only', async () => {
  const { key } = await otherTenant('CSV Iso');
  const foreign = await (await post('/v1/orders', input(), H(key))).json();
  const beforeCount = (await (await get('/api/orders')).json()).length;
  const good = { order_id: 'R1', name: 'Csv One', phone: '9810000901', pincode: '560034', address: 'Flat 1, A Road, HSR Layout, Bengaluru 560034', order_value: '900' };
  let r = await post('/api/import', { orders: [good], mode: 'replace' });
  assert.equal(r.status, 400, 'no confirm');
  r = await post('/api/import', { orders: [good, { ...good, order_id: 'R2', pincode: '12' }], mode: 'replace', confirm: 'REPLACE' });
  assert.equal(r.status, 400, 'invalid row blocks replace');
  assert.ok((await r.json()).error.details.some((d) => d.row === 2));
  r = await post('/api/import', { orders: [good, { ...good }], mode: 'replace', confirm: 'REPLACE' });
  assert.equal(r.status, 400, 'duplicate order ids block replace');
  assert.equal((await (await get('/api/orders')).json()).length, beforeCount, 'nothing deleted on failure');
  r = await post('/api/import', { orders: [good, { ...good, order_id: 'R2', name: 'Csv Two', phone: '9810000902' }], mode: 'replace', confirm: 'REPLACE' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.replaced, beforeCount);
  const now = await (await get('/api/orders')).json();
  assert.deepEqual(now.map((o) => o.external_id), ['R1', 'R2']);
  assert.ok(now.every((o) => o.source === 'csv'));
  assert.ok(orders.findByToken(tokenOf(foreign)), 'other tenant orders untouched');
  // append keeps existing rows
  r = await post('/api/import', { orders: [{ ...good, order_id: 'A1', phone: '9810000903' }] });
  assert.equal((await r.json()).mode, 'append');
  assert.equal((await (await get('/api/orders')).json()).length, 3);
  await post('/api/reset'); // restore the seed for later tests
  assert.equal((await (await get('/api/orders')).json()).length, 40);
});

test('Shopify-shaped simulator: mapped, labelled as simulator, idempotent by id', async () => {
  const payload = { id: 777001, name: '#WMA777001', total_price: '2999.00', source_name: 'wma-test-store', gateway: 'Cash on Delivery (COD)', financial_status: 'pending',
    customer: { first_name: 'Store', last_name: 'Buyer', phone: '+91 98100 00955' }, shipping_address: { first_name: 'Store', last_name: 'Buyer', phone: '9810000955', address1: 'Near temple', city: 'Delhi', zip: '110096' },
    line_items: [{ title: 'Silk saree', quantity: 1, price: '2999.00' }] };
  const r = await post('/api/webhooks/shopify/orders-create', payload);
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('x-wma-demo-simulator'), 'true');
  const d = await r.json();
  assert.equal(d.simulator, true);
  assert.match(d.notice, /not an authenticated Shopify webhook/);
  assert.equal(d.external_id, 'shopify-777001');
  assert.ok(d.buyer_path.startsWith('/buyer/') && d.dashboard_path === `/?order=${d.order_id}`);
  assert.equal(d.fee_ladder.length, 5);
  const o = orders.getOrder(demoTenant, d.order_id);
  assert.equal(o.source, 'storefront');
  assert.equal(o.phone, '9810000955');
  assert.equal(o.status, 'PENDING_REVIEW');
  const again = await post('/api/webhooks/shopify/orders-create', payload);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).order_id, d.order_id);
  assert.equal((await post('/api/webhooks/shopify/orders-create', { id: 1 })).status, 400);
});

test('policy preserved: messages use real buyer link, full-online only for EXTREME, settings rescore without changing decisions', async () => {
  const all = await (await get('/api/orders')).json();
  for (const o of all.filter((x) => x.whatsapp)) {
    assert.ok(o.whatsapp.includes(o.buyer_url), `${o.id} message links its buyer page`);
    assert.ok(!o.whatsapp.includes('pay.wapas-mat-aana.example'));
    assert.equal(/full amount online/.test(o.whatsapp), o.risk_band === 'EXTREME', `${o.id} full-online mention`);
    if (o.risk_band === 'MEDIUM') assert.match(o.whatsapp, /nothing to pay now/i);
  }
  const high = all.find((o) => o.risk_band === 'HIGH');
  await post(`/api/orders/${high.id}/action`, { action: 'hold' });
  const r = await fetch(base + '/api/policy', { method: 'PUT', headers: J, body: JSON.stringify({ feeHigh: 59 }) });
  assert.equal(r.status, 200);
  const h = orders.getOrder(demoTenant, high.id);
  assert.equal(h.commitment_fee_rs, 59);
  assert.match(h.whatsapp, /₹59 upfront/);
  assert.equal(h.decision, 'hold');
  assert.equal((await fetch(base + '/api/policy', { method: 'PUT', headers: J, body: JSON.stringify({ feeHigh: -5, nope: 1 }) })).status, 400);
  await fetch(base + '/api/policy', { method: 'PUT', headers: J, body: JSON.stringify({ feeHigh: 49 }) });
  assert.equal(orders.getOrder(demoTenant, high.id).commitment_fee_rs, 49);
  // brand rename re-renders every message
  await fetch(base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ brand_name: 'Renamed Store' }) });
  assert.ok((await (await get('/api/orders')).json()).filter((o) => o.whatsapp).every((o) => o.whatsapp.endsWith('- Renamed Store')));
  await fetch(base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ brand_name: 'Chhaya Threads' }) });
});

test('bulk reply simulation: deterministic mix, skips replied or decided orders, never decides', async () => {
  await post('/api/reset');
  await post('/api/orders/CG-1002/reply', { reply: 'confirm' }); // already replied
  await post('/api/orders/CG-1004/action', { action: 'hold' }); // already decided
  const d = await (await post('/api/demo/bulk', { action: 'simulate_replies' })).json();
  const byId = Object.fromEntries(d.orders.map((o) => [o.id, o]));
  const simulated = (list) => list.filter((o) => o.id !== 'CG-1002' && o.events.some((e) => e.by === 'simulation'));
  const replies = simulated(d.orders).map((o) => o.buyer_reply);
  assert.equal(replies.length, d.changed);
  assert.ok(new Set(replies).size >= 3, `mixed replies: ${[...new Set(replies)]}`);
  assert.ok(replies.includes('address_fixed') && replies.includes('no_reply'));
  assert.equal(byId['CG-1002'].buyer_reply, 'confirm');
  assert.ok(!byId['CG-1004'].events.some((e) => e.by === 'simulation'));
  assert.ok(d.orders.every((o) => o.id === 'CG-1004' ? o.decision === 'hold' : o.decision === null), 'no decisions from simulation');
  const d2 = await (await post('/api/demo/bulk', { action: 'simulate_replies' })).json();
  assert.equal(d2.changed, 0, 'second run skips everything already replied');
  const first = simulated(d.orders).map((o) => `${o.id}:${o.buyer_reply}`);
  await post('/api/reset');
  await post('/api/orders/CG-1002/reply', { reply: 'confirm' });
  await post('/api/orders/CG-1004/action', { action: 'hold' });
  const d3 = await (await post('/api/demo/bulk', { action: 'simulate_replies' })).json();
  assert.deepEqual(simulated(d3.orders).map((o) => `${o.id}:${o.buyer_reply}`), first, 'deterministic');
});

test('OpenAPI enums match runtime: statuses, bands, webhook events, actions, replies', async () => {
  const spec = await (await get('/v1/openapi.json')).json();
  const { WEBHOOK_EVENTS } = await import('../src/webhooks.js');
  const S = spec.components.schemas;
  assert.deepEqual(S.Order.properties.status.enum.sort(), ['CANCELLED', 'HOLD', 'PENDING_REVIEW', 'SHIPPED']);
  assert.deepEqual(S.Order.properties.risk_band.enum.sort(), ['EXTREME', 'HIGH', 'LOW', 'MEDIUM', 'VERY_HIGH']);
  assert.deepEqual(S.Webhook.properties.events.items.enum.slice().sort(), WEBHOOK_EVENTS.slice().sort());
  const action = spec.paths['/v1/orders/{id}/actions'].post.requestBody.content['application/json'].schema.properties.action.enum;
  assert.deepEqual(action, ['ship', 'hold', 'cancel', 'override', 'undo']);
  const reply = spec.paths['/v1/orders/{id}/buyer-reply'].post.requestBody.content['application/json'].schema.properties.reply.enum;
  assert.deepEqual(reply.slice().sort(), [...orders.BUYER_REPLIES, 'clear'].sort());
  for (const p of ['/api/buyer/{token}', '/api/buyer/{token}/pay', '/api/webhooks/shopify/orders-create']) assert.ok(spec.paths[p], `documents ${p}`);
});
