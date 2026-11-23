import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Load .env if present (Node >= 20.12). Real environment variables win.
try { process.loadEnvFile(path.join(import.meta.dirname, '..', '.env')); } catch { /* no .env - fine */ }

const { llmEnabled, MODEL } = await import('./addressLLM.js');
const orders = await import('./orders.js');
const { PIN_TABLE, BUYER_HISTORY, RETURN_COST_RS } = await import('./data.js');
const { validateOrder } = await import('./validate.js');
const { v1 } = await import('./routes/v1.js');
const { admin } = await import('./routes/admin.js');
const { ensureDemoTenant, DEMO_API_KEY } = await import('./demoTenant.js');
const { validatePolicyPatch, ladderFor, FULL_ONLINE_DISCOUNT_PCT } = await import('./policyConfig.js');
const { policyFor, setTenantPolicy, getTenant } = await import('./tenants.js');
const { saveNow, STORE_LOCATION } = await import('./store.js');
const { settingsFor, updateSettings } = await import('./settings.js');
const { apiError } = await import('./auth.js');
const { trustedBase } = await import('./publicBase.js');
const { mapShopifyOrder } = await import('./shopifyDemo.js');

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// Security headers + per-request id and a one-line access log on the APIs.
// Referrer-Policy no-referrer also keeps buyer-link tokens out of Referer headers.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  const id = req.get('X-Request-Id') || crypto.randomUUID();
  res.set('X-Request-Id', id);
  if (req.path.startsWith('/v1') || req.path.startsWith('/admin/api')) {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(`[api] ${id} ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - t0}ms tenant=${req.tenant?.id ?? '-'}`);
    });
  }
  next();
});
app.use(express.static(PUBLIC_DIR));

const demoTenantId = () => ensureDemoTenant().tenant.id;

// Tiny in-memory rate limit for public demo endpoints that create or change data.
const hits = new Map();
function limit(req, res, next) {
  const key = req.ip;
  const t = Date.now();
  const recent = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
  const max = Number(process.env.CODGUARD_DEMO_RATE_LIMIT) || 30; // per IP per minute
  if (recent.length >= max) return apiError(res, 429, 'rate_limited', 'Too many requests, slow down.');
  recent.push(t);
  hits.set(key, recent);
  next();
}

function workflow(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof orders.BuyerError) return apiError(res, e.status, e.code, e.message);
      if (e instanceof orders.WorkflowError) return apiError(res, 400, 'workflow_error', e.message, e.details);
      throw e;
    }
  };
}

/* ---------- demo dashboard API (no key; operates on the built-in demo tenant) ---------- */

app.get('/api/meta', (_req, res) => {
  const { tenant } = ensureDemoTenant();
  const policy = policyFor(tenant.id);
  res.json({
    version: '2.1',
    mode: llmEnabled() ? 'llm' : 'demo',
    model: llmEnabled() ? MODEL : null,
    return_cost_rs: RETURN_COST_RS,
    fee_ladder: ladderFor(policy),
    full_online_discount_pct: FULL_ONLINE_DISCOUNT_PCT,
    known_pins: Object.keys(PIN_TABLE),
    demo_tenant_id: tenant.id,
    demo_api_key: DEMO_API_KEY, // sandbox test key, published on purpose
    policy,
    store: STORE_LOCATION === ':memory:' ? 'in-memory' : 'file',
  });
});

// Read-only reference data behind the demo scores (all synthetic / illustrative).
app.get('/api/reference', (_req, res) => {
  res.json({
    notice: 'Illustrative synthetic data. Not real statistics or real people.',
    pin_table: Object.entries(PIN_TABLE).map(([pin, r]) => ({ pin, area: r.area, return_rate: r.returnRate, sample_orders: r.orders })),
    demo_buyer_history: Object.entries(BUYER_HISTORY).map(([phone, h]) => ({ phone, ...h })),
    fee_ladder: ladderFor(policyFor(demoTenantId())),
  });
});

app.get('/api/settings', (_req, res) => res.json(settingsFor(demoTenantId())));
app.put('/api/settings', async (req, res) => {
  try {
    const out = updateSettings(demoTenantId(), req.body ?? {});
    await orders.refreshTenantOrders(demoTenantId(), 'brand settings changed'); // re-render messages, cached evidence
    res.json(out);
  } catch (e) {
    apiError(res, 400, 'invalid_settings', e.message);
  }
});
app.post('/api/demo/bulk', limit, async (req, res) => {
  try { res.json(await orders.bulkAction(demoTenantId(), req.body?.action)); } catch (e) { apiError(res, 400, 'invalid_action', e.message); }
});
app.post('/api/import', limit, workflow((req) =>
  orders.importOrders(demoTenantId(), req.body?.orders, { mode: req.body?.mode ?? 'append', confirm: req.body?.confirm, public_base: trustedBase(req) })
));
app.get('/api/orders', (_req, res) => res.json(orders.listOrders(demoTenantId())));
app.get('/api/orders/:id', (req, res) => {
  const o = orders.getOrder(demoTenantId(), req.params.id);
  return o ? res.json(o) : apiError(res, 404, 'order_not_found', 'Order not found');
});

app.post('/api/orders', limit, async (req, res) => {
  const { order, problems } = validateOrder(req.body);
  if (problems) return apiError(res, 400, 'invalid_order', problems.join('; '));
  res.status(201).json(await orders.createOrder(demoTenantId(), order, { seller_request: req.body?.seller_request, source: 'dashboard', public_base: trustedBase(req) }));
});

app.post('/api/score', limit, async (req, res) => {
  const { order, problems } = validateOrder(req.body);
  if (problems) return apiError(res, 400, 'invalid_order', problems.join('; '));
  const r = await orders.runPipeline(order, policyFor(demoTenantId()));
  res.json({ score: r.score.score, risk: r.score.level, rule: r.score.rule, reasons: r.score.reasons, breakdown: r.score.breakdown, steps: { pin_check: r.pinCheck, history: r.history, address_check: r.addressCheck } });
});

app.post('/api/orders/:id/action', workflow((req) => orders.applyAction(demoTenantId(), req.params.id, req.body ?? {})));
app.post('/api/orders/:id/reply', workflow((req) => orders.applyReply(demoTenantId(), req.params.id, req.body?.reply, { source: req.body?.reply === 'clear' ? 'dashboard' : 'simulation' })));

// Demo clock: skip ahead to watch the reminder and silence policy fire.
app.post('/api/demo/advance', workflow((req) => orders.timeWarp(demoTenantId(), req.body?.hours ?? 13)));

app.put('/api/policy', async (req, res) => {
  try {
    const id = demoTenantId();
    const patch = validatePolicyPatch(getTenant(id).policy_overrides, req.body ?? {}); // merge, never wipe other overrides
    setTenantPolicy(id, patch);
    await orders.refreshTenantOrders(id, 'brand policy changed');
    res.json(policyFor(id));
  } catch (e) {
    apiError(res, 400, 'invalid_policy', e.message);
  }
});
app.get('/api/policy', (_req, res) => res.json(policyFor(demoTenantId())));

// Seller rule requests: blanket group rules are refused; nothing is ever stored as a rule.
app.get('/api/seller-rules', (_req, res) => res.json(orders.listRefusedRules(demoTenantId())));
app.post('/api/seller-rules', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return apiError(res, 400, 'invalid_rule', 'text is required');
  res.status(422).json(orders.submitSellerRule(demoTenantId(), text));
});

app.post('/api/reset', limit, async (req, res) => {
  await orders.seed(demoTenantId(), { public_base: trustedBase(req) });
  res.json({ ok: true, count: orders.listOrders(demoTenantId()).length });
});

/* ---------- DEMO Shopify-shaped ingestion (simulator, NOT an authenticated Shopify webhook) ---------- */

app.post('/api/webhooks/shopify/orders-create', limit, async (req, res) => {
  res.set('X-WMA-Demo-Simulator', 'true');
  const mapped = mapShopifyOrder(req.body);
  if (mapped.problems) return apiError(res, 400, 'invalid_order', 'The Shopify-shaped payload is invalid.', mapped.problems);
  const shape = (o, replayed) => ({
    simulator: true,
    notice: 'Demo simulator: not an authenticated Shopify webhook. Shared public sandbox, fake data only, no real purchase.',
    replayed,
    order_id: o.id,
    external_id: o.external_id,
    score: o.score,
    risk_band: o.risk_band,
    risk_band_label: o.risk_band_label,
    payment_mode: o.payment_mode,
    order_value_rs: o.amount,
    pay_now_rs: o.pay_now_rs,
    balance_at_delivery_rs: o.balance_at_delivery_rs,
    fee_ladder: o.payment_mode === 'prepaid' ? [] : ladderFor(policyFor(o.tenant_id)),
    buyer_path: o.buyer_path,
    dashboard_path: `/?order=${encodeURIComponent(o.id)}`,
  });
  try {
    const o = await orders.createOrder(demoTenantId(), mapped.order, { external_id: mapped.external_id, source: mapped.source, public_base: trustedBase(req) });
    res.status(201).json(shape(o, false));
  } catch (e) {
    if (e instanceof orders.IdempotentReplay) return res.status(200).json(shape(e.order, true));
    throw e;
  }
});

/* ---------- buyer pages: bearer-token capability, narrow view only ---------- */

function buyerRoute(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const order = orders.findByToken(req.params.token);
    if (!order) return apiError(res, 404, 'not_found', 'This buyer link is not valid.');
    try {
      res.json(await fn(order, req));
    } catch (e) {
      if (e instanceof orders.BuyerError) return apiError(res, e.status, e.code, e.message);
      if (e instanceof orders.WorkflowError) return apiError(res, 400, 'workflow_error', e.message);
      throw e;
    }
  };
}
app.get('/api/buyer/:token', buyerRoute((o) => orders.buyerView(o)));
app.post('/api/buyer/:token/confirm', limit, buyerRoute((o) => orders.buyerConfirm(o)));
app.post('/api/buyer/:token/address', limit, buyerRoute((o, req) => orders.buyerFixAddress(o, req.body?.address)));
app.post('/api/buyer/:token/pay', limit, buyerRoute((o, req) => orders.buyerPay(o, { type: req.body?.type, app: req.body?.app })));

const NOT_FOUND_BUYER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not valid</title><link rel="stylesheet" href="/styles.css"></head>
<body class="buyer-body"><main class="buyer-wrap"><div class="sandbox-banner">DEMO · shared sandbox · fake data only</div><h1>This buyer link is not valid</h1><p class="hint">Check the link in your message, or contact the store.</p></main></body></html>`;
app.get('/buyer/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!orders.findByToken(req.params.token)) return res.status(404).type('html').send(NOT_FOUND_BUYER);
  res.sendFile(path.join(PUBLIC_DIR, 'buyer.html'));
});
app.get('/store', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'storefront.html')));

/* ---------- platform API + admin console ---------- */

// OpenAPI spec (public, before the authenticated /v1 router).
app.get('/v1/openapi.json', (_req, res) => {
  res.type('application/json').send(fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'openapi.json'), 'utf8'));
});

app.use('/v1', v1);
app.use('/admin/api', admin);

// Swagger UI (assets from CDN; the spec itself is local).
app.get('/docs', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Wapas Mat Aana API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>{SwaggerUIBundle({url:'/v1/openapi.json',dom_id:'#ui'});};</script></body></html>`);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({
    error: { code: err.type === 'entity.parse.failed' ? 'invalid_json' : 'internal_error', message: err.type === 'entity.parse.failed' ? 'Invalid JSON' : 'Internal error' },
  });
});

/* ---------- startup ---------- */

export async function boot({ seedIfEmpty = true } = {}) {
  const { tenant } = ensureDemoTenant();
  if (seedIfEmpty && orders.listOrders(tenant.id).length === 0) await orders.seed(tenant.id);
  return tenant;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await boot();
  const port = Number(process.env.PORT) || 3000;
  const sweep = setInterval(() => orders.sweepSilence().catch((e) => console.warn('[sweep]', e.message)), 60_000);
  sweep.unref();
  // Persist, then exit (Render sends SIGTERM on deploy/restart).
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });
  app.listen(port, () => {
    console.log(`Wapas Mat Aana v2.1 at http://localhost:${port}  (API docs: http://localhost:${port}/docs, test store: /store)`);
    console.log(llmEnabled() ? `Address check: LLM (${MODEL})` : 'Address check: DEMO MODE (rule-based; set ANTHROPIC_API_KEY to enable the LLM)');
    console.log(`Store: ${STORE_LOCATION} · buyer links use ${trustedBase()}`);
  });
}
