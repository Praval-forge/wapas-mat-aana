// Request validation for order ingestion, shared by the demo API and /v1.
// Returns { order } or { problems: [..] } with every problem found.
export function validateOrder(b) {
  const body = b ?? {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
  const order = {
    buyer_name: str(body.buyer_name ?? body.name, 80),
    phone: str(body.phone, 15).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''),
    pin: str(body.pin ?? body.pincode, 6),
    city: str(body.city, 60),
    address: str(body.address, 500),
    product: str(body.product, 100) || 'Demo product',
    amount: Number(body.amount ?? body.order_value ?? 1200),
    payment_mode: str(body.payment_mode, 10).toLowerCase() === 'prepaid' ? 'prepaid' : 'cod',
    orders_same_phone_today: intOrNull(body.orders_same_phone_today),
    past_orders: intOrNull(body.past_orders),
    past_returns: intOrNull(body.past_returns ?? body.past_rto_count),
  };
  const problems = [];
  if (!order.buyer_name) problems.push('buyer_name is required');
  if (!/^[1-9]\d{5}$/.test(order.pin)) problems.push('pin must be a 6-digit Indian pin code');
  if (order.phone && !/^\d{10}$/.test(order.phone)) problems.push('phone must be 10 digits');
  if (!order.address) problems.push('address is required');
  if (!(order.amount > 0 && order.amount < 1_000_000)) problems.push('amount must be a positive number below 1000000');
  if (body.payment_mode && !['cod','prepaid'].includes(String(body.payment_mode).toLowerCase())) problems.push('payment_mode must be cod or prepaid');
  if (order.past_orders !== null && order.past_returns !== null && order.past_returns > order.past_orders) problems.push('past_returns cannot exceed past_orders');
  if (Number.isNaN(order.past_orders)) problems.push('past_orders must be a non-negative integer');
  if (Number.isNaN(order.past_returns)) problems.push('past_returns must be a non-negative integer');
  return problems.length ? { problems } : { order };
}
