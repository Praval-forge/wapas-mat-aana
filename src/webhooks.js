// Outbound webhooks: platforms register an HTTPS endpoint per tenant and get
// notified when orders are scored or change state. Every delivery is signed
// (HMAC-SHA256, per-webhook secret) so the receiver can verify it came from
// Wapas Mat Aana. Deliveries are logged and retried once.
import crypto from 'node:crypto';
import { getState, save } from './store.js';
import { PLANS, getTenant } from './tenants.js';

export const WEBHOOK_EVENTS = [
  'order.scored', 'order.auto_cancelled', 'order.reply_received', 'order.review_required', // a new order was ingested and scored
  'order.status_changed', // ship / hold / cancel transitions (buyer reply, silence sweep, seller action)
  'order.overridden', // a seller overrode the system decision
  'order.reminded', // the one reminder message was sent
];

const DELIVERY_LOG_CAP = 200;
const now = () => new Date().toISOString();

export class WebhookError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
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
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new WebhookError('url must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new WebhookError('url must be http(s). Use https in production.');
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
    status: order.status,
    created_at: order.created_at,
  };
}

async function deliverOnce(hook, payload, signature) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codguard-event': payload.event,
        'x-codguard-signature': `sha256=${signature}`,
        'user-agent': 'CODGuard-Webhooks/2.0',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) {
    return { ok: false, http_status: null, error: String(e?.message ?? e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
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
