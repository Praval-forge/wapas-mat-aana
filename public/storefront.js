// Demo test store. Builds a Shopify-shaped orders/create payload and posts it to
// the DEMO simulator route. Fake data only; nothing is purchased or charged.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN');

const PRODUCTS = [
  { sku: 'WMA-DUP-01', title: 'Block-print dupatta', note: 'Cotton mul, hand block', price: 599 },
  { sku: 'WMA-KUR-02', title: 'Cotton kurta', note: 'Everyday straight fit', price: 799 },
  { sku: 'WMA-PAL-03', title: 'Palazzo pants', note: 'Rayon, flared', price: 899 },
  { sku: 'WMA-KID-04', title: 'Kids ethnic set', note: 'Kurta + pyjama, 4-6y', price: 999 },
  { sku: 'WMA-SHI-05', title: 'Linen shirt', note: 'Relaxed, full sleeve', price: 1299 },
  { sku: 'WMA-CHI-06', title: 'Chikankari top', note: 'Lucknowi embroidery', price: 1499 },
  { sku: 'WMA-NEH-07', title: 'Nehru jacket', note: 'Textured silk blend', price: 1899 },
  { sku: 'WMA-DEN-08', title: 'Denim jacket', note: 'Washed indigo', price: 2499 },
  { sku: 'WMA-SAR-09', title: 'Silk saree', note: 'Banarasi weave', price: 2999 },
];
const PINS = [
  ['560034', 'Bengaluru · Koramangala'], ['500081', 'Hyderabad · Madhapur'], ['411045', 'Pune · Baner'],
  ['110001', 'New Delhi · Connaught Place'], ['110096', 'Delhi · Shahdara'], ['302001', 'Jaipur'],
  ['400001', 'Mumbai · Fort'], ['700091', 'Kolkata · Salt Lake'], ['800001', 'Patna'], ['201010', 'Ghaziabad · Indirapuram'],
];
// Synthetic sample buyers (placeholder phone numbers, invented names and addresses).
const FILLS = {
  safe: { first_name: 'Aarav', last_name: 'Mehta', phone: '9810000001', pin: '560034', address: 'Flat 402, Sunrise Apartments, 5th Cross, 80 Feet Road, Koramangala, Bengaluru 560034', payment: 'cod', sku: 'WMA-SHI-05' },
  risky: { first_name: 'Rohit', last_name: 'Verma', phone: '9810000003', pin: '110096', address: 'Near temple, Shahdara', payment: 'cod', sku: 'WMA-SAR-09' },
  fake: { first_name: 'Test', last_name: '', phone: '9999999999', pin: '800001', address: 'xyz', payment: 'cod', sku: 'WMA-DEN-08' },
};

let selectedSku = 'WMA-KUR-02';
function renderProducts() {
  $('#products').innerHTML = PRODUCTS.map((p) => `<button type="button" class="product ${p.sku === selectedSku ? 'selected' : ''}" data-sku="${p.sku}" aria-pressed="${p.sku === selectedSku}"><b>${esc(p.title)}</b><span>${esc(p.note)}</span><strong>${money(p.price)}</strong></button>`).join('');
  document.querySelectorAll('[data-sku]').forEach((b) => (b.onclick = () => { selectedSku = b.dataset.sku; renderProducts(); }));
  const p = PRODUCTS.find((x) => x.sku === selectedSku);
  $('#selectedProduct').textContent = `${p.title} · ${money(p.price)}`;
}
$('#pinSelect').innerHTML = PINS.map(([pin, label]) => `<option value="${pin}">${esc(label)} (${pin})</option>`).join('');
document.querySelectorAll('[data-fill]').forEach((b) => (b.onclick = () => {
  const f = FILLS[b.dataset.fill];
  const form = $('#checkout');
  for (const k of ['first_name', 'last_name', 'phone', 'pin', 'address']) form.elements[k].value = f[k];
  form.querySelector(`input[name="payment"][value="${f.payment}"]`).checked = true;
  selectedSku = f.sku;
  renderProducts();
}));

function miniLadder(ladder, band) {
  if (!ladder?.length) return '';
  return `<ul class="mini-ladder">${ladder.map((r) => `<li class="band-${r.band}${r.band === band ? ' active' : ''}"><b>${r.min}–${r.max}</b><span>${esc(r.label)} · ${r.fee_rs ? 'upfront, adjusted at delivery' : r.band === 'MEDIUM' ? 'free YES confirmation' : 'no confirmation'}</span><b>${money(r.fee_rs)}</b></li>`).join('')}</ul>`;
}

$('#checkout').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const p = PRODUCTS.find((x) => x.sku === selectedSku);
  const pin = form.elements.pin.value;
  const city = PINS.find(([x]) => x === pin)[1].split(' · ')[0];
  const cod = form.querySelector('input[name="payment"]:checked').value === 'cod';
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const person = { first_name: form.elements.first_name.value.trim(), last_name: form.elements.last_name.value.trim(), phone: form.elements.phone.value.trim() };
  // Shopify-shaped "orders/create" payload (subset). Sent to the DEMO simulator only.
  const payload = {
    id, name: `#WMA${String(id).slice(-6)}`, currency: 'INR', total_price: p.price.toFixed(2), source_name: 'wma-test-store',
    financial_status: cod ? 'pending' : 'paid', gateway: cod ? 'Cash on Delivery (COD)' : 'upi_demo', payment_gateway_names: [cod ? 'Cash on Delivery (COD)' : 'upi_demo'],
    customer: person,
    shipping_address: { ...person, address1: form.elements.address.value.trim(), city, zip: pin, province: '', country: 'India', country_code: 'IN' },
    line_items: [{ sku: p.sku, title: p.title, quantity: 1, price: p.price.toFixed(2) }],
  };
  $('#placeOrder').disabled = true;
  try {
    const r = await fetch('/api/webhooks/shopify/orders-create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) throw new Error([d.error?.message, ...(d.error?.details ?? [])].filter(Boolean).join(' · '));
    const prepaid = d.payment_mode === 'prepaid';
    const band = prepaid ? 'PREPAID' : d.risk_band;
    $('#result').innerHTML = `<div class="result-card band-${band}" id="resultCard">
      <h3>Demo order ${esc(d.order_id)} placed <span class="demo-tag">DEMO</span></h3>
      <p class="hint" style="margin:0">${esc(d.notice)}</p>
      <div class="kv-grid">
        <div><span>Risk score</span><b>${d.score}/100</b></div>
        <div><span>Band</span><b>${prepaid ? 'Prepaid' : esc(d.risk_band_label)}</b></div>
        <div><span>Pay now</span><b>${prepaid ? '— (prepaid)' : money(d.pay_now_rs)}</b></div>
        <div><span>Balance at delivery</span><b>${money(d.balance_at_delivery_rs)}</b></div>
      </div>
      ${prepaid ? '<p class="hint">Prepaid orders skip COD scoring. The seller still reviews them.</p>' : miniLadder(d.fee_ladder, d.risk_band)}
      <div class="row"><a class="button primary" href="${esc(d.dashboard_path)}" target="_blank" rel="noopener">Open in dashboard ↗</a><a class="button" href="${esc(d.buyer_path)}" target="_blank" rel="noopener noreferrer">Open buyer page ↗</a></div>
      <small class="hint">External id ${esc(d.external_id)}${d.replayed ? ' · replayed (same payload id)' : ''}. Every order waits for a human Ship / Hold / Cancel.</small>
    </div>`;
  } catch (err) {
    $('#result').innerHTML = `<div class="result-card"><h3>Order not placed</h3><p>${esc(err.message)}</p></div>`;
  } finally {
    $('#placeOrder').disabled = false;
  }
};
renderProducts();
