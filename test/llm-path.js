// Verifies the LLM path WITHOUT a real key: points the SDK at a local fake /v1/messages server.
// Checks: model, forced strict tool, address-only input, exactly one call per order, and fallbacks.
import assert from 'node:assert/strict';
import http from 'node:http';

const calls = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers['x-api-key'] ?? req.headers['authorization'], headers: req.headers, body: JSON.parse(body) });
    if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"api_error","message":"boom"}}'); }
    const input = mode === 'garbage' ? { address_quality: 'excellent', reason: 1 } : { address_quality: 'vague', reason: 'Only a landmark is given.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_address_quality', input }], usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});
await new Promise((r) => server.listen(0, r));
process.env.CODGUARD_DATA_FILE = ':memory:';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const { checkAddress, MODEL } = await import('../src/addressLLM.js');
const orders = await import('../src/orders.js');

const r = await checkAddress('Near temple, Hyd');
assert.deepEqual(r, { address_quality: 'vague', reason: 'Only a landmark is given.', source: 'llm' });
const b = calls[0].body;
assert.equal(calls[0].url, '/v1/messages');
assert.equal(b.model, 'claude-haiku-4-5'); assert.equal(MODEL, 'claude-haiku-4-5');
assert.deepEqual(b.tool_choice, { type: 'tool', name: 'record_address_quality' });
assert.equal(b.tools[0].strict, true);
assert.deepEqual(b.tools[0].input_schema.properties.address_quality.enum, ['clear', 'vague', 'bad']);
assert.ok(b.messages[0].content.includes('Near temple, Hyd'));
assert.ok(!JSON.stringify(b).includes('Sneha') && !JSON.stringify(b).includes('9810000002'), 'only the address may be sent');
assert.equal(calls[0].auth, 'Bearer test-key-not-real'); // key comes from env, not code

// Exactly ONE LLM call per order through the whole pipeline.
calls.length = 0;
const { createTenant } = await import('../src/tenants.js');
const T = createTenant({ name: 'llm test' }).id;
await orders.createOrder(T, { buyer_name: 'Sneha Reddy', phone: '9810000002', pin: '500081', city: 'Hyderabad', address: 'Near temple, Hyd', product: 'x', amount: 1200 });
assert.equal(calls.length, 1, 'exactly one LLM call per order');

// Failure and malformed output both fall back to rules, and the app keeps working.
mode = 'garbage'; const g = await checkAddress('Flat 402, Sunrise Apartments, 5th Cross, Koramangala, Bengaluru'); assert.equal(g.source, 'rules'); assert.equal(g.address_quality, 'clear');
mode = 'error'; const e = await checkAddress('Near temple, Hyd'); assert.equal(e.source, 'rules'); assert.equal(e.address_quality, 'vague');
server.close();
console.log('LLM path checks passed (model, strict forced tool, address-only input, 1 call/order, fallbacks).');
process.exit(0);

