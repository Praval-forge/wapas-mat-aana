// Outbound webhooks: platforms register an HTTPS endpoint per tenant and get
// notified when orders are scored or change state. Every delivery is signed
// (HMAC-SHA256, per-webhook secret) so the receiver can verify it came from
// Wapas Mat Aana. Deliveries are logged and retried once.
//
// SSRF guard (this is a public sandbox): destinations must be https:// with
// no URL credentials, and may not be localhost, private, link-local, CGNAT,
// multicast or other reserved addresses. IP literals are checked when the
// webhook is registered and again before each delivery; hostnames are
// re-resolved at connect time and every resolved address is checked, so DNS
// rebinding cannot reach an internal address. Redirects are never followed.
// The only relaxation is the automated test run (in-memory store under the
// test runner), which uses a local http receiver.
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { getState, save, STORE_LOCATION } from './store.js';
import { PLANS, getTenant } from './tenants.js';

export const WEBHOOK_EVENTS = [
  'order.scored', // a new order was ingested and scored
  'order.rescored', // score/band/fee changed (same-phone order, policy change, buyer address fix)
  'order.reply_received', // buyer evidence recorded (confirm, paid, address_fixed, ...); never a decision
  'order.reply_cleared', // seller cleared a mistaken reply
  'order.review_required', // buyer silence flagged for a human
  'order.reminded', // the one reminder message was generated
  'order.status_changed', // human ship / hold / cancel
  'order.overridden', // a seller overrode the suggestion (note required)
  'order.decision_undone', // a seller undid a decision; order is back to PENDING_REVIEW
  'order.auto_cancelled', // the only automatic action: 24h silent upfront request (brand toggle ON)
];

const DELIVERY_LOG_CAP = 200;
const now = () => new Date().toISOString();

export class WebhookError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------------- destination safety (SSRF) ---------------- */

// Separate lists per family: a single BlockList holding ::ffff:0:0/96 would
// also match every plain IPv4 address.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 96], // unspecified, loopback (::1) and deprecated IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64 (can map to internal IPv4)
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], // discard, IETF/Teredo, docs, 6to4
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], // unique-local, link-local, site-local, multicast
]) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6');

/** True for any address a public webhook must never reach. */
export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(ip, 'ipv6');
  return true; // not an IP at all: refuse
}

const BLOCKED_HOSTNAMES = /^(localhost|ip6-localhost|ip6-loopback|metadata|metadata\.google\.internal)$|\.(localhost|local|internal|intranet|lan|home\.arpa)$/i;

/** Automated tests (in-memory store under node --test / NODE_ENV=test) may use a local http receiver. */
function insecureDestinationsAllowed() {
  return STORE_LOCATION === ':memory:' && (Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test');
}

/** Validate a webhook URL. Returns the parsed URL or throws WebhookError. */
export function assertSafeDestination(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (raw.length > 2048) throw new WebhookError('url is too long');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookError('url must be a valid URL');
  }
  if (u.username || u.password) throw new WebhookError('url must not contain credentials');
  if (insecureDestinationsAllowed() && (u.protocol === 'http:' || u.protocol === 'https:')) return u;
  if (u.protocol !== 'https:') throw new WebhookError('url must use https://');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new WebhookError('url must include a host');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new WebhookError('url must not point to a private, loopback, link-local or reserved address');
  } else if (BLOCKED_HOSTNAMES.test(host) || !host.includes('.')) {
    throw new WebhookError('url must be a public hostname');
  }
  return u;
}

/** dns lookup that refuses to connect if ANY resolved address is blocked. */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) {
      const e = new Error('webhook destination resolves to a private or reserved address');
      e.code = 'EBLOCKEDDEST';
      return callback(e);
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [...WEBHOOK_EVENTS];
  const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (bad.length) throw new WebhookError(`unknown events: ${bad.join(', ')} (known: ${WEBHOOK_EVENTS.join(', ')})`);
  return [...new Set(events)];
}

export function registerWebhook(tenantId, { url, events }) {
  const s = getState();
  const tenant = getTenant(tenantId);
  if (!tenant) throw new WebhookError('Tenant not found', 404);
  const parsed = assertSafeDestination(url);
  const existing = s.webhooks.filter((w) => w.tenant_id === tenantId && w.active);
  const cap = PLANS[tenant.plan].maxWebhooks;
  if (existing.length >= cap) throw new WebhookError(`The ${tenant.plan} plan allows ${cap} active webhook(s)`, 402);

  const hook = {
    id: `wh_${++s.counters.webhook}`,
    tenant_id: tenantId,
    url: parsed.toString(),
    events: validateEvents(events),
    secret: `whsec_${crypto.randomBytes(24).toString('hex')}`,
    active: true,
    created_at: now(),
  };
  s.webhooks.push(hook);
  save();
  // The secret is returned once, like an API key.
  const { secret, ...pub } = hook;
  return { ...pub, secret };
}

export const listWebhooks = (tenantId) =>
  getState()
    .webhooks.filter((w) => w.tenant_id === tenantId)
    .map(({ secret, ...pub }) => pub);

export function deleteWebhook(tenantId, id) {
  const w = getState().webhooks.find((x) => x.id === id && x.tenant_id === tenantId);
  if (!w) throw new WebhookError('Webhook not found', 404);
  w.active = false;
  save();
  return { id: w.id, active: false };
}

export const listDeliveries = (tenantId) =>
  getState()
    .deliveries.filter((d) => d.tenant_id === tenantId)
    .slice(-50)
    .reverse();

function orderSummary(order) {
  return {
    id: order.id,
    external_id: order.external_id ?? null,
    buyer_name: order.buyer_name,
    phone: order.phone,
    pin: order.pin,
    product: order.product,
    amount: order.amount,
    score: order.score,
    risk: order.risk,
    risk_band: order.risk_band ?? null,
    commitment_fee_rs: order.commitment_fee_rs ?? 0,
    pay_now_rs: order.pay_now_rs ?? null,
    paid_rs: order.paid_rs ?? 0,
    balance_at_delivery_rs: order.balance_at_delivery_rs ?? null,
    payment: order.payment ? { type: order.payment.type, amount_rs: order.payment.amount_rs, balance_due_rs: order.payment.balance_due_rs, simulated: true } : null,
    status: order.status,
    // decision_by distinguishes a human seller ('human') from the 24h silent auto-cancel ('system').
    decision: order.decision ?? null,
    decision_by: order.decision_by ?? null,
    decided_at: order.decided_at ?? null,
    suggested_action: order.suggested_action ?? null,
    buyer_reply: order.buyer_reply ?? null,
    latest_event: order.events?.at(-1) ?? null,
    created_at: order.created_at,
  };
}

/**
 * POST the signed payload once. Uses node:http(s) directly so that the
 * connect-time DNS check applies and redirects are never followed (a 3xx is
 * recorded as a failed delivery).
 */
function deliverOnce(hook, payload, signature) {
  return new Promise((resolve) => {
    let u;
    try {
      u = assertSafeDestination(hook.url);
    } catch (e) {
      return resolve({ ok: false, http_status: null, error: `blocked destination: ${e.message}`.slice(0, 120) });
    }
    const body = JSON.stringify(payload);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-codguard-event': payload.event,
          'x-codguard-signature': `sha256=${signature}`,
          'user-agent': 'CODGuard-Webhooks/2.0',
        },
        lookup: insecureDestinationsAllowed() ? undefined : safeLookup,
        timeout: 5000,
      },
      (res) => {
        res.resume(); // drain and discard the receiver's body
        const status = res.statusCode ?? null;
        resolve({ ok: status >= 200 && status < 300, http_status: status, ...(status >= 300 && status < 400 ? { error: 'redirect not followed' } : {}) });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout after 5000ms')));
    req.on('error', (e) => resolve({ ok: false, http_status: null, error: String(e?.message ?? e).slice(0, 120) }));
    req.end(body);
  });
}

/**
 * Notify every active webhook of this tenant subscribed to `event`.
 * Awaits all deliveries (tests stay deterministic) but never throws:
 * a broken receiver must not break the order flow.
 */
export async function dispatch(tenantId, event, order, extra = {}) {
  const s = getState();
  const hooks = s.webhooks.filter((w) => w.tenant_id === tenantId && w.active && w.events.includes(event));
  if (!hooks.length) return [];
  const results = [];
  for (const hook of hooks) {
    const payload = {
      id: `evt_${++s.counters.event}`,
      event,
      created_at: now(),
      data: { order: orderSummary(order), ...extra },
    };
    const signature = crypto.createHmac('sha256', hook.secret).update(JSON.stringify(payload)).digest('hex');
    const started = Date.now();
    let attempt = await deliverOnce(hook, payload, signature);
    let attempts = 1;
    if (!attempt.ok) {
      await new Promise((r) => setTimeout(r, 250));
      attempt = await deliverOnce(hook, payload, signature);
      attempts = 2;
    }
    const record = {
      id: payload.id,
      tenant_id: tenantId,
      webhook_id: hook.id,
      event,
      order_id: order.id,
      ok: attempt.ok,
      http_status: attempt.http_status,
      error: attempt.error ?? null,
      attempts,
      duration_ms: Date.now() - started,
      ts: now(),
    };
    s.deliveries.push(record);
    if (s.deliveries.length > DELIVERY_LOG_CAP) s.deliveries.splice(0, s.deliveries.length - DELIVERY_LOG_CAP);
    results.push(record);
  }
  save();
  return results;
}
