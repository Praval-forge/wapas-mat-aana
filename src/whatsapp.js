// Step 5 - plain-code WhatsApp message text (mock send: only rendered in the UI).
// v2: the message depends on the tier. MEDIUM asks for a free "Reply YES"
// confirmation; HIGH asks for the refundable Rs 50 commitment fee.
// A real integration would send through the WhatsApp Business API; nothing
// here makes network calls.
import { COMMITMENT_FEE_RS } from './data.js';

export function buildWhatsAppMessage(order, level, addressCheck, brandName = 'our store') {
  if (level === 'LOW') return null;
  const first = order.buyer_name.split(' ')[0];
  const lines = [`Hi ${first}! Thanks for your order ${order.id} (${order.product}, ₹${order.amount}, Cash on Delivery).`];

  if (addressCheck.address_quality !== 'clear') {
    lines.push(
      `We want your parcel to reach you the first time, but your delivery address looks incomplete: "${order.address}". ` +
        'Please reply with your full address (house/flat no., street, area, pin code and a landmark).'
    );
  }

  if (level === 'MEDIUM') {
    lines.push('To dispatch your order, please reply *YES* to confirm your COD order.');
    lines.push('If we do not hear from you, we will remind you once, and then the store will decide how to proceed. Reply *CANCEL* if you no longer want it.');
  } else {
    const payLink = `https://pay.wapas-mat-aana.example/${order.id}`; // placeholder link - no real payments
    lines.push(
      `To dispatch your order, please pay a refundable ₹${order.commitment_fee_rs ?? COMMITMENT_FEE_RS} commitment fee: ${payLink} ` +
        '(adjusted against your bill on delivery).'
    );
    lines.push('Reply *CANCEL* if you no longer want it.');
  }
  lines.push('Or ask the store about paying fully online (demo option; no real payment is collected here).');
  lines.push(`- ${brandName}`);
  return lines.join('\n');
}

/** The single reminder, sent once after the policy's reminder window. */
export function buildReminderMessage(order, level) {
  const first = order.buyer_name.split(' ')[0];
  if (level === 'MEDIUM') {
    return (
      `Hi ${first}, a gentle reminder about your order ${order.id} (${order.product}, ₹${order.amount}, Cash on Delivery). ` +
      'Please reply *YES* to confirm so we can dispatch it. Reply *CANCEL* if you no longer want it.'
    );
  }
  const payLink = `https://pay.wapas-mat-aana.example/${order.id}`; // placeholder link - no real payments
  return (
    `Hi ${first}, a final reminder about your order ${order.id} (${order.product}, ₹${order.amount}, Cash on Delivery). ` +
    `Please pay the refundable ₹${order.commitment_fee_rs ?? COMMITMENT_FEE_RS} commitment fee to confirm: ${payLink}. ` +
    'If we do not hear from you, the order may be cancelled. Reply *CANCEL* if you no longer want it.'
  );
}
