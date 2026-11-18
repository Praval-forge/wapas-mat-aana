// Runs the 5 seed orders through the pipeline and checks expected outcomes.
// Forced into demo mode so it needs no API key and makes no network calls.
import assert from 'node:assert/strict';
delete process.env.ANTHROPIC_API_KEY;

const orders = await import('../src/orders.js');
const { evaluateSellerRule } = await import('../src/policy.js');
await orders.seed();
const all = orders.listOrders();

const expected = [
  ['CG-1001', 'LOW', 'SHIPPED', 'full address, safe pin, no returns'],
  ['CG-1002', 'HIGH', 'HOLD', 'vague address "Near temple, Hyd"'],
  ['CG-1003', 'HIGH', 'HOLD', '2 past returns'],
  ['CG-1004', 'MEDIUM', 'AWAITING_CONFIRMATION', 'good address, high-return pin'],
  ['CG-1005', 'LOW', 'SHIPPED', 'city-block request refused; scored on own signals'],
];
console.log('\nSeed orders through the scorer:\n');
for (const [id, risk, status, why] of expected) {
  const o = orders.getOrder(id);
  console.log(`${id}  ${o.risk.padEnd(6)} ${o.status.padEnd(22)} addr=${o.steps.address_check.address_quality.padEnd(5)} pin=${o.steps.pin_check.risk.padEnd(7)} returns=${o.steps.history.past_returns}  (${why})`);
  assert.equal(o.risk, risk, `${id} risk`);
  assert.equal(o.status, status, `${id} status`);
}
assert.equal(all.length, 5);

// Seed 5: the blanket city rule is refused and the order is scored on its own signals.
const o5 = orders.getOrder('CG-1005');
assert.equal(o5.policy_notice.accepted, false);
assert.equal(o5.policy_notice.code, 'blanket_group_rule');
for (const t of ['Block all buyers from Jaipur', 'ban every customer in Bhiwandi', 'Reject all orders from this state', 'never ship to any community X'])
  assert.equal(evaluateSellerRule(t).code, 'blanket_group_rule', t);

// Fairness invariant: city/name are not scoring inputs - changing them cannot change the score.
const base = { buyer_name: 'A B', phone: '9000000000', pin: '110096', address: 'H.No 23, Gali No 4, Shahdara Main Road, Delhi 110096', product: 'x', amount: 1200 };
const a = await orders.runPipeline({ ...base, city: 'Jaipur' });
const b = await orders.runPipeline({ ...base, city: 'Mumbai', buyer_name: 'Z Y' });
assert.deepEqual(a.score, b.score);

// Workflow: nothing auto-cancels; only a human can.
const m = orders.getOrder('CG-1004');
orders.applyReply('CG-1004', 'no_reply');
assert.equal(m.status, 'HOLD');                                     // no reply -> HOLD, not cancelled
const h = orders.getOrder('CG-1002');
orders.applyReply('CG-1002', 'cancel');
assert.equal(h.status, 'HOLD');                                     // buyer "cancel" -> HOLD for seller
assert.throws(() => orders.applyAction('CG-1002', { action: 'override', to: 'ship' }), /note/); // override needs a reason
orders.applyAction('CG-1002', { action: 'override', to: 'ship', note: 'Called buyer, address confirmed' });
assert.equal(h.status, 'SHIPPED'); assert.ok(h.overridden);
await orders.seed();
orders.applyReply('CG-1004', 'paid');
assert.equal(orders.getOrder('CG-1004').status, 'SHIPPED');         // MEDIUM + paid -> ships
orders.applyReply('CG-1003', 'confirm');
assert.equal(orders.getOrder('CG-1003').status, 'HOLD');            // HIGH never auto-ships
assert.throws(() => orders.applyReply('CG-1001', 'confirm'));       // LOW has no WhatsApp message
console.log('\nAll seed-order and invariant checks passed.\n');
