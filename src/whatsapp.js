// Step 5 - plain-code WhatsApp message text (mock send: only rendered in the UI).
import { COMMITMENT_FEE_RS } from './data.js';

export function buildWhatsAppMessage(order, level, addressCheck) {
  if (level === 'LOW') return null;
  const first = order.buyer_name.split(' ')[0];
  const payLink = `https://pay.codguard.example/${order.id}`; // placeholder link - no real payments
  const lines = [`Hi ${first}! 👋 Thanks for your order ${order.id} (${order.product}, Rs ${order.amount}, Cash on Delivery).`];

  if (addressCheck.address_quality !== 'clear') {
    lines.push(
      `We want your parcel to reach you the first time, but your delivery address looks incomplete: "${order.address}". ` +
        'Please reply with your full address (house/flat no., street, area, pin code and a landmark).'
    );
  }

  lines.push('To dispatch your order, please choose one:');
  lines.push('1️⃣ Reply *YES* to confirm your COD order');
  lines.push(`2️⃣ Pay a refundable Rs ${COMMITMENT_FEE_RS} commitment fee now: ${payLink} (adjusted against your bill on delivery)`);
  lines.push(
    level === 'HIGH'
      ? 'Our team will review your order once we hear from you. Reply *CANCEL* if you no longer want it.'
      : 'If we do not hear from you, your order will be kept on hold. Reply *CANCEL* if you no longer want it.'
  );
  return lines.join('\n');
}
