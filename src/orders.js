// The order pipeline and the human-final review workflow (v2.1).
//
// Every COD order is scored on all signals (0-100; the pin code is one input)
// and placed on the five-band ladder from the brand's policy:
//   LOW 0-29 (no message) | MEDIUM 30-49 (free YES confirmation) |
//   HIGH 50-69 / VERY_HIGH 70-84 / EXTREME 85-100 (refundable upfront amount,
//   adjusted against the amount due on delivery, never above the order value).
// Every order starts PENDING_REVIEW and waits for a human Ship / Hold / Cancel.
// Buyer replies (confirm, address fixed, simulated payment, ...) are evidence
// only and never ship, hold or cancel an order. The ONE automatic action is the
// per-brand, default-ON cancel of upfront-request orders after 24h of buyer
// silence; any human action or real buyer reply preempts it.
//
// State is persisted through store.js and every order belongs to one tenant.
import crypto from 'node:crypto';
import { SEED_ORDERS, RETURN_COST_RS } from './data.js';
import { checkPin, checkHistory, scoreOrder, ruleBasedAddressCheck } from './checks.js';
import { checkAddress } from './addressLLM.js';
import { buildWhatsAppMessage, buildReminderMessage } from './whatsapp.js';
import { evaluateSellerRule } from './policy.js';
import { getState, save } from './store.js';
import { getTenant, policyFor } from './tenants.js';
import { settingsFor } from './settings.js';
import { feeForOrder, bandFor, ladderFor, FULL_ONLINE_DISCOUNT_PCT, BAND_LABELS } from './policyConfig.js';
import { dispatch } from './webhooks.js';
import { validateOrder } from './validate.js';
import { trustedBase } from './publicBase.js';

const now = () => new Date().toISOString();
const HOUR_MS = 3_600_000;
const IST_OFFSET_MS = 330 * 60_000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const MAX_ADDRESS_CORRECTIONS = 3;

/** Calendar day (YYYY-MM-DD) in India Standard Time for a timestamp. */
export const istDay = (ts = Date.now()) => new Date((typeof ts === 'string' ? Date.parse(ts) : ts) + IST_OFFSET_MS).toISOString().slice(0, 10);

export const BUYER_REPLIES = ['confirm', 'paid', 'cancel', 'no_reply', 'wrong_address', 'address_fixed'];
export const UPI_APPS = { gpay: 'Google Pay (simulated)', phonepe: 'PhonePe (simulated)', paytm: 'Paytm (simulated)', bhim: 'BHIM UPI (simulated)', other_upi: 'Other UPI app (simulated)' };
export const SOURCE_LABELS = {
  seed: 'Demo seed data',
  dashboard: 'Dashboard (manual entry)',
  api: 'Platform API (/v1)',
  csv: 'CSV import',
  storefront: 'Test storefront (Shopify-shaped demo payload)',
  shopify_demo: 'Shopify webhook simulator (demo, unauthenticated)',
};

const newBuyerToken = () => crypto.randomBytes(24).toString('base64url'); // 192 bits
const log = (order, type, text, by = 'system', extra = {}) => order.events.push({ ts: now(), type, by, text, ...extra });

export class WorkflowError extends Error {
  constructor(message, details) {
    super(message);
    if (details) this.details = details;
  }
}
/** Errors on the public buyer page: carries an HTTP status and code. */
export class BuyerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export class IdempotentReplay extends Error {
  constructor(order) {
    super('replay');
    this.order = order;
  }
}

/* ---------------- helpers ---------------- */

function setBuyerLink(o, base) {
  o.public_base = String(base ?? o.public_base ?? trustedBase()).replace(/\/+$/, '');
  o.buyer_path = `/buyer/${o.buyer_token}`;
  o.buyer_url = `${o.public_base}${o.buyer_path}`;
}

/** Attach computed fields and migrate orders persisted by older versions. */
function decorate(o) {
  if (!o.buyer_token) {
    o.buyer_token = newBuyerToken();
    setBuyerLink(o);
    o.payment ??= null;
    save();
  }
  Object.defineProperty(o, 'suggested_action', { enumerable: true, configurable: true, get() { return suggestion(this); } });
  return o;
}

const ordersOf = (tenantId) => getState().orders.filter((o) => o.tenant_id === tenantId).map(decorate);

/** What the buyer pays now and what remains at the door. */
function amounts(order) {
  if (order.payment_mode === 'prepaid') return { pay_now_rs: 0, balance_at_delivery_rs: 0 };
  if (order.payment) return { pay_now_rs: order.payment.amount_rs, balance_at_delivery_rs: order.payment.balance_due_rs };
  const fee = order.commitment_fee_rs ?? 0;
  return { pay_now_rs: fee, balance_at_delivery_rs: round2(order.amount - fee) };
}

function renderMessages(order, settings) {
  const level = order.payment_mode === 'prepaid' ? 'LOW' : order.risk;
  order.whatsapp = buildWhatsAppMessage(order, level, order.steps?.address_check, settings.brand_name);
  if (order.reminder_sent_at) order.reminder = buildReminderMessage(order, level, settings.brand_name);
}

/** Apply a score to an order: band, fee (frozen once paid), amounts, messages, request clocks. */
function applyDerived(order, score, policy, settings) {
  const before = { score: order.score, band: order.risk_band, fee: order.commitment_fee_rs };
  const prepaid = order.payment_mode === 'prepaid';
  order.steps.score = score;
  order.score = score.score;
  order.risk = score.level;
  order.risk_band = prepaid ? 'LOW' : bandFor(score.score, policy);
  order.risk_band_label = BAND_LABELS[order.risk_band];
  if (!order.payment) order.commitment_fee_rs = prepaid ? 0 : feeForOrder(score.score, policy, order.amount);
  order.reasons = score.reasons;
  order.exposure_rs = order.risk === 'LOW' ? 0 : RETURN_COST_RS;
  Object.assign(order, amounts(order));
  renderMessages(order, settings);
  if (order.whatsapp && !order.whatsapp_sent_at) order.whatsapp_sent_at = now();
  // The 24h silence clock for the auto-cancel starts when an upfront amount is
  // first requested, and restarts if the requested amount changes.
  if (!order.payment) {
    if (order.commitment_fee_rs > 0) {
      if (!order.upfront_requested_at || order.upfront_requested_fee !== order.commitment_fee_rs) {
        order.upfront_requested_at = now();
        order.upfront_requested_fee = order.commitment_fee_rs;
      }
    } else {
      order.upfront_requested_at = null;
      order.upfront_requested_fee = null;
    }
  }
  return before;
}

/** Re-score with the order's cached evidence (no LLM call). Audits real changes only. */
function rescoreCached(order, policy, settings, reason) {
  if (order.payment_mode === 'prepaid') {
    renderMessages(order, settings);
    return null;
  }
  const st = order.steps;
  const score = scoreOrder(
    {
      pinCheck: st.pin_check, history: st.history, addressCheck: st.address_check, address: order.address,
      phone: order.phone, buyerName: order.buyer_name, amount: order.amount, ordersSamePhoneToday: order.orders_same_phone_today ?? 1,
    },
    policy
  );
  const before = applyDerived(order, score, policy, settings);
  if (before.score !== order.score || before.band !== order.risk_band || before.fee !== order.commitment_fee_rs) {
    log(
      order, 'rescore',
      `Rescored ${before.score} -> ${order.score} (${order.risk_band_label}, pay now ${inr(order.pay_now_rs)}): ${reason}. Decision unchanged.`,
      'system', { from: before.score, to: order.score }
    );
    return { id: order.id, from: before.score, to: order.score };
  }
  return null;
}

/* ---------------- pipeline ---------------- */

/**
 * Run the full pipeline for one order (no persistence). Exactly one LLM call
 * happens here, inside checkAddress(); every other step is plain code.
 * `addressCheck` may be supplied to reuse existing evidence (seed data).
 */
export async function runPipeline(input, policy, { addressCheck: cachedAddress } = {}) {
  if (input.payment_mode === 'prepaid') {
    return {
      pinCheck: { risk: 'not_scored', note: 'Prepaid order: COD risk does not apply.' },
      history: checkHistory(input.phone, input),
      addressCheck: { address_quality: 'clear', source: 'skipped', reason: 'Prepaid: no address-check call.' },
      score: { score: 0, level: 'LOW', rule: 'PREPAID', reasons: ['Prepaid order: no COD collection risk.'], breakdown: [] },
    };
  }
  const pinCheck = checkPin(input.pin); // 1. plain code
  const history = checkHistory(input.phone, input); // 2. plain code
  const addressCheck = cachedAddress ?? (await checkAddress(input.address)); // 3. the ONE LLM call (or rule-based fallback)
  const score = scoreOrder(
    { pinCheck, history, addressCheck, address: input.address, phone: input.phone, buyerName: input.buyer_name, amount: input.amount, ordersSamePhoneToday: input.orders_same_phone_today ?? 1 },
    policy
  ); // 4. plain code
  return { pinCheck, history, addressCheck, score };
}

export async function createOrder(tenantId, input, { seller_request, external_id, idempotency_key, source = 'api', public_base, addressCheck } = {}) {
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
  const settings = settingsFor(tenantId);
  tenant.order_counter = (tenant.order_counter ?? 1000) + 1;
  const id = `CG-${tenant.order_counter}`;
  const createdAt = now();
  const today = istDay(createdAt);
  // Same phone, same tenant, same IST calendar day.
  const samePhone = input.phone ? ordersOf(tenantId).filter((o) => o.phone === input.phone && istDay(o.created_at) === today) : [];
  const ordersToday = samePhone.length + 1;

  const order = {
    id,
    tenant_id: tenantId,
    external_id: external_id ? String(external_id).slice(0, 80) : null,
    idempotency_key: idempotency_key ? String(idempotency_key).slice(0, 120) : null,
    source: SOURCE_LABELS[source] ? source : 'api',
    buyer_name: input.buyer_name,
    phone: input.phone,
    pin: input.pin,
    city: input.city || '',
    address: input.address,
    product: input.product,
    amount: input.amount,
    payment_mode: input.payment_mode ?? 'cod',
    orders_same_phone_today: input.orders_same_phone_today ?? ordersToday,
    created_at: createdAt,
    placed_ist_day: today,
    events: [],
    status: 'PENDING_REVIEW',
    decision: null,
    decision_by: null,
    decided_at: null,
    overridden: false,
    human_reviewed_at: null,
    buyer_reply: null,
    payment: null,
    address_corrections: 0,
    policy_notice: null,
    whatsapp: null,
    whatsapp_sent_at: null,
    reminder: null,
    reminder_sent_at: null,
    upfront_requested_at: null,
    upfront_requested_fee: null,
    silence_flagged_at: null,
    buyer_token: newBuyerToken(),
    steps: {},
  };
  setBuyerLink(order, public_base);
  const steps = await runPipeline({ ...input, orders_same_phone_today: order.orders_same_phone_today }, policy, { addressCheck });
  order.steps = { pin_check: steps.pinCheck, history: steps.history, address_check: steps.addressCheck, score: steps.score };
  applyDerived(order, steps.score, policy, settings);

  log(order, 'placed', `Placed via ${SOURCE_LABELS[order.source]}${order.external_id ? ` · external id ${order.external_id}` : ''} · ${order.payment_mode === 'prepaid' ? 'Prepaid' : 'COD'} · IST day ${today}.`, order.source);
  log(order, 'scored', `Scored ${order.score}/100 -> ${order.risk_band_label} band. Pay now ${inr(order.pay_now_rs)}, balance at delivery ${inr(order.balance_at_delivery_rs)}.`);
  if (order.whatsapp) {
    log(order, 'whatsapp', order.commitment_fee_rs > 0
      ? `Buyer message ready: pay ${inr(order.commitment_fee_rs)} upfront on the buyer page (manual send only).`
      : 'Buyer message ready: free confirmation, reply YES or confirm on the buyer page (manual send only).');
  }
  log(order, 'await', 'Awaiting a human Ship / Hold / Cancel decision.');

  if (seller_request) {
    const verdict = evaluateSellerRule(seller_request);
    s.refusedRules.push({ id: s.refusedRules.length + 1, ts: now(), text: seller_request, ...verdict, order_id: id, tenant_id: tenantId });
    order.policy_notice = { request: seller_request, ...verdict };
    log(order, 'policy', `Seller request "${seller_request}" was refused. This order was scored on its own signals.`);
  }
  decorate(order);
  s.orders.push(order);

  // A new order from the same phone on the same IST day raises the frequency
  // signal of the earlier ones. Re-score them from cached evidence (no LLM
  // calls), audit real changes, and never touch their decisions.
  const rescored = [];
  for (const prior of samePhone) {
    const count = Math.max(prior.orders_same_phone_today ?? 1, ordersToday);
    if (count === prior.orders_same_phone_today) continue;
    prior.orders_same_phone_today = count;
    const r = rescoreCached(prior, policy, settings, `${count} orders from this phone today (IST), latest ${id}`);
    if (r) rescored.push(prior);
  }
  save();
  await dispatch(tenantId, 'order.scored', order);
  for (const prior of rescored) await dispatch(tenantId, 'order.rescored', prior);
  return order;
}

export const listOrders = (tenantId) => ordersOf(tenantId).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
export const getOrder = (tenantId, id) => ordersOf(tenantId).find((o) => o.id === id) ?? null;
export const getOrderByExternalId = (tenantId, externalId) => ordersOf(tenantId).find((o) => o.external_id === externalId) ?? null;
export const listRefusedRules = (tenantId) => getState().refusedRules.filter((r) => r.tenant_id === tenantId).slice().reverse();

export function submitSellerRule(tenantId, text) {
  const s = getState();
  const verdict = evaluateSellerRule(text);
  const entry = { id: s.refusedRules.length + 1, ts: now(), text: String(text).slice(0, 300), ...verdict, tenant_id: tenantId };
  s.refusedRules.push(entry);
  save();
  return entry;
}

/** Re-score every order of a tenant after a policy/settings change (cached evidence, no LLM calls). */
export async function refreshTenantOrders(tenantId, reason = 'policy or settings changed') {
  const policy = policyFor(tenantId);
  const settings = settingsFor(tenantId);
  const changed = [];
  for (const o of ordersOf(tenantId)) if (rescoreCached(o, policy, settings, reason)) changed.push(o);
  save();
  for (const o of changed) await dispatch(tenantId, 'order.rescored', o);
  return { rescored: changed.length };
}

/* ---------------- seller actions ---------------- */

async function transition(order, status, type, text, event = 'order.status_changed', by = 'seller') {
  order.status = status;
  log(order, type, text, by);
  save();
  await dispatch(order.tenant_id, event, order);
}

/**
 * Human seller actions: ship | hold | cancel | override(to, note required) | undo.
 * Every one records a human review, which also preempts the silent auto-cancel.
 */
export async function applyAction(tenantId, id, { action, to, note } = {}) {
  const order = getOrder(tenantId, id);
  if (!order) throw new WorkflowError('Order not found');
  if (['ship', 'hold', 'cancel'].includes(action)) {
    const target = { ship: 'SHIPPED', hold: 'HOLD', cancel: 'CANCELLED' }[action];
    order.decision = action;
    order.decision_by = 'human';
    order.decided_at = now();
    order.human_reviewed_at = order.decided_at;
    await transition(order, target, action, `Human seller chose ${action}.${note ? ` Note: ${String(note).slice(0, 200)}` : ''}`);
  } else if (action === 'override') {
    const target = { ship: 'SHIPPED', hold: 'HOLD', cancel: 'CANCELLED' }[to];
    if (!target) throw new WorkflowError('override needs to = ship | hold | cancel');
    const reason = String(note ?? '').trim();
    if (!reason) throw new WorkflowError('An override needs a note explaining why');
    order.decision = to;
    order.decision_by = 'human';
    order.decided_at = now();
    order.human_reviewed_at = order.decided_at;
    order.overridden = true;
    log(order, 'override', `Seller overrode the suggestion (score ${order.score}, ${order.risk_band_label}, was ${order.status}) -> ${target}. Note: ${reason.slice(0, 200)}`, 'seller');
    order.status = target;
    save();
    await dispatch(tenantId, 'order.overridden', order, { note: reason.slice(0, 200) });
  } else if (action === 'undo') {
    if (!order.decision) throw new WorkflowError('Nothing to undo: this order has no decision');
    const prev = `${order.decision} by ${order.decision_by}`;
    order.decision = null;
    order.decision_by = null;
    order.decided_at = null;
    order.overridden = false;
    order.human_reviewed_at = now(); // a human acted: the silent auto-cancel will not fire later
    order.status = 'PENDING_REVIEW';
    log(order, 'undo', `Seller undid the decision (${prev}). Back to PENDING_REVIEW; nothing is decided automatically.`, 'seller');
    save();
    await dispatch(tenantId, 'order.decision_undone', order, { undone: prev });
  } else {
    throw new WorkflowError('action must be ship | hold | cancel | override | undo');
  }
  return order;
}

/* ---------------- buyer evidence ---------------- */

function createPayment(order, { type, app, source }) {
  const value = Number(order.amount);
  let payment;
  if (type === 'full_online') {
    if (order.risk_band !== 'EXTREME') throw new BuyerError(400, 'full_online_not_offered', `Full online payment at ${FULL_ONLINE_DISCOUNT_PCT}% off is only offered for EXTREME band orders.`);
    const discount = round2((value * FULL_ONLINE_DISCOUNT_PCT) / 100);
    payment = { type, amount_rs: round2(value - discount), discount_rs: discount, balance_due_rs: 0 };
  } else if (type === 'upfront') {
    const fee = Math.min(order.commitment_fee_rs ?? 0, Math.floor(value));
    if (!(fee > 0)) throw new BuyerError(400, 'no_upfront_requested', 'No upfront amount is requested for this order.');
    payment = { type, amount_rs: fee, discount_rs: 0, balance_due_rs: round2(value - fee) };
  } else {
    throw new BuyerError(400, 'invalid_payment_type', 'type must be upfront or full_online');
  }
  order.payment = {
    ...payment,
    order_value_rs: value,
    app: UPI_APPS[app] ? app : 'other_upi',
    reference: `DEMO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    simulated: true,
    source,
    recorded_at: now(),
  };
  Object.assign(order, amounts(order));
  return order.payment;
}

/** Record a reply without letting a weaker reply overwrite a recorded payment. */
function setReply(order, reply, by, text) {
  if (order.payment && (reply === 'confirm' || reply === 'address_fixed' || reply === 'no_reply')) {
    log(order, 'reply', `${text} (payment already recorded; reply stays "paid"). A human must decide the order.`, by);
    return;
  }
  order.buyer_reply = reply;
  log(order, 'reply', `${text} A human must decide the order.`, by);
}

/**
 * Buyer reply to the message: confirm | paid | cancel | no_reply | wrong_address | address_fixed.
 * Evidence only: it never ships, holds or cancels the order.
 */
export async function applyReply(tenantId, id, reply, { source = 'api' } = {}) {
  const order = getOrder(tenantId, id);
  if (!order) throw new WorkflowError('Order not found');
  if (reply === 'clear') return clearReply(order, source);
  if (!order.whatsapp) throw new WorkflowError('No confirmation required for this order');
  if (!BUYER_REPLIES.includes(reply)) throw new WorkflowError('Invalid buyer reply');
  const by = source === 'simulation' ? 'simulation' : source;
  if (reply === 'paid' && order.commitment_fee_rs > 0 && !order.payment) {
    createPayment(order, { type: 'upfront', app: 'other_upi', source: by });
    log(order, 'payment', `Upfront ${inr(order.payment.amount_rs)} recorded as paid (${by === 'simulation' ? 'simulated' : 'reported'}; no real money). Balance at delivery ${inr(order.payment.balance_due_rs)}.`, by);
  }
  setReply(order, reply, by, `Buyer reply recorded: ${reply}${by === 'simulation' ? ' (simulated)' : ''}.`);
  save();
  await dispatch(tenantId, 'order.reply_received', order);
  return order;
}

/** Seller clears a mistaken reply. Refused when a payment is recorded. Counts as a human review. */
async function clearReply(order, source) {
  if (!order.buyer_reply) throw new WorkflowError('There is no recorded reply to clear');
  if (order.payment) throw new WorkflowError('A payment is recorded for this order; its reply cannot be cleared');
  const prev = order.buyer_reply;
  order.buyer_reply = null;
  order.human_reviewed_at = now(); // never let a cleared reply lead to an automatic cancel
  log(order, 'reply_cleared', `Seller cleared the recorded reply "${prev}". Order still awaits a human decision.`, source === 'dashboard' ? 'seller' : source);
  save();
  await dispatch(order.tenant_id, 'order.reply_cleared', order, { cleared: prev });
  return order;
}

/* ---------------- buyer page (bearer token) ---------------- */

/** Global lookup by bearer token. Returns null for anything that is not a live token. */
export function findByToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const want = Buffer.from(token);
  const o = getState().orders.find((x) => x.buyer_token && x.buyer_token.length === token.length && crypto.timingSafeEqual(Buffer.from(x.buyer_token), want));
  return o ? decorate(o) : null;
}

/** The narrow buyer view. Never includes tenant ids, scores, reasons, events, phone or decisions. */
export function buyerView(order) {
  const settings = settingsFor(order.tenant_id);
  const policy = policyFor(order.tenant_id);
  const cod = order.payment_mode !== 'prepaid';
  const readOnly = order.status === 'CANCELLED';
  const fee = cod ? order.commitment_fee_rs ?? 0 : 0;
  const discount = round2((Number(order.amount) * FULL_ONLINE_DISCOUNT_PCT) / 100);
  const requested = !cod ? 'none' : fee > 0 ? 'pay_upfront' : order.risk === 'MEDIUM' ? 'confirm' : 'none';
  const realReply = order.buyer_reply && order.buyer_reply !== 'no_reply' ? order.buyer_reply : null;
  return {
    demo: true,
    notice: 'Shared public sandbox with fake data. No real purchase and no money is collected.',
    brand_name: settings.brand_name,
    order_ref: order.external_id ?? order.id,
    buyer_first_name: String(order.buyer_name ?? '').split(' ')[0],
    product: order.product,
    order_value_rs: order.amount,
    address: order.address,
    payment_mode: order.payment_mode,
    risk_band: cod ? order.risk_band : null,
    risk_band_label: cod ? order.risk_band_label : null,
    requested_action: requested,
    pay_now_rs: order.pay_now_rs,
    balance_at_delivery_rs: order.balance_at_delivery_rs,
    upfront_fee_rs: fee,
    full_online: cod && order.risk_band === 'EXTREME' && !order.payment
      ? { available: true, discount_pct: FULL_ONLINE_DISCOUNT_PCT, discount_rs: discount, amount_rs: round2(order.amount - discount) }
      : { available: false },
    ladder: cod ? ladderFor(policy).map(({ band, label, min, max, fee_rs, ask }) => ({ band, label, min, max, fee_rs: Math.min(fee_rs, Math.floor(order.amount)), ask })) : [],
    your_reply: realReply,
    payment: order.payment
      ? { type: order.payment.type, app: UPI_APPS[order.payment.app], amount_rs: order.payment.amount_rs, discount_rs: order.payment.discount_rs, balance_due_rs: order.payment.balance_due_rs, reference: order.payment.reference, recorded_at: order.payment.recorded_at, simulated: true }
      : null,
    upi_apps: Object.entries(UPI_APPS).map(([id, label]) => ({ id, label })),
    can_confirm: !readOnly && requested !== 'none' && !order.payment && realReply !== 'confirm',
    can_pay: !readOnly && fee > 0 && !order.payment,
    can_fix_address: !readOnly && cod && (order.address_corrections ?? 0) < MAX_ADDRESS_CORRECTIONS,
    read_only: readOnly,
    status_message: readOnly ? 'This order was cancelled. This page is read-only.' : 'The seller reviews every order before dispatch.',
  };
}

function assertWritable(order) {
  if (order.status === 'CANCELLED') throw new BuyerError(409, 'order_cancelled', 'This order was cancelled. The buyer page is read-only.');
}

export async function buyerConfirm(order) {
  assertWritable(order);
  if (order.payment_mode === 'prepaid' || !order.whatsapp) throw new BuyerError(400, 'no_confirmation_needed', 'No confirmation is needed for this order.');
  const already = order.buyer_reply === 'confirm';
  if (!already) {
    setReply(order, 'confirm', 'buyer', 'Buyer confirmed the order on the buyer page.');
    save();
    await dispatch(order.tenant_id, 'order.reply_received', order);
  }
  return { ok: true, already_recorded: already, message: 'Thanks, your confirmation is recorded. The seller still reviews your order before dispatch.', view: buyerView(order) };
}

export async function buyerFixAddress(order, address) {
  assertWritable(order);
  if (order.payment_mode === 'prepaid') throw new BuyerError(400, 'not_applicable', 'Address changes for prepaid orders are handled by the store.');
  const next = typeof address === 'string' ? address.trim().replace(/\s+/g, ' ') : '';
  if (next.length < 10 || next.length > 500) throw new BuyerError(400, 'invalid_address', 'Please enter the full address (10-500 characters).');
  if (next === order.address) throw new BuyerError(400, 'unchanged_address', 'That is the same address we already have.');
  if ((order.address_corrections ?? 0) >= MAX_ADDRESS_CORRECTIONS) throw new BuyerError(429, 'too_many_corrections', 'This order reached the limit of address corrections. Please contact the store.');
  const previous = order.address;
  const from = order.score;
  order.address = next;
  order.address_corrections = (order.address_corrections ?? 0) + 1;
  order.steps.address_check = await checkAddress(next); // the new address is new evidence: one check for it
  log(order, 'address_fixed', `Buyer corrected the address on the buyer page (was "${previous.slice(0, 120)}").`, 'buyer');
  rescoreCached(order, policyFor(order.tenant_id), settingsFor(order.tenant_id), 'buyer corrected the address');
  setReply(order, 'address_fixed', 'buyer', 'Buyer reply recorded: address_fixed.');
  save();
  await dispatch(order.tenant_id, 'order.reply_received', order);
  if (from !== order.score) await dispatch(order.tenant_id, 'order.rescored', order);
  return { ok: true, message: 'Thanks, your new address is saved. The seller still reviews your order before dispatch.', view: buyerView(order) };
}

export async function buyerPay(order, { type, app } = {}) {
  assertWritable(order);
  if (order.payment_mode === 'prepaid') throw new BuyerError(400, 'already_prepaid', 'This order is prepaid. There is nothing to pay.');
  if (order.payment) {
    return { ok: true, already_recorded: true, message: 'A demo payment is already recorded for this order. Nothing was charged again. The seller still reviews your order before dispatch.', payment: buyerView(order).payment, view: buyerView(order) };
  }
  const p = createPayment(order, { type, app, source: 'buyer' });
  log(order, 'payment', p.type === 'full_online'
    ? `Simulated full online payment ${inr(p.amount_rs)} (${FULL_ONLINE_DISCOUNT_PCT}% off, saved ${inr(p.discount_rs)}) via ${UPI_APPS[p.app]}. Ref ${p.reference}. No money collected.`
    : `Simulated upfront payment ${inr(p.amount_rs)} via ${UPI_APPS[p.app]}; adjusted against delivery, balance ${inr(p.balance_due_rs)}. Ref ${p.reference}. No money collected.`, 'buyer');
  setReply(order, 'paid', 'buyer', 'Buyer reply recorded: paid (simulated).');
  save();
  await dispatch(order.tenant_id, 'order.reply_received', order);
  const view = buyerView(order);
  return {
    ok: true,
    already_recorded: false,
    message: p.type === 'full_online'
      ? `DEMO payment of ${inr(p.amount_rs)} recorded. No money was collected. Nothing is due at delivery. The seller still reviews your order before dispatch.`
      : `DEMO payment of ${inr(p.amount_rs)} recorded. No money was collected. It is adjusted against your delivery amount: ${inr(p.balance_due_rs)} due at the door. The seller still reviews your order before dispatch.`,
    payment: view.payment,
    view,
  };
}

/* ---------------- silence sweep ---------------- */

/**
 * The silence sweep: generate the one reminder, then apply the silence outcome.
 * Runs on a timer in the server and after the demo time-warp; exported for tests.
 */
export async function sweepSilence() {
  const s = getState();
  const nowMs = Date.now();
  for (const order of s.orders) {
    if (order.decision || !order.whatsapp_sent_at) continue;
    const policy = policyFor(order.tenant_id);
    const elapsedH = (nowMs - Date.parse(order.whatsapp_sent_at)) / HOUR_MS;
    // A recorded no_reply IS silence. Only an actual response (confirm, paid, cancel,
    // wrong_address, address_fixed) or any human action prevents the silence outcome.
    const silent = !order.buyer_reply || order.buyer_reply === 'no_reply';
    if (!order.reminder_sent_at && elapsedH >= policy.reminderAfterHours) {
      order.reminder_sent_at = now();
      order.reminder = buildReminderMessage(order, order.risk, settingsFor(order.tenant_id).brand_name);
      log(order, 'reminder', 'One reminder generated (mock only, never sent automatically). Human decision still required.');
      save();
      await dispatch(order.tenant_id, 'order.reminded', order);
    }
    const upfrontAt = order.upfront_requested_at ?? (order.commitment_fee_rs > 0 ? order.whatsapp_sent_at : null);
    if (
      policy.autoCancelSilent && policy.highSilentAction === 'cancel' && order.commitment_fee_rs > 0 && upfrontAt &&
      !order.payment && !order.human_reviewed_at && silent && (nowMs - Date.parse(upfrontAt)) / HOUR_MS >= 24
    ) {
      order.decision = 'cancel';
      order.decision_by = 'system';
      order.decided_at = now();
      await transition(order, 'CANCELLED', 'auto_cancel', 'System cancelled: 24 hours of buyer silence after an upfront request (brand toggle ON).', 'order.auto_cancelled', 'system');
      continue;
    }
    if (!order.silence_flagged_at && silent && elapsedH >= policy.highSilentAfterHours) {
      order.silence_flagged_at = now();
      log(order, 'silence', 'Buyer silence flagged for human review. No order status changed.');
      save();
      await dispatch(order.tenant_id, 'order.review_required', order);
    }
  }
}

/** Demo helper: backdate the clocks on all undecided orders of a tenant, then sweep. */
export async function timeWarp(tenantId, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 720) throw new WorkflowError('hours must be between 0 and 720');
  const shift = h * HOUR_MS;
  const back = (ts) => (ts ? new Date(Date.parse(ts) - shift).toISOString() : ts);
  for (const order of ordersOf(tenantId)) {
    if (order.decision || !order.whatsapp_sent_at) continue;
    order.whatsapp_sent_at = back(order.whatsapp_sent_at);
    order.reminder_sent_at = back(order.reminder_sent_at);
    order.upfront_requested_at = back(order.upfront_requested_at);
  }
  save();
  await sweepSilence();
  return listOrders(tenantId);
}

/* ---------------- seed, import, bulk ---------------- */

/**
 * (Re)seed a tenant with the 40 synthetic demo orders. Only that tenant's data
 * resets. Seed orders use rule-based address evidence, so a reset never makes
 * paid LLM calls.
 */
export async function seed(tenantId, { public_base } = {}) {
  const s = getState();
  const tenant = getTenant(tenantId);
  if (!tenant) throw new WorkflowError('Tenant not found');
  s.orders = s.orders.filter((o) => o.tenant_id !== tenantId);
  s.refusedRules = s.refusedRules.filter((r) => r.tenant_id !== tenantId);
  tenant.order_counter = 1000; // stable demo ids: CG-1001 .. CG-1040
  save();
  for (const seedOrder of SEED_ORDERS) {
    const { seller_request, ...input } = seedOrder;
    const evidence = { ...ruleBasedAddressCheck(input.address), source: 'rules', fallback_reason: 'Demo seed: rule-based evidence (no paid LLM call)' };
    await createOrder(tenantId, input, { seller_request, source: 'seed', public_base, addressCheck: input.payment_mode === 'prepaid' ? undefined : evidence });
  }
}

/**
 * CSV import. append: create valid rows, report row errors. replace: validates
 * EVERY row first and requires confirm === 'REPLACE'; only if all rows are
 * valid are the tenant's existing orders deleted and the rows imported.
 */
export async function importOrders(tenantId, rows, { mode = 'append', confirm, public_base } = {}) {
  if (!['append', 'replace'].includes(mode)) throw new WorkflowError('mode must be append or replace');
  if (!Array.isArray(rows) || rows.length > 100) throw new WorkflowError('orders must be an array with at most 100 rows');
  const checked = rows.map((row, i) => ({ row: i + 1, raw: row ?? {}, ...validateOrder(row) }));
  let replaced = 0;
  if (mode === 'replace') {
    if (confirm !== 'REPLACE') throw new WorkflowError('Replace deletes every current order of this demo account. Send confirm: "REPLACE" to proceed.');
    if (!rows.length) throw new WorkflowError('Replace needs at least one valid row');
    const errors = checked.filter((c) => c.problems).map((c) => ({ row: c.row, errors: c.problems }));
    const seen = new Map();
    for (const c of checked) {
      const ext = c.raw.order_id;
      if (!ext) continue;
      if (seen.has(ext)) errors.push({ row: c.row, errors: [`duplicate order_id "${String(ext).slice(0, 40)}" (also row ${seen.get(ext)})`] });
      else seen.set(ext, c.row);
    }
    if (errors.length) throw new WorkflowError('No orders were replaced: fix every row first.', errors);
    const s = getState();
    replaced = s.orders.filter((o) => o.tenant_id === tenantId).length;
    s.orders = s.orders.filter((o) => o.tenant_id !== tenantId);
    save();
  }
  const results = [];
  for (const c of checked) {
    if (c.problems) {
      results.push({ row: c.row, errors: c.problems });
      continue;
    }
    try {
      const o = await createOrder(tenantId, c.order, { external_id: c.raw.order_id, source: 'csv', public_base });
      results.push({ row: c.row, id: o.id });
    } catch (e) {
      results.push(e instanceof IdempotentReplay ? { row: c.row, id: e.order.id, replayed: true } : { row: c.row, errors: [e.message] });
    }
  }
  return { mode, replaced, results };
}

/** Explainable suggestion. A human must still click; bulk acceptance is explicit. */
export function suggestion(o) {
  if (o.buyer_reply === 'cancel') return 'cancel';
  if (o.buyer_reply === 'wrong_address') return 'hold';
  const silent = !o.buyer_reply || o.buyer_reply === 'no_reply';
  if (silent && (o.buyer_reply === 'no_reply' || o.silence_flagged_at)) return o.risk_band === 'EXTREME' ? 'cancel' : 'hold';
  if (o.risk === 'LOW' || o.payment || o.buyer_reply === 'paid' || (o.buyer_reply === 'confirm' && o.risk === 'MEDIUM')) return 'ship';
  return 'wait';
}

const SIMULATED_MIX = ['paid', 'confirm', 'address_fixed', 'no_reply'];

/** Explicit, human-triggered bulk actions on one tenant's orders. */
export async function bulkAction(tenantId, action) {
  if (!['ship_safe', 'simulate_replies', 'accept_suggestions'].includes(action)) throw new WorkflowError('Unknown bulk action');
  let changed = 0;
  if (action === 'simulate_replies') {
    // Deterministic mix; skips orders already replied to or decided.
    const eligible = listOrders(tenantId).filter((o) => !o.decision && !o.buyer_reply && o.whatsapp);
    for (const [i, o] of eligible.entries()) {
      let reply = SIMULATED_MIX[i % SIMULATED_MIX.length];
      if (reply === 'paid' && !(o.commitment_fee_rs > 0)) reply = 'confirm';
      await applyReply(tenantId, o.id, reply, { source: 'simulation' });
      changed++;
    }
    return { changed, orders: listOrders(tenantId) };
  }
  for (const o of listOrders(tenantId)) {
    if (o.decision) continue;
    if (action === 'ship_safe' && o.risk === 'LOW') {
      await applyAction(tenantId, o.id, { action: 'ship', note: 'Bulk: ship all safe orders.' });
      changed++;
    }
    if (action === 'accept_suggestions' && suggestion(o) !== 'wait') {
      await applyAction(tenantId, o.id, { action: 'override', to: suggestion(o), note: 'Seller accepted the tool suggestion using bulk action.' });
      changed++;
    }
  }
  return { changed, orders: listOrders(tenantId) };
}
