import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load .env if present (Node >= 20.12). Real environment variables win.
try { process.loadEnvFile(path.join(import.meta.dirname, '..', '.env')); } catch { /* no .env - fine */ }

const { llmEnabled, MODEL } = await import('./addressLLM.js');
const orders = await import('./orders.js');
const { PIN_TABLE, RETURN_COST_RS, COMMITMENT_FEE_RS } = await import('./data.js');

export const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));

// Tiny in-memory rate limit for endpoints that can trigger the (paid) LLM call.
const hits = new Map();
function limit(req, res, next) {
  const key = req.ip;
  const t = Date.now();
  const recent = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
  if (recent.length >= 30) return res.status(429).json({ error: 'Too many requests, slow down.' });
  recent.push(t);
  hits.set(key, recent);
  next();
}

function validateOrder(b) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const o = {
    buyer_name: str(b.buyer_name, 80),
    phone: str(b.phone, 15).replace(/\D/g, ''),
    pin: str(b.pin, 6),
    city: str(b.city, 60),
    address: str(b.address, 500),
    product: str(b.product, 100) || 'Demo product',
    amount: Number(b.amount) || 1200,
  };
  if (!o.buyer_name) return { error: 'buyer_name is required' };
  if (!/^[1-9]\d{5}$/.test(o.pin)) return { error: 'pin must be a 6-digit Indian pin code' };
  if (!o.address) return { error: 'address is required' };
  if (!(o.amount > 0 && o.amount < 1_000_000)) return { error: 'amount must be a positive number' };
  return { order: o };
}

app.get('/api/meta', (_req, res) =>
  res.json({
    mode: llmEnabled() ? 'llm' : 'demo',
    model: llmEnabled() ? MODEL : null,
    return_cost_rs: RETURN_COST_RS,
    commitment_fee_rs: COMMITMENT_FEE_RS,
    known_pins: Object.keys(PIN_TABLE),
  })
);

app.get('/api/orders', (_req, res) => res.json(orders.listOrders()));
app.get('/api/orders/:id', (req, res) => {
  const o = orders.getOrder(req.params.id);
  return o ? res.json(o) : res.status(404).json({ error: 'Order not found' });
});

// Create + score + route a new (simulated) COD order.
app.post('/api/orders', limit, async (req, res) => {
  const { order, error } = validateOrder(req.body ?? {});
  if (error) return res.status(400).json({ error });
  res.status(201).json(await orders.createOrder(order));
});

// Stateless scoring preview - runs the pipeline without saving anything.
app.post('/api/score', limit, async (req, res) => {
  const { order, error } = validateOrder(req.body ?? {});
  if (error) return res.status(400).json({ error });
  const r = await orders.runPipeline(order);
  res.json({ risk: r.score.level, rule: r.score.rule, reasons: r.score.reasons, steps: { pin_check: r.pinCheck, history: r.history, address_check: r.addressCheck } });
});

function workflow(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      if (e instanceof orders.WorkflowError) return res.status(400).json({ error: e.message });
      throw e;
    }
  };
}
app.post('/api/orders/:id/action', workflow((req) => orders.applyAction(req.params.id, req.body ?? {})));
app.post('/api/orders/:id/reply', workflow((req) => orders.applyReply(req.params.id, req.body?.reply)));

// Seller rule requests: blanket group rules are refused; nothing is ever stored as a rule.
app.get('/api/seller-rules', (_req, res) => res.json(orders.listRefusedRules()));
app.post('/api/seller-rules', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  res.status(422).json(orders.submitSellerRule(text));
});

app.post('/api/reset', limit, async (_req, res) => {
  await orders.seed();
  res.json({ ok: true, count: orders.listOrders().length });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : 'Internal error' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await orders.seed();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`COD Return Guard running at http://localhost:${port}`);
    console.log(llmEnabled() ? `Address check: LLM (${MODEL})` : 'Address check: DEMO MODE (rule-based; set ANTHROPIC_API_KEY to enable the LLM)');
  });
}
