// DEMO SIMULATOR ONLY. Maps a Shopify-shaped "orders/create" JSON payload onto
// a Wapas Mat Aana order. It is NOT a real Shopify webhook: there is no HMAC
// verification, no Shopify app, no shop authentication and no connection to
// any Shopify account. It feeds the shared public demo tenant only. Real
// integrations use the authenticated /v1 API with a tenant API key.
import { validateOrder } from './validate.js';

const str = (v) => (v === undefined || v === null ? '' : String(v));

/** Returns { order, external_id, source } or { problems: [...] }. */
export function mapShopifyOrder(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { problems: ['payload must be a JSON object'] };
  const ship = p.shipping_address && typeof p.shipping_address === 'object' ? p.shipping_address : {};
  const cust = p.customer && typeof p.customer === 'object' ? p.customer : {};
  const items = Array.isArray(p.line_items) ? p.line_items.filter((i) => i && typeof i === 'object') : [];
  const gateways = [...(Array.isArray(p.payment_gateway_names) ? p.payment_gateway_names : []), p.gateway].map(str).join(' ').toLowerCase();
  const cod = /\bcod\b|cash on delivery/.test(gateways) && str(p.financial_status).toLowerCase() !== 'paid';
  const problems = [];
  if (!items.length) problems.push('line_items must contain at least one item');
  if ((p.id === undefined || p.id === null || p.id === '') && !p.name) problems.push('id or name is required');
  const row = {
    buyer_name: [str(ship.first_name || cust.first_name).trim(), str(ship.last_name || cust.last_name).trim()].filter(Boolean).join(' '),
    phone: str(ship.phone || cust.phone || p.phone),
    pin: str(ship.zip).replace(/\s/g, ''),
    city: str(ship.city),
    address: [ship.address1, ship.address2].map(str).map((x) => x.trim()).filter(Boolean).join(', '),
    product: items.map((i) => `${str(i.title).slice(0, 40)}${Number(i.quantity) > 1 ? ` x${Number(i.quantity)}` : ''}`).join(', ').slice(0, 100),
    amount: p.total_price,
    payment_mode: cod ? 'cod' : 'prepaid',
  };
  const v = validateOrder(row);
  if (v.problems) problems.push(...v.problems);
  if (problems.length) return { problems };
  return {
    order: v.order,
    external_id: `shopify-${str(p.id || p.name).replace(/[^A-Za-z0-9#_-]/g, '').slice(0, 60)}`,
    source: p.source_name === 'wma-test-store' ? 'storefront' : 'shopify_demo',
  };
}
