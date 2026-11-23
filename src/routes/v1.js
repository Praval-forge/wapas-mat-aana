// The platform API (/v1): what an app like Swiggy, Zomato or Amazon integrates.
// Authenticated per-tenant via X-API-Key. Consistent error shape:
// { error: { code, message, details? } }. OpenAPI spec: GET /v1/openapi.json.
import express from 'express';
import { settingsFor, updateSettings } from '../settings.js';
import { requireKey, enforceOrderQuota, apiError } from '../auth.js';
import { validateOrder } from '../validate.js';
import * as orders from '../orders.js';
import { meter, usageForTenant, PLANS, policyFor, setTenantPolicy } from '../tenants.js';
import { validatePolicyPatch, PolicyError } from '../policyConfig.js';
import { registerWebhook, listWebhooks, deleteWebhook, listDeliveries, WebhookError, WEBHOOK_EVENTS } from '../webhooks.js';
import { llmEnabled, MODEL } from '../addressLLM.js';
import { trustedBase } from '../publicBase.js';

export const v1 = express.Router();

v1.use((req, res, next) => {
  res.set('X-CODGuard-Version', '2.0');
  next();
});

// Unauthenticated: liveness probe and service metadata.
v1.get('/health', (_req, res) => res.json({ ok: true, version: '2.0', time: new Date().toISOString() }));
v1.get('/meta', (req, res) =>
  res.json({
    service: 'wapas-mat-aana',
    version: '2.0',
    mode: llmEnabled() ? 'llm' : 'demo',
    model: llmEnabled() ? MODEL : null,
    docs: '/docs',
    plans: Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p])),
    webhook_events: WEBHOOK_EVENTS,
  })
);

v1.use(requireKey()); // everything below needs a valid key

// Finer scope checks against the already-resolved key (no re-auth, no double metering).
const scope = (...scopes) => (req, res, next) => {
  const missing = scopes.filter((s) => !req.keyRow.scopes.includes(s));
  return missing.length
    ? apiError(res, 403, 'insufficient_scope', `This key lacks scope(s): ${missing.join(', ')}.`, { required: scopes })
    : next();
};

// Ingest a new COD order: validate -> score on all signals -> route.
// Idempotent: a retry with the same external_id or Idempotency-Key returns the
// original order (200, Idempotent-Replay: true) instead of double-scoring.
v1.post('/orders', scope('orders:write'), enforceOrderQuota, async (req, res) => {
  const { order, problems } = validateOrder(req.body);
  if (problems) return apiError(res, 400, 'invalid_order', 'The order payload is invalid.', problems);
  try {
    const created = await orders.createOrder(req.tenant.id, order, {
      external_id: req.body?.external_id ?? req.body?.platform_order_id,
      idempotency_key: req.get('Idempotency-Key'),
      seller_request: req.body?.seller_request,
      source: 'api',
      public_base: trustedBase(req),
    });
    meter(req.keyRow.id, { order: true });
    res.status(201).json(created);
  } catch (e) {
    if (e instanceof orders.IdempotentReplay) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json(e.order);
    }
    throw e;
  }
});

// Stateless scoring preview: same pipeline, nothing stored, no quota consumed.
v1.post('/orders/score', scope('orders:write'), async (req, res) => {
  const { order, problems } = validateOrder(req.body);
  if (problems) return apiError(res, 400, 'invalid_order', 'The order payload is invalid.', problems);
  const r = await orders.runPipeline(order, policyFor(req.tenant.id));
  res.json({
    score: r.score.score,
    risk: r.score.level,
    rule: r.score.rule,
    reasons: r.score.reasons,
    breakdown: r.score.breakdown,
    steps: { pin_check: r.pinCheck, history: r.history, address_check: r.addressCheck },
  });
});

v1.get('/orders', scope('orders:read'), (req, res) => {
  let list = orders.listOrders(req.tenant.id);
  const { status, risk, external_id } = req.query;
  if (status) list = list.filter((o) => o.status === String(status).toUpperCase());
  if (risk) list = list.filter((o) => o.risk === String(risk).toUpperCase());
  if (external_id) list = list.filter((o) => o.external_id === external_id);
  res.json({ orders: list, count: list.length });
});

v1.get('/orders/:id', scope('orders:read'), (req, res) => {
  const o = orders.getOrder(req.tenant.id, req.params.id) ?? orders.getOrderByExternalId(req.tenant.id, req.params.id);
  return o ? res.json(o) : apiError(res, 404, 'order_not_found', 'Order not found.');
});

// The platform (or its WhatsApp provider) posts buyer reply events here.
v1.post('/orders/:id/buyer-reply', scope('orders:action'), async (req, res) => {
  try {
    res.json(await orders.applyReply(req.tenant.id, req.params.id, req.body?.reply, { source: 'api' }));
  } catch (e) {
    if (e instanceof orders.WorkflowError) return apiError(res, 400, 'workflow_error', e.message);
    throw e;
  }
});

// Seller / brand actions: ship | hold | override (override needs a note).
v1.post('/orders/:id/actions', scope('orders:action'), async (req, res) => {
  try {
    res.json(await orders.applyAction(req.tenant.id, req.params.id, req.body ?? {}));
  } catch (e) {
    if (e instanceof orders.WorkflowError) return apiError(res, 400, 'workflow_error', e.message);
    throw e;
  }
});

// Fairness guard: blanket group rules are always refused (HTTP 422).
v1.get('/seller-rules', scope('orders:read'), (_req, res) => res.json({ rules: [] }));
v1.post('/seller-rules', scope('orders:write'), (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return apiError(res, 400, 'invalid_rule', 'text is required');
  res.status(422).json({ error: { code: 'rule_refused', message: 'Blanket group rules are not supported.', details: orders.submitSellerRule(req.tenant.id, text) } });
});

// Per-brand policy: read the effective policy, patch overrides.
v1.get('/policy', scope('policy:manage'), (req, res) => res.json(policyFor(req.tenant.id)));
v1.put('/policy', scope('policy:manage'), async (req, res) => {
  try {
    const overrides = validatePolicyPatch(req.tenant.policy_overrides, req.body ?? {});
    setTenantPolicy(req.tenant.id, overrides);
    await orders.refreshTenantOrders(req.tenant.id, 'brand policy changed'); // cached evidence, no LLM calls
    res.json(policyFor(req.tenant.id));
  } catch (e) {
    if (e instanceof PolicyError) return apiError(res, 422, 'invalid_policy', e.message, e.problems);
    throw e;
  }
});

// Brand settings used by message composition and illustrative savings estimates.
v1.get('/settings', scope('policy:manage'), (req,res) => res.json(settingsFor(req.tenant.id)));
v1.put('/settings', scope('policy:manage'), async (req,res) => {
  try { const out = updateSettings(req.tenant.id,req.body ?? {}); await orders.refreshTenantOrders(req.tenant.id, 'brand settings changed'); res.json(out); }
  catch(e) { apiError(res,400,'invalid_settings',e.message); }
});
v1.get('/orders/:id/suggestion', scope('orders:read'), (req,res) => {
 const o=orders.getOrder(req.tenant.id,req.params.id);
 return o ? res.json({action:orders.suggestion(o),requires_seller_approval:true}) : apiError(res,404,'order_not_found','Order not found');
});
// Outbound webhooks (signed, per-tenant secret shown once).
v1.post('/webhooks', scope('webhooks:manage'), (req, res) => {
  try {
    res.status(201).json(registerWebhook(req.tenant.id, req.body ?? {}));
  } catch (e) {
    if (e instanceof WebhookError) return apiError(res, e.status, 'webhook_error', e.message);
    throw e;
  }
});
v1.get('/webhooks', scope('webhooks:manage'), (req, res) => res.json({ webhooks: listWebhooks(req.tenant.id) }));
v1.delete('/webhooks/:id', scope('webhooks:manage'), (req, res) => {
  try {
    res.json(deleteWebhook(req.tenant.id, req.params.id));
  } catch (e) {
    if (e instanceof WebhookError) return apiError(res, e.status, 'webhook_error', e.message);
    throw e;
  }
});
v1.get('/webhooks-deliveries', scope('webhooks:manage'), (req, res) => res.json({ deliveries: listDeliveries(req.tenant.id) }));

// Usage metering for the calling tenant.
v1.get('/usage', (req, res) => {
  res.json({
    tenant_id: req.tenant.id,
    plan: req.tenant.plan,
    plan_limits: PLANS[req.tenant.plan],
    usage: usageForTenant(req.tenant.id),
  });
});

v1.use((_req, res) => apiError(res, 404, 'not_found', 'Unknown /v1 endpoint. See GET /v1/openapi.json.'));
