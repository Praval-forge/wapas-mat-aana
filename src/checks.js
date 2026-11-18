// Steps 2 and 4 of the pipeline: plain code, no AI.
import { PIN_TABLE, PIN_THRESHOLDS, BUYER_HISTORY } from './data.js';

/** Step 2a - pin-code risk from the lookup table. */
export function checkPin(pin) {
  const row = PIN_TABLE[pin];
  if (!row) {
    return { pin, risk: 'unknown', note: 'Pin code not in the return-rate table - treated neutrally.' };
  }
  const pct = Math.round(row.returnRate * 100);
  if (row.orders < PIN_THRESHOLDS.minSample) {
    return {
      pin,
      area: row.area,
      risk: 'unknown',
      return_rate: row.returnRate,
      sample: row.orders,
      note: `Only ${row.orders} past orders for this pin - too few to judge, treated neutrally.`,
    };
  }
  const risk =
    row.returnRate >= PIN_THRESHOLDS.high ? 'high' : row.returnRate >= PIN_THRESHOLDS.medium ? 'medium' : 'low';
  return {
    pin,
    area: row.area,
    risk,
    return_rate: row.returnRate,
    sample: row.orders,
    note: `${pct}% of ${row.orders} past COD orders to ${pin} (${row.area}) were returned -> ${risk} pin risk.`,
  };
}

/** Step 2b - the buyer's own past returns / past orders. */
export function checkHistory(phone) {
  const h = BUYER_HISTORY[phone] ?? { past_orders: 0, past_returns: 0 };
  const ratio = h.past_orders > 0 ? h.past_returns / h.past_orders : 0;
  const known = phone in BUYER_HISTORY;
  return {
    past_orders: h.past_orders,
    past_returns: h.past_returns,
    return_ratio: Math.round(ratio * 100) / 100,
    note: !known || h.past_orders === 0
      ? 'New buyer - no order history.'
      : `${h.past_returns} return(s) in ${h.past_orders} past order(s) (${Math.round(ratio * 100)}%).`,
  };
}

/**
 * Step 4 - risk score. Ordered rules, first match wins.
 *
 * IMPORTANT (fairness): the ONLY inputs are the three per-order signals below.
 * City, state, buyer name, etc. are deliberately NOT parameters, so a "block everyone
 * from <city>" rule cannot be expressed here. Every order is scored on its own signals.
 */
export function scoreOrder({ pinCheck, history, addressCheck }) {
  const reasons = [];
  const { past_returns: returns, return_ratio: ratio } = history;
  const q = addressCheck.address_quality;

  // Collect every relevant signal so the seller sees all of them, not just the deciding one.
  if (returns >= 2) reasons.push(`Repeat returner: ${returns} past returns`);
  else if (returns === 1) reasons.push(`1 past return (${Math.round(ratio * 100)}% of ${history.past_orders} orders)`);
  if (q === 'bad') reasons.push(`Address unusable: ${addressCheck.reason}`);
  if (q === 'vague') reasons.push(`Address vague: ${addressCheck.reason}`);
  if (pinCheck.risk === 'high') reasons.push(`High-return pin code (${Math.round(pinCheck.return_rate * 100)}% returned)`);
  if (pinCheck.risk === 'medium') reasons.push(`Medium-return pin code (${Math.round(pinCheck.return_rate * 100)}% returned)`);

  let level;
  let rule;
  if (returns >= 2) [level, rule] = ['HIGH', 'R1: 2+ past returns'];
  else if (q === 'bad') [level, rule] = ['HIGH', 'R2: address unusable'];
  else if (q === 'vague') [level, rule] = ['HIGH', 'R3: vague address'];
  else if (pinCheck.risk === 'high' && returns >= 1) [level, rule] = ['HIGH', 'R4: high-return pin + a past return'];
  else if (pinCheck.risk === 'high') [level, rule] = ['MEDIUM', 'R5: clear address but high-return pin'];
  else if (returns >= 1 && (ratio >= 0.25 || pinCheck.risk === 'medium'))
    [level, rule] = ['MEDIUM', 'R6: past return with elevated ratio / medium pin'];
  else [level, rule] = ['LOW', 'R7: full address, safe pin, no meaningful return history'];

  if (level === 'LOW') {
    reasons.length = 0;
    reasons.push('Clear address, safe pin code, no return history');
  }
  return { level, rule, reasons };
}

/**
 * Fallback address check (used in demo mode, or if the LLM call fails).
 * Same output shape as the LLM: { address_quality, reason }.
 */
export function ruleBasedAddressCheck(text) {
  const t = String(text ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (t.length < 12 || words.length < 3 || !/[a-z]{3}/i.test(t)) {
    return { address_quality: 'bad', reason: 'Too short to deliver to (no usable street or house details).' };
  }
  const hasNumber = /\b(\d+[a-z]?(\/\d+)?|flat|house|h\.?\s?no|plot|door|room|unit|shop)\b/i.test(t);
  const hasStreetOrArea =
    /\b(road|rd|street|st|lane|gali|nagar|colony|marg|cross|main|sector|block|phase|apartment|apartments|apt|society|layout|enclave|chowk|market|tower|villa)\b/i.test(
      t
    );
  const hasLandmark = /\b(near|opp|opposite|behind|beside|next to|landmark|adjacent)\b/i.test(t);
  const missing = [];
  if (!hasNumber) missing.push('house/flat number');
  if (!hasStreetOrArea) missing.push('street or locality');
  if (hasNumber && hasStreetOrArea && t.length >= 25) {
    return {
      address_quality: 'clear',
      reason: `Has house number and street/locality${hasLandmark ? ' plus a landmark' : ''}.`,
    };
  }
  return {
    address_quality: 'vague',
    reason: missing.length
      ? `Missing ${missing.join(' and ')}${hasLandmark ? '; only a landmark is given' : ''}.`
      : 'Address is too short to be confident it is deliverable.',
  };
}
