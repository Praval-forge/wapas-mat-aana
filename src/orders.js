// The order pipeline + ship/hold workflow. In-memory store (resets on restart - it is a prototype).
import { SEED_ORDERS, RETURN_COST_RS } from './data.js';
import { checkPin, checkHistory, scoreOrder } from './checks.js';
import { checkAddress } from './addressLLM.js';
import { buildWhatsAppMessage } from './whatsapp.js';
import { evaluateSellerRule } from './policy.js';

const orders = new Map();
const refusedRules = [];
let counter = 1000;

const now = () => new Date().toISOString();
const log = (order, type, text) => order.events.push({ ts: now(), type, text });

/**
 * Run the full pipeline for one order (no persistence). Exactly one LLM call happens here,
 * inside checkAddress(); every other step is plain code.
 */
export async function runPipeline(input) {
  const pinCheck = checkPin(input.pin); // 1. plain code
  const history = checkHistory(input.phone); // 2. plain code
  const addressCheck = await checkAddress(input.address); // 3. the ONE LLM call (or rule-based fallback)
  const score = scoreOrder({ pinCheck, history, addressCheck }); // 4. plain code
  return { pinCheck, history, addressCheck, score };
}

// 6. Ship or hold. Note: nothing here ever cancels - only a seller action can.
function initialStatus(level) {
  if (level === 'LOW') return 'SHIPPED';
  if (level === 'MEDIUM') return 'AWAITING_CONFIRMATION';
  return 'HOLD'; // HIGH
}

export async function createOrder(input, { seller_request } = {}) {
  const id = `CG-${++counter}`;
  const base = {
    id,
    buyer_name: input.buyer_name,
    phone: input.phone,
    pin: input.pin,
    city: input.city || '',
    address: input.address,
    product: input.product,
    amount: input.amount,
    created_at: now(),
    events: [],
    overridden: false,
    buyer_reply: null,
    policy_notice: null,
  };
  const steps = await runPipeline(input);
  const level = steps.score.level;
  const order = {
    ...base,
    steps: {
      pin_check: steps.pinCheck,
      history: steps.history,
      address_check: steps.addressCheck,
      score: steps.score,
    },
    risk: level,
    reasons: steps.score.reasons,
    whatsapp: buildWhatsAppMessage({ ...base }, level, steps.addressCheck),
    status: initialStatus(level),
    exposure_rs: level === 'LOW' ? 0 : RETURN_COST_RS,
  };
  log(order, 'scored', `Scored ${level} (${steps.score.rule}).`);
  if (order.whatsapp) log(order, 'whatsapp', 'WhatsApp confirmation message generated (mock send).');
  if (order.status === 'SHIPPED') log(order, 'ship', 'LOW risk: shipped automatically.');
  else if (order.status === 'HOLD') log(order, 'hold', 'HIGH risk: held for the seller to decide.');
  else log(order, 'await', 'MEDIUM risk: waiting for the buyer to confirm or pay the Rs 50 fee.');

  if (seller_request) {
    const verdict = evaluateSellerRule(seller_request);
    refusedRules.push({ id: refusedRules.length + 1, ts: now(), text: seller_request, ...verdict, order_id: id });
    order.policy_notice = { request: seller_request, ...verdict };
    log(order, 'policy', `Seller request "${seller_request}" was refused. This order was scored on its own signals.`);
  }
  orders.set(id, order);
  return order;
}

export const listOrders = () => [...orders.values()].sort((a, b) => a.id.localeCompare(b.id));
export const getOrder = (id) => orders.get(id) ?? null;
export const listRefusedRules = () => refusedRules.slice().reverse();

export function submitSellerRule(text) {
  const verdict = evaluateSellerRule(text);
  const entry = { id: refusedRules.length + 1, ts: now(), text: String(text).slice(0, 300), ...verdict };
  refusedRules.push(entry);
  return entry;
}

export class WorkflowError extends Error {}

/** Seller actions: ship | hold | override(to: ship|hold|cancel, note required). Always a human decision. */
export function applyAction(id, { action, to, note }) {
  const order = orders.get(id);
  if (!order) throw new WorkflowError('Order not found');
  if (order.status === 'CANCELLED') throw new WorkflowError('Order is cancelled');
  const who = 'seller';
  if (action === 'ship') {
    order.status = 'SHIPPED';
    log(order, 'ship', `Seller shipped the order (risk ${order.risk}).`);
  } else if (action === 'hold') {
    order.status = 'HOLD';
    log(order, 'hold', 'Seller put the order on hold.');
  } else if (action === 'override') {
    const target = { ship: 'SHIPPED', hold: 'HOLD', cancel: 'CANCELLED' }[to];
    if (!target) throw new WorkflowError('override needs to = ship | hold | cancel');
    const reason = String(note ?? '').trim();
    if (!reason) throw new WorkflowError('An override needs a note explaining why');
    order.overridden = true;
    log(order, 'override', `${who} overrode the system (${order.risk} risk, was ${order.status}) -> ${target}. Note: ${reason.slice(0, 200)}`);
    order.status = target;
  } else {
    throw new WorkflowError('action must be ship | hold | override');
  }
  return order;
}

/** Simulated buyer reply to the WhatsApp message: confirm | paid | cancel | no_reply. */
export function applyReply(id, reply) {
  const order = orders.get(id);
  if (!order) throw new WorkflowError('Order not found');
  if (!order.whatsapp) throw new WorkflowError('No WhatsApp message was sent for a LOW-risk order');
  if (order.status === 'SHIPPED' || order.status === 'CANCELLED')
    throw new WorkflowError(`Order is already ${order.status}`);
  if (!['confirm', 'paid', 'cancel', 'no_reply'].includes(reply))
    throw new WorkflowError('reply must be confirm | paid | cancel | no_reply');

  order.buyer_reply = reply;
  const label = { confirm: 'confirmed (YES)', paid: 'paid the Rs 50 commitment fee', cancel: 'replied CANCEL', no_reply: 'did not reply' }[reply];
  log(order, 'reply', `Buyer ${label}.`);

  const positive = reply === 'confirm' || reply === 'paid';
  if (order.risk === 'MEDIUM') {
    if (positive) {
      order.status = 'SHIPPED';
      log(order, 'ship', 'MEDIUM risk + buyer confirmed: shipped.');
    } else {
      order.status = 'HOLD';
      log(order, 'hold', 'No confirmation: moved to HOLD for the seller. The order is NOT cancelled automatically.');
    }
  } else if (order.risk === 'HIGH') {
    order.status = 'HOLD';
    log(
      order,
      'hold',
      positive
        ? 'HIGH risk stays on HOLD even after confirmation - seller reviews and decides.'
        : 'Still on HOLD. The order is NOT cancelled automatically - seller decides.'
    );
  }
  return order;
}

export async function seed() {
  orders.clear();
  refusedRules.length = 0;
  counter = 1000;
  for (const s of SEED_ORDERS) {
    const { seller_request, ...input } = s;
    await createOrder(input, { seller_request });
  }
}
