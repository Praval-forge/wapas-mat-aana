import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Load .env if present (Node >= 20.12). Real environment variables win.
try { process.loadEnvFile(path.join(import.meta.dirname, '..', '.env')); } catch { /* no .env - fine */ }

const { llmEnabled, MODEL } = await import('./addressLLM.js');
const orders = await import('./orders.js');
const { PIN_TABLE, RETURN_COST_RS, COMMITMENT_FEE_RS } = await import('./data.js');
const { validateOrder } = await import('./validate.js');
const { v1 } = await import('./routes/v1.js');
const { admin } = await import('./routes/admin.js');
const { ensureDemoTenant, DEMO_API_KEY } = await import('./demoTenant.js');
const { validatePolicyPatch } = await import('./policyConfig.js');
const { policyFor, setTenantPolicy } = await import('./tenants.js');
const { saveNow, STORE_LOCATION } = await import('./store.js');
const { settingsFor, updateSettings } = await import('./settings.js');
const { apiError } = await import('./auth.js');

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// Security headers + per-request id and a one-line access log on the APIs.
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
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));

const demoTenantId = () => ensureDemoTenant().tenant.id;

// Tiny in-memory rate limit for endpoints that can trigger the (paid) LLM call.
const hits = new Map();
function limit(req, res, next) {
  const key = req.ip;
  const t = Date.now();
  const recent = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
  if (recent.length >= 30) return apiError(res, 429, 'rate_limited', 'Too many requests, slow down.');
  recent.push(t);
  hits.set(key, recent);
  next();
}

/* ---------- demo dashboard API (no key; operates on the built-in demo tenant) ---------- */

app.get('/api/meta', (_req, res) => {
  const { tenant } = ensureDemoTenant();
  res.json({
    version: '2.0',
    mode: llmEnabled() ? 'llm' : 'demo',
    model: llmEnabled() ? MODEL : null,
    return_cost_rs: RETURN_COST_RS,
    commitment_fee_rs: COMMITMENT_FEE_RS,
    known_pins: Object.keys(PIN_TABLE),
    demo_tenant_id: tenant.id,
    demo_api_key: DEMO_API_KEY, // sandbox test key, published on purpose
    policy: policyFor(tenant.id),
    store: STORE_LOCATION === ':memory:' ? 'in-memory' : 'file',
  });
});

app.get('/api/settings', (_req,res) => res.json(settingsFor(demoTenantId())));
app.put('/api/settings', (req,res) => { try { res.json(updateSettings(demoTenantId(),req.body ?? {})); } catch(e) { apiError(res,400,'invalid_settings',e.message); } });
app.post('/api/demo/bulk', limit, async (req,res) => { try { res.json(await orders.bulkAction(demoTenantId(),req.body?.action)); } catch(e) { apiError(res,400,'invalid_action',e.message); } });
app.post('/api/import', limit, async (req,res) => {
  const rows = req.body?.orders;
  if (!Array.isArray(rows) || rows.length > 100) return apiError(res,400,'invalid_import','orders must be an array with at most 100 rows');
  const results=[];
  for (const [i,row] of rows.entries()) {
    const {order,problems}=validateOrder(row);
    if(problems) {results.push({row:i+1,errors:problems});continue;}
    try { const o=await orders.createOrder(demoTenantId(),order,{external_id:row.order_id});results.push({row:i+1,id:o.id}); }
    catch(e) { results.push(e instanceof orders.IdempotentReplay ? {row:i+1,id:e.order.id,replayed:true} : {row:i+1,errors:[e.message]}); }
  }
  res.json({results});
});
app.get('/api/orders', (_req, res) => res.json(orders.listOrders(demoTenantId())));
app.get('/api/orders/:id', (req, res) => {
  const o = orders.getOrder(demoTenantId(), req.params.id);
  return o ? res.json(o) : apiError(res, 404, 'order_not_found', 'Order not found');
});

app.post('/api/orders', limit, async (req, res) => {
  const { order, problems } = validateOrder(req.body);
  if (problems) return apiError(res, 400, 'invalid_order', problems.join('; '));
  res.status(201).json(await orders.createOrder(demoTenantId(), order, { seller_request: req.body?.seller_request }));
});

app.post('/api/score', limit, async (req, res) => {
  const { order, problems } = validateOrder(req.body);
  if (problems) return apiError(res, 400, 'invalid_order', problems.join('; '));
  const r = await orders.runPipeline(order, policyFor(demoTenantId()));
  res.json({
    score: r.score.score,
    risk: r.score.level,
    rule: r.score.rule,
    reasons: r.score.reasons,
    breakdown: r.score.breakdown,
    steps: { pin_check: r.pinCheck, history: r.history, address_check: r.addressCheck },
  });
});

function workflow(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof orders.WorkflowError) return apiError(res, 400, 'workflow_error', e.message);
      throw e;
    }
  };
}
app.post('/api/orders/:id/action', workflow((req) => orders.applyAction(demoTenantId(), req.params.id, req.body ?? {})));
app.post('/api/orders/:id/reply', workflow((req) => orders.applyReply(demoTenantId(), req.params.id, req.body?.reply)));

// Demo clock: skip ahead to watch the reminder and silence policy fire.
app.post('/api/demo/advance', workflow((req) => orders.timeWarp(demoTenantId(), req.body?.hours ?? 13)));

app.put('/api/policy',(req,res)=>{try{const id=demoTenantId();const patch=validatePolicyPatch({},req.body??{});setTenantPolicy(id,patch);res.json(policyFor(id));}catch(e){apiError(res,400,'invalid_policy',e.message);}});
app.get('/api/policy', (_req, res) => res.json(policyFor(demoTenantId())));

// Seller rule requests: blanket group rules are refused; nothing is ever stored as a rule.
app.get('/api/seller-rules', (_req, res) => res.json(orders.listRefusedRules(demoTenantId())));
app.post('/api/seller-rules', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return apiError(res, 400, 'invalid_rule', 'text is required');
  res.status(422).json(orders.submitSellerRule(demoTenantId(), text));
});

app.post('/api/reset', limit, async (_req, res) => {
  await orders.seed(demoTenantId());
  res.json({ ok: true, count: orders.listOrders(demoTenantId()).length });
});

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
  process.on('SIGTERM', () => saveNow());
  process.on('SIGINT', () => { saveNow(); process.exit(0); });
  app.listen(port, () => {
    console.log(`Wapas Mat Aana v2 at http://localhost:${port}  (API docs: http://localhost:${port}/docs)`);
    console.log(llmEnabled() ? `Address check: LLM (${MODEL})` : 'Address check: DEMO MODE (rule-based; set ANTHROPIC_API_KEY to enable the LLM)');
    console.log(`Store: ${STORE_LOCATION}`);
  });
}
