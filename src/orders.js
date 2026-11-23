// The order pipeline + the ship / hold / cancel workflow (v2).
//
// Every COD order is scored on ALL signals (0-100, pin code is one input).
//   LOW    (0-lowMax):     ships as normal, no buyer message.
//   MEDIUM (..mediumMax):  WhatsApp "Reply YES to confirm". One reminder after
//                          reminderAfterHours; still silent at
//                          mediumSilentAfterHours -> HOLD, the brand decides.
//   HIGH   (..100):        WhatsApp "Pay the Rs 50 fee to confirm". One
//                          reminder; still silent at highSilentAfterHours ->
//                          highSilentAction ('cancel' by default, or 'hold';
//                          the brand chooses in its policy).
// An explicit buyer CANCEL is honoured (cancelled at the buyer's request).
// Seller can Ship / Hold / Override (override needs a written note, audit log).
//
// State is persisted through store.js and every order belongs to one tenant.
import { SEED_ORDERS, RETURN_COST_RS, COMMITMENT_FEE_RS } from './data.js';
import { checkPin, checkHistory, scoreOrder } from './checks.js';
import { checkAddress } from './addressLLM.js';
import { buildWhatsAppMessage, buildReminderMessage } from './whatsapp.js';
import { evaluateSellerRule } from './policy.js';
import { getState, save } from './store.js';
import { getTenant, policyFor } from './tenants.js';
import { settingsFor } from './settings.js';
import { feeFor, bandFor } from './policyConfig.js';
import { dispatch } from './webhooks.js';

const now = () => new Date().toISOString();
const HOUR_MS = 3_600_000;

const log = (order, type, text) => order.events.push({ ts: now(), type, text });

const ordersOf = (tenantId) => getState().orders.filter((o) => o.tenant_id === tenantId).map(o=>{Object.defineProperty(o,'suggested_action',{enumerable:true,configurable:true,get(){return suggestion(this);}});return o;});

/**
 * Run the full pipeline for one order (no persistence). Exactly one LLM call
 * happens here, inside checkAddress(); every other step is plain code.
 */
export async function runPipeline(input, policy) {
  if (input.payment_mode === 'prepaid') return { pinCheck: { risk: 'not_scored', note: 'Prepaid order: COD risk does not apply.' }, history: checkHistory(input.phone, input), addressCheck: { address_quality: 'clear', source: 'skipped', reason: 'Prepaid: no address-check call.' }, score: { score: 0, level: 'LOW', rule: 'PREPAID', reasons: ['Prepaid order: no COD collection risk.'], breakdown: [] } };
  const pinCheck = checkPin(input.pin); // 1. plain code
  const history = checkHistory(input.phone, input); // 2. plain code
  const addressCheck = await checkAddress(input.address); // 3. the ONE LLM call (or rule-based fallback)
  const score = scoreOrder({ pinCheck, history, addressCheck, address: input.address, phone: input.phone, buyerName: input.buyer_name, amount: input.amount, ordersSamePhoneToday: input.orders_same_phone_today ?? 1 }, policy); // 4. plain code
  return { pinCheck, history, addressCheck, score };
}

// 6. Route by tier. LOW ships; MEDIUM/HIGH wait for the buyer.
function initialStatus(level) {
  return 'PENDING_REVIEW';
}

export class IdempotentReplay extends Error {
  constructor(order) {
    super('replay');
    this.order = order;
  }
}

export async function createOrder(tenantId, input, { seller_request, external_id, idempotency_key } = {}) {
  const s = getState();
  const tenant = getTenant(tenantId);
  if (!tenant) throw new WorkflowError('Tenant not found');
  // Idempotency: a retried ingest (same external_id or Idempotency-Key for this
  // tenant) returns the original order instead of double-scoring it.
  if (external_id) {
    const dup = getOrderByExternalId(tenantId, external_id);
    if (dup) throw new IdempotentReplay(dup);
  }
  if (idempotency_key) {
    const dup = ordersOf(tenantId).find((o) => o.idempotency_key === String(idempotency_key));
    if (dup) throw new IdempotentReplay(dup);
  }
  const policy = policyFor(tenantId);
  tenant.order_counter = (tenant.order_counter ?? 1000) + 1;
  const id = `CG-${tenant.order_counter}`;
  const base = {
    id,
    tenant_id: tenantId,
    external_id: external_id ? String(external_id).slice(0, 80) : null,
    idempotency_key: idempotency_key ? String(idempotency_key).slice(0, 120) : null,
    buyer_name: input.buyer_name,
    phone: input.phone,
    pin: input.pin,
    city: input.city || '',
    address: input.address,
    product: input.product,
    amount: input.amount,
    payment_mode: input.payment_mode ?? 'cod',
    orders_same_phone_today: input.orders_same_phone_today ?? ordersOf(tenantId).filter(o => o.phone === input.phone && o.created_at.slice(0,10) === now().slice(0,10)).length + 1,
    created_at: now(),
    events: [],
    decision: null,
    overridden: false,
    buyer_reply: null,
    policy_notice: null,
    whatsapp_sent_at: null,
    reminder_sent_at: null,
  };
  const steps = await runPipeline({ ...input, orders_same_phone_today: base.orders_same_phone_today }, policy);
  const level = steps.score.level;
  const order = {
    ...base,
    steps: {
      pin_check: steps.pinCheck,
      history: steps.history,
      address_check: steps.addressCheck,
      score: steps.score,
    },
    score: steps.score.score,
    risk: level,
    risk_band: bandFor(steps.score.score,policy),
    commitment_fee_rs: feeFor(steps.score.score,policy),
    reasons: steps.score.reasons,
    whatsapp: buildWhatsAppMessage({ ...base, commitment_fee_rs: feeFor(steps.score.score,policy) }, level, steps.addressCheck, settingsFor(tenantId).brand_name),
    status: initialStatus(level),
    exposure_rs: level === 'LOW' ? 0 : RETURN_COST_RS,
  };
  if (order.whatsapp) order.whatsapp_sent_at = now();
  log(order, 'scored', `Scored ${order.score}/100 -> ${level}.`);
  if (order.whatsapp)
    log(
      order,
      'whatsapp',
      level === 'MEDIUM'
        ? 'WhatsApp confirmation request generated: "Reply YES to confirm" (mock send).'
        : `WhatsApp confirmation request generated: "Pay the Rs ${order.commitment_fee_rs ?? COMMITMENT_FEE_RS} fee to confirm" (mock send).`
    );
  if (order.status === 'SHIPPED') log(order, 'ship', 'LOW risk: suggests ship, awaiting a human decision.');
  else log(order, 'await', `${level} risk: waiting for the buyer to ${level === 'MEDIUM' ? 'confirm' : 'pay the fee'}.`);

  if (seller_request) {
    const verdict = evaluateSellerRule(seller_request);
    s.refusedRules.push({ id: s.refusedRules.length + 1, ts: now(), text: seller_request, ...verdict, order_id: id, tenant_id: tenantId });
    order.policy_notice = { request: seller_request, ...verdict };
    log(order, 'policy', `Seller request "${seller_request}" was refused. This order was scored on its own signals.`);
  }
  Object.defineProperty(order,'suggested_action',{enumerable:true,configurable:true,get(){return suggestion(this);}});
  s.orders.push(order);
  save();
  await dispatch(tenantId, 'order.scored', order);
  return order;
}

export const listOrders = (tenantId) => ordersOf(tenantId).sort((a, b) => a.id.localeCompare(b.id));
export const getOrder = (tenantId, id) => ordersOf(tenantId).find((o) => o.id === id) ?? null;
export const getOrderByExternalId = (tenantId, externalId) =>
  ordersOf(tenantId).find((o) => o.external_id === externalId) ?? null;
export const listRefusedRules = (tenantId) =>
  getState()
    .refusedRules.filter((r) => r.tenant_id === tenantId)
    .slice()
    .reverse();

export function submitSellerRule(tenantId, text) {
  const s = getState();
  const verdict = evaluateSellerRule(text);
  const entry = { id: s.refusedRules.length + 1, ts: now(), text: String(text).slice(0, 300), ...verdict, tenant_id: tenantId };
  s.refusedRules.push(entry);
  save();
  return entry;
}

export class WorkflowError extends Error {}

async function transition(order, status, type, text, event = 'order.status_changed') {
  order.status = status;
  log(order, type, text);
  save();
  await dispatch(order.tenant_id, event, order);
}

/** Seller actions: ship | hold | override(to: ship|hold|cancel, note required). Always a human decision. */
export async function applyAction(tenantId, id, { action, to, note }) {
  const order = getOrder(tenantId, id);
  if (!order) throw new WorkflowError('Order not found');
  if (['ship','hold','cancel'].includes(action)) {
    const target={ship:'SHIPPED',hold:'HOLD',cancel:'CANCELLED'}[action];
    order.decision=action;order.decision_by='human';order.decided_at=now();
    await transition(order,target,action,`Human seller chose ${action}. Note: ${String(note ?? '').slice(0,200)}`);
  } else if (action === 'override') {
    const target = { ship: 'SHIPPED', hold: 'HOLD', cancel: 'CANCELLED' }[to];
    if (!target) throw new WorkflowError('override needs to = ship | hold | cancel');
    const reason = String(note ?? '').trim();
    if (!reason) throw new WorkflowError('An override needs a note explaining why');
    order.decision=to;order.decision_by='human';order.decided_at=now();order.overridden = true;
    log(order, 'override', `Seller overrode the system (score ${order.score} ${order.risk}, was ${order.status}) -> ${target}. Note: ${reason.slice(0, 200)}`);
    order.status = target;
    save();
    await dispatch(tenantId, 'order.overridden', order, { note: reason.slice(0, 200) });
  } else {
    throw new WorkflowError('action must be ship | hold | cancel | override');
  }
  return order;
}

/** Buyer reply to the WhatsApp message: confirm | paid | cancel | no_reply. */
export async function applyReply(tenantId, id, reply) {
  const order = getOrder(tenantId, id);
  if (!order) throw new WorkflowError('Order not found');
  if (!order.whatsapp) throw new WorkflowError('No confirmation required for this order');
  if (!['confirm','paid','cancel','no_reply','wrong_address'].includes(reply)) throw new WorkflowError('Invalid buyer reply');
  order.buyer_reply=reply;
  log(order,'reply',`Buyer reply recorded: ${reply}. A human must decide the order.`);
  save();await dispatch(tenantId,'order.reply_received',order);
  return order;
}

/**
 * The silence sweep: send the one reminder, then apply the silence outcome.
 * Runs on a timer in the server and after the demo time-warp; exported for tests.
 */
export async function sweepSilence() {
  const s = getState();
  const nowMs = Date.now();
  for (const order of s.orders) {
    if (order.decision || !order.whatsapp_sent_at) continue;
    const policy=policyFor(order.tenant_id);
    const elapsedH=(nowMs-Date.parse(order.whatsapp_sent_at))/HOUR_MS;
    if (!order.reminder_sent_at && elapsedH>=policy.reminderAfterHours) {
      order.reminder_sent_at=now();order.reminder=buildReminderMessage(order,order.risk);
      log(order,'reminder','One reminder generated (mock only). Human decision still required.');
      save();await dispatch(order.tenant_id,'order.reminded',order);
    }
    if (policy.autoCancelSilent && policy.highSilentAction==='cancel' && order.commitment_fee_rs>0 && !order.buyer_reply && elapsedH>=24) {
      order.decision='cancel';order.decision_by='system';order.decided_at=now();
      await transition(order,'CANCELLED','auto_cancel','System cancelled: 24 hours of buyer silence after an upfront request (brand toggle ON).','order.auto_cancelled');
      continue;
    }
    if (!order.silence_flagged_at && !order.buyer_reply && elapsedH>=policy.highSilentAfterHours) {
      order.silence_flagged_at=now();log(order,'silence','Buyer silence flagged for human review. No order status changed.');
      save();await dispatch(order.tenant_id,'order.review_required',order);
    }
  }
}

/** Demo helper: backdate the clock on all awaiting orders of a tenant, then sweep. */
export async function timeWarp(tenantId, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 720) throw new WorkflowError('hours must be between 0 and 720');
  const shift = h * HOUR_MS;
  for (const order of ordersOf(tenantId)) {
    if (order.decision || !order.whatsapp_sent_at) continue;
    order.whatsapp_sent_at = new Date(Date.parse(order.whatsapp_sent_at) - shift).toISOString();
    if (order.reminder_sent_at)
      order.reminder_sent_at = new Date(Date.parse(order.reminder_sent_at) - shift).toISOString();
  }
  save();
  await sweepSilence();
  return listOrders(tenantId);
}

/** (Re)seed a tenant with the five demo orders. Only that tenant's data resets. */
export async function seed(tenantId) {
  const s = getState();
  const tenant = getTenant(tenantId);
  if (!tenant) throw new WorkflowError('Tenant not found');
  s.orders = s.orders.filter((o) => o.tenant_id !== tenantId);
  s.refusedRules = s.refusedRules.filter((r) => r.tenant_id !== tenantId);
  tenant.order_counter = 1000; // stable demo ids: CG-1001 .. CG-1005
  save();
  for (const seedOrder of SEED_ORDERS) {
    const { seller_request, ...input } = seedOrder;
    await createOrder(tenantId, input, { seller_request });
  }
}

/** Explainable suggestion. Explicit bulk acceptance is required. */
export function suggestion(o) {
  if (o.buyer_reply==='cancel') return 'cancel';
  if (o.buyer_reply==='wrong_address') return 'hold';
  if (o.buyer_reply==='no_reply'||o.silence_flagged_at) return o.risk_band==='EXTREME' ? 'cancel':'hold';
  if (o.risk==='LOW'||o.buyer_reply==='paid'||o.buyer_reply==='confirm'&&o.risk==='MEDIUM') return 'ship';
  return 'wait';
}
export async function bulkAction(tenantId, action) {
  if (!['ship_safe','simulate_replies','accept_suggestions'].includes(action)) throw new WorkflowError('Unknown bulk action');
  let changed = 0;
  for (const o of ordersOf(tenantId)) {
    if (o.decision) continue;
    if (action === 'ship_safe' && o.risk === 'LOW') { await applyAction(tenantId,o.id,{action:'ship'}); changed++; }
    if (action === 'simulate_replies' && o.risk !== 'LOW') {
      await applyReply(tenantId,o.id,o.risk === 'MEDIUM' ? 'confirm' : 'paid'); changed++;
    }
    if (action === 'accept_suggestions' && suggestion(o)!=='wait') { await applyAction(tenantId,o.id,{action:'override',to:suggestion(o),note:'Seller accepted the tool suggestion using bulk action.'}); changed++; }
  }
  return {changed, orders:listOrders(tenantId)};
}
