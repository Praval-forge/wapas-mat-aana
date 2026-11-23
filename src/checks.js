// Steps 2 and 4 of the pipeline: plain code, no AI.
// Every COD order is scored on all signals (buyer history, pin return rate,
// address, phone/name flags, value, same-phone frequency) and combined into a
// 0-100 score that maps to the five-band ladder. The pin code is one input,
// never a gate that skips the rest.
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
export function checkHistory(phone, override = {}) {
  const supplied = override.past_orders != null || override.past_returns != null;
  const h = supplied ? { past_orders: override.past_orders ?? 0, past_returns: override.past_returns ?? 0 } : BUYER_HISTORY[phone] ?? { past_orders: 0, past_returns: 0 };
  const ratio = h.past_orders > 0 ? h.past_returns / h.past_orders : 0;
  const known = supplied || phone in BUYER_HISTORY;
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
 * Step 4 - the score. Additive, transparent, 0-100 (capped). Weights come from
 * the brand's policy so a brand can tune them. Every signal contributes; the
 * score is never short-circuited by a single input.
 *
 * IMPORTANT (fairness): the ONLY inputs are the three per-order signals below.
 * City, state, buyer name, etc. are deliberately NOT parameters, so a "block
 * everyone from <city>" rule cannot be expressed here.
 *
 * Returns { score, level, rule, reasons, breakdown } where level is
 * LOW | MEDIUM | HIGH from the policy's bands, and breakdown shows the points
 * each signal contributed (so a brand can explain every score).
 */
export function scoreOrder({ pinCheck, history, addressCheck, amount = 0, ordersSamePhoneToday = 1, address = '', phone = '', buyerName = '' }, policy) {
  const w = policy.weights;
  const breakdown = [];
  const reasons = [];
  const add = (signal, points, reason) => {
    if (points !== 0) breakdown.push({ signal, points });
    if (reason) reasons.push(reason);
  };

  // Signal 1: the buyer's own past returns.
  const returns = history.past_returns;
  if (returns >= 2) add('buyer_history', w.repeatReturner, `Repeat returner: ${returns} past returns`);
  else if (returns === 1)
    add('buyer_history', w.onePastReturn, `1 past return (${Math.round(history.return_ratio * 100)}% of ${history.past_orders} orders)`);

  else if (history.past_orders >= 3) add('buyer_history',-w.loyalBuyer,`Loyal buyer: ${history.past_orders} orders, no returns`);
  if (pinCheck.risk==='unknown') add('pin_code',w.unknownPin,'Pin code has no history yet');
  else if (pinCheck.return_rate >= .30) add('pin_code',w.pinHigh,`Pin returns ${Math.round(pinCheck.return_rate*100)}% of COD orders`);
  else if (pinCheck.return_rate >= .20) add('pin_code',w.pinMedium,`Pin returns ${Math.round(pinCheck.return_rate*100)}% of COD orders`);
  const a=String(address).toLowerCase();
  if(a.length<25)add('address',w.shortAddress,'Short address');
  if(!/\d/.test(a))add('address',w.noHouseNumber,'No house number');
  if(!['near','opp','behind','beside','landmark','flat','house','h.no','plot','floor','sector','lane','apartment','colony'].some(x=>a.includes(x)))add('address',w.noLandmark,'No landmark or locality marker');
  const ph=String(phone).replace(/\D/g,'');
  if(ph.length!==10||!['6','7','8','9'].includes(ph[0])||new Set(ph).size<=2||['9876543210','1234567890','0123456789'].includes(ph))add('phone_quality',w.fakePhone,'Phone number looks invalid or repetitive');
  const name=String(buyerName).trim().toLowerCase();
  if(name.length<3||['test','abc','xyz','asdf','qwerty','na','aaa'].includes(name)||!/[aeiou]/.test(name))add('name_quality',w.junkName,'Name needs verification');
  if (amount > policy.highValueThreshold) add('order_value',w.highValue,`High value order: ₹${amount}`);
  if (ordersSamePhoneToday >= policy.frequencyThreshold) add('phone_frequency',w.phoneFrequency,`${ordersSamePhoneToday} orders from this phone today`);
  if(history.past_orders===0)add('buyer_history',w.firstTimeBuyer,'First-time buyer');
  const score = Math.max(0, Math.min(100, breakdown.reduce((sum, b) => sum + b.points, 0)));
  const level = score <= policy.lowMax ? 'LOW' : score <= policy.mediumMax ? 'MEDIUM' : 'HIGH';
  if (level === 'LOW') {
    reasons.length = 0;
    reasons.push('Low combined risk. Human ship decision required.');
  }
  const rule = `score ${score} -> ${level} (bands: LOW 0-${policy.lowMax}, MEDIUM ${policy.lowMax + 1}-${policy.mediumMax}, HIGH ${policy.mediumMax + 1}-100)`;
  return { score, level, rule, reasons, breakdown };
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
