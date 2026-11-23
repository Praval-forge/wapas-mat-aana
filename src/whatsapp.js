// Step 5 - plain-code WhatsApp message text. Nothing here sends anything: the
// dashboard shows the text and a person may open a prefilled chat and press
// Send themselves.
//
// The message follows the order's band on the five-band ladder:
//   LOW              -> no message
//   MEDIUM           -> free confirmation ("reply YES" or confirm on the buyer page)
//   HIGH / VERY_HIGH -> refundable upfront amount, adjusted against the amount due on delivery
//   EXTREME          -> same, plus the demo option to pay fully online at 5% off
// Links point at the order's own buyer page (order.buyer_url), built from the
// trusted public base URL. Payments in this sandbox are simulated.
import { FULL_ONLINE_DISCOUNT_PCT } from './policyConfig.js';

const round2 = (n) => Math.round(n * 100) / 100;
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const firstName = (order) => String(order.buyer_name ?? '').split(' ')[0] || 'there';

function upfrontLines(order) {
  const fee = order.commitment_fee_rs ?? 0;
  const lines = [
    `To confirm, please pay a refundable ${inr(fee)} upfront here: ${order.buyer_url}`,
    `It is adjusted against your amount due on delivery (you pay ${inr(round2(order.amount - fee))} at the door).`,
  ];
  if (order.risk_band === 'EXTREME') {
    const discount = round2((order.amount * FULL_ONLINE_DISCOUNT_PCT) / 100);
    lines.push(`Or pay the full amount online at ${FULL_ONLINE_DISCOUNT_PCT}% off (${inr(round2(order.amount - discount))}) on the same page.`);
  }
  lines.push('Demo sandbox: no real payment is collected.');
  return lines;
}

export function buildWhatsAppMessage(order, level, addressCheck, brandName = 'our store') {
  if (level === 'LOW' || order.payment_mode === 'prepaid') return null;
  const lines = [`Hi ${firstName(order)}! Thanks for your order ${order.id} (${order.product}, ${inr(order.amount)}, Cash on Delivery).`];
  if (addressCheck?.address_quality && addressCheck.address_quality !== 'clear') {
    lines.push(`Your delivery address looks incomplete: "${order.address}". Please correct it here: ${order.buyer_url}`);
  }
  if ((order.commitment_fee_rs ?? 0) > 0) {
    lines.push(...upfrontLines(order));
  } else {
    lines.push(`Please confirm your COD order here: ${order.buyer_url} (or reply *YES*). There is nothing to pay now.`);
    lines.push('If we do not hear from you, we will remind you once, and then the store will decide how to proceed.');
  }
  lines.push('Reply *CANCEL* if you no longer want it.');
  lines.push(`- ${brandName}`);
  return lines.join('\n');
}

/** The single reminder, generated once after the policy's reminder window. */
export function buildReminderMessage(order, level, brandName = 'our store') {
  if (level === 'LOW' || order.payment_mode === 'prepaid') return null;
  const head = `Hi ${firstName(order)}, a reminder about your order ${order.id} (${order.product}, ${inr(order.amount)}, Cash on Delivery).`;
  if ((order.commitment_fee_rs ?? 0) > 0) {
    return [head, ...upfrontLines(order), 'If we do not hear from you, the order may be cancelled. Reply *CANCEL* if you no longer want it.', `- ${brandName}`].join('\n');
  }
  return [head, `Please confirm here: ${order.buyer_url} (or reply *YES*). Nothing to pay now. Reply *CANCEL* if you no longer want it.`, `- ${brandName}`].join('\n');
}
