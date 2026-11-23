// Buyer page for one order, addressed by an unguessable bearer token in the URL.
// It only ever sees the narrow buyer view. Payments are SIMULATED: no money moves.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN');
const token = location.pathname.split('/').filter(Boolean).pop();
let view = null;
let flash = '';

async function call(path, body) {
  const r = await fetch(`/api/buyer/${encodeURIComponent(token)}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message ?? 'Something went wrong'), { status: r.status });
  return d;
}
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}
function miniLadder(v) {
  if (!v.ladder.length) return '';
  return `<ul class="mini-ladder" aria-label="Fee ladder">${v.ladder.map((r) => `<li class="band-${r.band}${r.band === v.risk_band ? ' active' : ''}"><b>${r.min}–${r.max}</b><span>${esc(r.label)} · ${r.fee_rs ? 'upfront, adjusted at delivery' : r.band === 'MEDIUM' ? 'free confirmation' : 'nothing to do'}</span><b>${money(r.fee_rs)}</b></li>`).join('')}</ul>`;
}
function requestText(v) {
  if (v.payment) return v.payment.type === 'full_online' ? `Paid in full online (simulated). Nothing due at delivery.` : `Upfront ${money(v.payment.amount_rs)} recorded (simulated). Pay ${money(v.payment.balance_due_rs)} at delivery.`;
  if (v.requested_action === 'pay_upfront') return `Please pay ${money(v.upfront_fee_rs)} upfront. It is adjusted against your delivery amount: you then pay ${money(v.balance_at_delivery_rs)} at the door.`;
  if (v.requested_action === 'confirm') return 'Please confirm your order. There is nothing to pay now.';
  return v.payment_mode === 'prepaid' ? 'This order is prepaid. Nothing to do.' : 'Nothing to do. The seller reviews your order before dispatch.';
}

function render() {
  const v = view;
  const cod = v.payment_mode !== 'prepaid';
  $('#app').innerHTML = `
    <div class="buyer-card">
      <p class="hint" style="margin:0">${esc(v.brand_name)} <span class="demo-tag">DEMO</span></p>
      <h1>Hi ${esc(v.buyer_first_name)}, your order ${esc(v.order_ref)}</h1>
      <dl><dt>Item</dt><dd>${esc(v.product)}</dd><dt>Value</dt><dd>${money(v.order_value_rs)}</dd><dt>Payment</dt><dd>${cod ? 'Cash on Delivery' : 'Prepaid'}</dd><dt>Address</dt><dd id="addr">${esc(v.address)}</dd></dl>
    </div>
    ${flash ? `<div class="buyer-card success" id="flash"><b>${esc(flash)}</b></div>` : ''}
    ${v.read_only ? `<div class="buyer-card"><h2>Read only</h2><p>${esc(v.status_message)}</p></div>` : ''}
    ${cod ? `<div class="buyer-card band-${esc(v.risk_band)}" id="amounts">
      <h2>What we ask</h2>
      <p id="requestText">${esc(requestText(v))}</p>
      <div class="kv-grid"><div><span>Pay now</span><b id="payNow">${money(v.pay_now_rs)}</b></div><div><span>Balance at delivery</span><b id="balance">${money(v.balance_at_delivery_rs)}</b></div></div>
      <p class="hint" style="margin:6px 0 0">Order band: <b>${esc(v.risk_band_label)}</b>. The store's fee ladder:</p>
      ${miniLadder(v)}
      <div class="buyer-actions">
        ${v.can_pay ? `<button class="primary" id="payUpfront">Pay ${money(v.upfront_fee_rs)} upfront <span class="demo-tag">DEMO</span></button>` : ''}
        ${v.can_pay && v.full_online.available ? `<button id="payFull">Pay full ${money(v.full_online.amount_rs)} online · ${v.full_online.discount_pct}% off <span class="demo-tag">DEMO</span></button>` : ''}
        ${v.can_confirm ? `<button ${v.can_pay ? '' : 'class="primary"'} id="confirmBtn">${v.requested_action === 'confirm' ? 'Yes, confirm my order' : 'Confirm without paying now'}</button>` : ''}
        ${v.your_reply ? `<p class="hint" style="margin:0">Your response is recorded: <b>${esc(v.your_reply.replace('_', ' '))}</b>. The seller still reviews your order before dispatch.</p>` : ''}
      </div>
    </div>` : ''}
    ${v.payment ? `<div class="buyer-card success" id="paymentCard"><h2>Simulated payment recorded <span class="demo-tag">DEMO</span></h2><p>${v.payment.type === 'full_online' ? `Full online ${money(v.payment.amount_rs)} (saved ${money(v.payment.discount_rs)})` : `Upfront ${money(v.payment.amount_rs)}, balance ${money(v.payment.balance_due_rs)} at delivery`} via ${esc(v.payment.app)}. Ref ${esc(v.payment.reference)}.</p><p class="hint">No money was collected. The seller still reviews your order before dispatch.</p></div>` : ''}
    ${v.can_fix_address ? `<div class="buyer-card"><h2>Fix your address</h2><form id="addrForm"><textarea name="address" rows="3" maxlength="500" required placeholder="House/flat no., street, area, landmark, city, pin">${esc(v.address)}</textarea><div class="row"><button type="submit">Save address</button></div></form></div>` : ''}
    <p class="hint">${esc(v.notice)}</p>`;
  $('#payUpfront')?.addEventListener('click', () => openSheet('upfront'));
  $('#payFull')?.addEventListener('click', () => openSheet('full_online'));
  $('#confirmBtn')?.addEventListener('click', async () => {
    try { const r = await call('/confirm', {}); view = r.view; flash = r.message; render(); } catch (e) { toast(e.message, 'err'); }
  });
  $('#addrForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await call('/address', { address: e.target.elements.address.value }); view = r.view; flash = r.message; render(); } catch (err) { toast(err.message, 'err'); }
  });
}

function openSheet(type) {
  const v = view;
  const full = type === 'full_online';
  const amount = full ? v.full_online.amount_rs : v.upfront_fee_rs;
  $('#sheetBody').innerHTML = `
    <h2 id="sheetTitle">Simulated UPI payment <span class="demo-tag">DEMO</span></h2>
    <p class="hint" style="margin:0">No money is collected. This is a sandbox simulation; no UPI app or bank is contacted.</p>
    <div class="kv-grid"><div><span>${full ? `Full amount (${v.full_online.discount_pct}% off)` : 'Upfront now'}</span><b>${money(amount)}</b></div><div><span>${full ? 'You save' : 'Balance at delivery'}</span><b>${money(full ? v.full_online.discount_rs : v.balance_at_delivery_rs)}</b></div></div>
    <p class="hint" style="margin:0">${full ? 'Nothing will be due at delivery.' : 'Adjusted against your delivery amount.'}</p>
    <div class="upi-list">${v.upi_apps.map((a, i) => `<label><input type="radio" name="upi" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}> ${esc(a.label)}</label>`).join('')}</div>
    <div class="row"><button type="button" id="sheetCancel">Cancel</button><button type="button" class="primary" id="sheetPay">Pay ${money(amount)} (demo)</button></div>`;
  $('#sheet').classList.add('open');
  $('#sheetCancel').onclick = closeSheet;
  $('#sheetPay').onclick = async () => {
    $('#sheetPay').disabled = true;
    try {
      const r = await call('/pay', { type, app: document.querySelector('input[name="upi"]:checked').value });
      view = r.view;
      flash = r.message;
      $('#sheetBody').innerHTML = `<div class="success" style="padding-left:14px"><h2 id="sheetTitle">${r.already_recorded ? 'Already recorded' : 'Demo payment recorded'} <span class="demo-tag">DEMO</span></h2><p id="sheetMessage">${esc(r.message)}</p><p class="hint">No money was collected. Your order is not confirmed for shipping until the seller reviews it.</p><div class="row"><button class="primary" type="button" id="sheetDone">Done</button></div></div>`;
      $('#sheetDone').onclick = closeSheet;
      render();
    } catch (e) {
      toast(e.message, 'err');
      $('#sheetPay').disabled = false;
    }
  };
}
function closeSheet() { $('#sheet').classList.remove('open'); }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

call('').then((v) => { view = v; render(); }).catch((e) => {
  $('#app').innerHTML = `<div class="buyer-card"><h2>${e.status === 404 ? 'This buyer link is not valid' : 'Could not load the order'}</h2><p class="hint">${esc(e.message)}</p></div>`;
});
