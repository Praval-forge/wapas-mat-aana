const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let orders=[],selected=null,meta={},policy={},settings={},filter='To review';
const statusLabel=s=>({SHIPPED:'Shipped',HOLD:'On hold',CANCELLED:'Cancelled',AWAITING_CONFIRMATION:'Awaiting buyer',PENDING_REVIEW:'Needs human decision'}[s]??s);
const time=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const money=n=>'₹'+Number(n).toLocaleString('en-IN');
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json'},body:opts.body&&JSON.stringify(opts.body)});const d=await r.json();if(!r.ok)throw Error(d.error?.message??'Request failed');return d;}
function toast(text,kind=''){const el=document.createElement('div');el.className='toast '+kind;el.textContent=text;$('#toasts').append(el);setTimeout(()=>el.remove(),4500);}
function openModal(s){$(s).classList.add('open');}function closeModals(){$$('.modal-back').forEach(x=>x.classList.remove('open'));}
$$('.modal-back').forEach(m=>m.onclick=e=>{if(e.target===m||e.target.hasAttribute('data-close'))closeModals();});
$$('.navbtn').forEach(b=>b.onclick=()=>{$$('.navbtn').forEach(x=>x.classList.toggle('active',x===b));$$('.page').forEach(x=>x.classList.toggle('active',x.id==='page-'+b.dataset.page));});
const decided=o=>!!o.decision;
const match=(o,f)=>f==='All'||f==='To review'&&!decided(o)||f==='Risky'&&o.risk!=='LOW'&&o.payment_mode!=='prepaid'||f==='Safe'&&o.risk==='LOW'&&o.payment_mode!=='prepaid'||f==='Prepaid'&&o.payment_mode==='prepaid'||f==='Decided'&&decided(o);
const visible=()=>orders.filter(o=>match(o,filter)).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
async function load(){[meta,orders,settings]=await Promise.all([api('/api/meta'),api('/api/orders'),api('/api/settings')]);policy=meta.policy;$('#brandLabel').textContent=settings.brand_name;$('#mode').textContent=meta.mode==='llm'?'LLM address check':'Rule-based address check';if(!selected)selected=visible()[0]?.id??orders[0]?.id;render();renderPlatforms();loadRules();renderPolicy();}
function render(){renderKpis();renderRows();renderDetail();}
function renderKpis(){const cod=orders.filter(o=>o.payment_mode!=='prepaid'),flagged=cod.filter(o=>o.risk!=='LOW'),high=flagged.filter(o=>o.risk==='HIGH');const estimate=flagged.length*(settings.return_rate/100)*(settings.prevention_share/100)*settings.cost_per_return*30;$('#kpis').innerHTML=[[cod.length,'COD orders today',`of ${orders.length} orders`],[flagged.length,'Flagged as risky',`${cod.length?Math.round(flagged.length/cod.length*100):0}% of COD`],[money(high.reduce((t,o)=>t+(o.commitment_fee_rs??0),0)),'Upfront requested',`from ${high.length} buyers · mock`],[orders.filter(decided).length,'You decided',`of ${orders.length} orders`],[money(Math.round(estimate)),'Est. saved this month','illustrative · settings-based']].map(([v,l,n],i)=>`<div class="kpi ${i===4?'green':''}"><span>${l}</span><strong>${v}</strong><small>${n}</small></div>`).join('');}
function renderRows(){const tabs=['To review','Risky','Safe','Prepaid','Decided','All'];$('#tabs').innerHTML=tabs.map(t=>`<button class="${filter===t?'active':''}" data-tab="${t}">${t} <span>${orders.filter(o=>match(o,t)).length}</span></button>`).join('');$$('[data-tab]').forEach(b=>b.onclick=()=>{filter=b.dataset.tab;selected=visible()[0]?.id;renderRows();renderDetail();});$('#rows').innerHTML=visible().map(o=>`<button class="order-row ${selected===o.id?'selected':''}" data-id="${esc(o.id)}"><span class="circle ${o.risk}">${o.score}</span><span class="row-name"><b>${esc(o.buyer_name)}</b><small>${esc(o.external_id??o.id)} · ${esc(o.city||o.pin)} · ${money(o.amount)}</small></span><span class="queue-badge">${o.payment_mode==='prepaid'?'Prepaid':decided(o)?statusLabel(o.status):o.whatsapp?'Message ready':'Safe'}</span></button>`).join('')||'<p class="empty">No orders in this view.</p>';$$('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;renderRows();renderDetail();});}
function suggestion(o){if(o.buyer_reply==='cancel')return 'cancel';if(o.buyer_reply==='wrong_address')return 'hold';if(o.buyer_reply==='no_reply'||o.silence_flagged_at)return o.risk_band==='EXTREME'?'cancel':'hold';if(o.risk==='LOW'||o.buyer_reply==='paid'||o.buyer_reply==='confirm'&&o.risk==='MEDIUM')return 'ship';return 'wait';}
function renderDetail(){const o=orders.find(o=>o.id===selected);if(!o){$('#detail').innerHTML='<div class="empty"><h2>You are all caught up.</h2>Select another view to see orders.</div>';return;}const h=o.steps.history,s=o.steps.score;const done=false,canReply=o.whatsapp&&!done&&o.status!=='HOLD';const message=o.whatsapp;const phone=o.phone.replace(/\D/g,'');const wa=phone.length===10?'https://wa.me/91'+phone+'?text='+encodeURIComponent(message):null;
$('#detail').innerHTML=`<div class="detail-title"><div><h1>${esc(o.buyer_name)}</h1><p>${esc(o.external_id??o.id)} · ${money(o.amount)} · ${o.payment_mode==='prepaid'?'Prepaid':'COD'} · ${esc(o.city)} ${esc(o.pin)}</p></div><span class="risk ${o.risk}">${o.payment_mode==='prepaid'?'Prepaid':o.risk==='HIGH'?(o.risk_band??'HIGH').replace('_',' ').toLowerCase()+' risk':o.risk==='MEDIUM'?'Medium risk':'Low risk'}</span></div><div class="detail-grid"><section class="panel"><label>RISK SCORE</label><div class="big-score">${o.score}<small>/ 100</small></div><div class="meter"><i class="${o.risk}" style="width:${o.score}%"></i></div><div class="reasons">${s.breakdown.map(b=>`<div><b>${b.points>0?'+':''}${b.points}</b><span>${esc(b.signal.replace('_',' '))}</span></div>`).join('')||'<p>No COD risk signals.</p>'}${o.reasons.map(r=>`<small>${esc(r)}</small>`).join('')}</div><div class="ask"><span>Ask the buyer</span><b>${o.risk==='HIGH'?'Pay '+money(o.commitment_fee_rs)+' upfront':o.risk==='MEDIUM'?'Reply YES':'No confirmation needed'}</b></div></section><section class="panel"><label>ORDER</label><dl><dt>Phone</dt><dd>${esc(o.phone?'+91 '+o.phone:'Not provided')}</dd><dt>Address</dt><dd>${esc(o.address)}</dd><dt>City</dt><dd>${esc(o.city)} ${esc(o.pin)}</dd><dt>Value</dt><dd>${money(o.amount)}</dd><dt>History</dt><dd>${h.past_orders} orders, ${h.past_returns} returned</dd><dt>Today</dt><dd>${o.orders_same_phone_today??1} order(s) from this phone</dd><dt>Status</dt><dd>${statusLabel(o.status)}</dd></dl></section><section class="panel whatsapp"><label>WHATSAPP <span class="muted">· manual send only</span></label>${message?`<div class="wa-head">${esc(settings.brand_name)} → +91 ${esc(o.phone)}</div><pre>${esc(message)}</pre><div class="row">${wa?`<a class="button primary" href="${esc(wa)}" target="_blank" rel="noopener noreferrer">Send on WhatsApp ↗</a>`:'<span>Phone needed for WhatsApp</span>'}<button id="copyMessage">Copy message</button></div><small>Opens a prefilled chat. Review it and press Send yourself. Payment link is a placeholder.</small>${canReply?`<div class="reply"><label>RECORD BUYER REPLY · SIMULATION</label><div class="row"><button data-reply="confirm">Replied YES</button><button data-reply="paid">Paid ${money(o.commitment_fee_rs)}</button><button data-reply="no_reply">No reply</button><button data-reply="wrong_address">Wrong address</button><button data-reply="cancel">Cancelled</button></div></div>`:''}${o.buyer_reply?`<p>Recorded reply: <b>${esc(o.buyer_reply)}</b></p>`:''}`:'<p class="hint">No message needed. Suggested: ship. A human must confirm.</p>'}</section><section class="panel"><label>YOUR DECISION</label><h3 class="suggestion">Tool suggests: ${suggestion(o)}</h3><p class="hint">Your choice is recorded in the audit log. Only silent upfront-request orders auto-cancel after 24h when the brand toggle is ON.</p><div class="row decisions"><button class="primary" data-decision="ship" ${done?'disabled':''}>Ship <kbd>S</kbd></button><button data-decision="hold" ${done?'disabled':''}>Hold <kbd>H</kbd></button><button data-decision="cancel" ${done?'disabled':''}>Cancel <kbd>C</kbd></button></div><details><summary>Scoring evidence &amp; audit log</summary><p>${esc(o.steps.pin_check.note)}</p><p>Address: ${esc(o.steps.address_check.reason)} (${esc(o.steps.address_check.source)})</p><ul>${o.events.map(e=>`<li>${time(e.ts)} · ${esc(e.text)}</li>`).join('')}</ul></details>${o.policy_notice?'<p class="notice">Blanket group rule refused. Only this order\'s signals were used.</p>':''}</section></div>`;
$('#copyMessage')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(message);toast('Message copied');}catch{toast('Copy unavailable. Select the message text.');}});$$('[data-reply]').forEach(b=>b.onclick=()=>mutate(`/api/orders/${o.id}/reply`,{reply:b.dataset.reply}));$$('[data-decision]').forEach(b=>b.onclick=()=>decide(b.dataset.decision));}
async function mutate(path,body,advance=false){try{await api(path,{method:'POST',body});const list=visible(),index=list.findIndex(o=>o.id===selected);orders=await api('/api/orders');if(advance)selected=list[index+1]?.id??list[index-1]?.id??null;render();toast('Updated · saved to audit log');}catch(e){toast(e.message,'err');}}
function decide(action){if(!selected)return;const o=orders.find(o=>o.id===selected);mutate(`/api/orders/${selected}/action`,{action,note:'Human seller decision from review queue.'},true);}
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||$('.modal-back.open')||$('.drawer-back.open')||!$('#page-dashboard').classList.contains('active'))return;const a={s:'ship',h:'hold',c:'cancel'}[e.key.toLowerCase()];if(a){e.preventDefault();decide(a);}if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const list=visible(),i=list.findIndex(o=>o.id===selected);selected=list[Math.max(0,Math.min(list.length-1,i+(e.key==='ArrowDown'?1:-1)))]?.id;renderRows();renderDetail();}});
$('#newOrderBtn').onclick=()=>openModal('#orderModal');$('#newOrder').onsubmit=async e=>{e.preventDefault();try{const o=await api('/api/orders',{method:'POST',body:Object.fromEntries(new FormData(e.target))});selected=o.id;filter='All';closeModals();await load();toast('Order scored');}catch(err){toast(err.message);}};
$('#reset').onclick=async()=>{if(!confirm('Reset the shared sandbox orders?'))return;await api('/api/reset',{method:'POST'});selected=null;await load();};
$('#advance').onclick=async()=>{await api('/api/demo/advance',{method:'POST',body:{hours:13}});await load();toast('Demo clock advanced 13 hours');};
for(const [id,action]of [['shipSafe','ship_safe'],['simulate','simulate_replies'],['accept','accept_suggestions']])$('#'+id).onclick=async()=>{if(!confirm('Apply this bulk action to the shared demo orders?'))return;try{const r=await api('/api/demo/bulk',{method:'POST',body:{action}});await load();toast(`${r.changed} orders updated`);}catch(e){toast(e.message);}};
$('#settingsBtn').onclick=()=>{for(const[k,v]of Object.entries(settings))$('#settingsForm').elements[k].value=v;$('#autoCancel').checked=policy.autoCancelSilent;$('#feeInputs').innerHTML=['feeHigh','feeVeryHigh','feeExtreme'].map((k,i)=>`<label>${['High (50–69)','Very high (70–84)','Extreme (85+)'][i]}</label><input type="number" min="0" max="10000" data-fee="${k}" value="${policy[k]}">`).join('');$('#settingsDrawer').classList.add('open');};$('#helpBtn').onclick=()=>$('#helpDrawer').classList.add('open');$$('[data-dclose]').forEach(b=>b.onclick=()=>b.closest('.drawer-back').classList.remove('open'));$$('.drawer-back').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.classList.remove('open');}));
$('#settingsForm').onsubmit=async e=>{e.preventDefault();try{const fees=Object.fromEntries($$('[data-fee]').map(e=>[e.dataset.fee,Number(e.value)]));fees.autoCancelSilent=$('#autoCancel').checked;await api('/api/policy',{method:'PUT',body:fees});settings=await api('/api/settings',{method:'PUT',body:Object.fromEntries(new FormData(e.target))});await load();toast('Settings saved. New messages use the new brand name.');}catch(err){toast(err.message);}};
function parseCSV(text){const rows=[];let row=[],cell='',quote=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===','&&!quote){row.push(cell);cell='';}else if(c==='\n'&&!quote){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}if(quote)throw Error('Unclosed CSV quote');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}const headers=rows.shift()?.map(h=>h.trim().replace(/^\uFEFF/,''))??[];return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));}
$('#importCsv').onclick=async()=>{try{const file=$('#csvFile').files[0];if(!file)throw Error('Choose a CSV file');if(file.size>200000)throw Error('CSV is too large');const rows=parseCSV(await file.text());if(rows.length>100)throw Error('Maximum 100 rows');const r=await api('/api/import',{method:'POST',body:{orders:rows}});$('#importResult').textContent=JSON.stringify(r,null,2);await load();toast('Import complete. Review row results below.');}catch(e){toast(e.message);}};
function renderPolicy(){$('#policy').innerHTML=`<p class="hint">LOW 0–${policy.lowMax}: suggest ship. MEDIUM ${policy.lowMax+1}–${policy.mediumMax}: reply YES. HIGH ${policy.mediumMax+1}–${policy.veryHighMin-1}: ₹${policy.feeHigh}; VERY HIGH ${policy.veryHighMin}–${policy.extremeMin-1}: ₹${policy.feeVeryHigh}; EXTREME ${policy.extremeMin}+: ₹${policy.feeExtreme}. All orders await a human decision. Exception: silent upfront-request orders auto-cancel after 24h if enabled (${policy.autoCancelSilent?'ON':'OFF'}). A manual decision prevents it. Reminder at ${policy.reminderAfterHours}h.</p>`;}
async function loadRules(){const r=await api('/api/seller-rules');$('#rules').textContent=r.length?`${r.length} blanket group rule(s) refused.`:'No blanket rules accepted.';}$('#ruleForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/seller-rules',{method:'POST',body:{text:$('#ruleText').value}});}catch{toast('Blanket group rule refused');}loadRules();};
/* ---------- platforms page ---------- */
function renderPlatforms() {
  const base = location.origin;
  const key = meta.demo_api_key;
  $('#demoKey').textContent = key;
  $('#curlIngest').textContent =
`curl -X POST ${base}/v1/orders \\
  -H "X-API-Key: ${key}" -H "content-type: application/json" \\
  -d '{"buyer_name":"Neha Gupta","phone":"9999900000","pin":"560034",
       "address":"Flat 7B, Lake View Residency, 12th Main Road, HSR Layout",
       "product":"Cotton kurta","amount":1200,"external_id":"SWG-88731"}'`;
  $('#curlReply').textContent =
`curl -X POST ${base}/v1/orders/CG-1006/buyer-reply \\
  -H "X-API-Key: ${key}" -H "content-type: application/json" \\
  -d '{"reply":"confirm"}'   # confirm | paid | cancel | no_reply`;
  $('#curlHook').textContent =
`curl -X POST ${base}/v1/webhooks \\
  -H "X-API-Key: ${key}" -H "content-type: application/json" \\
  -d '{"url":"https://your-app.example/codguard","events":["order.status_changed"]}'
# Deliveries are signed: X-CODGuard-Signature: sha256=<hmac of body, your secret>`;
}

/* ---------- admin console ---------- */
let adminKey = sessionStorage.getItem('cg_admin') || '';
async function adminApi(path, opts) {
  const r = await fetch(path, { ...(opts ?? {}), headers: { 'content-type': 'application/json', 'X-Admin-Key': adminKey }, body: opts?.body && JSON.stringify(opts.body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message ?? r.statusText);
  return data;
}
async function loadAdmin() {
  if (!adminKey) return;
  try {
    const { tenants } = await adminApi('/admin/api/tenants');
    $('#adminLogin').style.display = 'none';
    $('#adminConsole').style.display = 'block';
    $('#tenants').innerHTML = tenants.map((t) => `
      <div class="tenant-block">
        <div class="row" style="justify-content:space-between;margin:0 0 6px">
          <div><h3>${esc(t.name)}</h3><span class="kv">${esc(t.id)} · plan <b>${esc(t.plan)}</b> · ${t.orders_this_month} orders this month</span></div>
          <form class="row keygen" data-tenant="${esc(t.id)}" style="margin:0">
            <input placeholder="Key label" style="width:150px" name="label">
            <select name="kind" style="width:90px"><option value="test">test</option><option value="live">live</option></select>
            <button type="submit">+ Issue key</button>
          </form>
        </div>
        ${t.keys.length ? t.keys.map((k) => `
          <div class="keyrow">
            <span class="mono">${esc(k.prefix)}…</span>
            <span class="pill kind-${k.kind}">${k.kind}</span>
            <span class="grow kv">${esc(k.label || '(no label)')} · created ${new Date(k.created_at).toLocaleDateString()}${k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ''}${k.revoked_at ? ' · <b>revoked</b>' : ''}</span>
            ${k.revoked_at ? '' : `<button data-rotate="${esc(k.id)}">Rotate</button><button class="danger" data-revoke="${esc(k.id)}">Revoke</button>`}
          </div>`).join('') : '<p class="kv">No keys yet.</p>'}
      </div>`).join('');
    $$('.keygen').forEach((f) => (f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      try {
        const k = await adminApi(`/admin/api/tenants/${f.dataset.tenant}/keys`, { method: 'POST', body: { label: fd.get('label'), kind: fd.get('kind') } });
        showKey(k.key);
        loadAdmin();
      } catch (err) { toast(err.message, 'err'); }
    }));
    $$('[data-rotate]').forEach((b) => (b.onclick = async () => {
      try { const r = await adminApi(`/admin/api/keys/${b.dataset.rotate}/rotate`, { method: 'POST' }); showKey(r.key.key); loadAdmin(); }
      catch (err) { toast(err.message, 'err'); }
    }));
    $$('[data-revoke]').forEach((b) => (b.onclick = async () => {
      try { await adminApi(`/admin/api/keys/${b.dataset.revoke}/revoke`, { method: 'POST' }); toast('Key revoked', 'ok'); loadAdmin(); }
      catch (err) { toast(err.message, 'err'); }
    }));
  } catch (e) {
    sessionStorage.removeItem('cg_admin');
    adminKey = '';
    $('#adminLogin').style.display = 'block';
    $('#adminConsole').style.display = 'none';
    if (e.message !== 'Invalid admin key.') toast(e.message, 'err');
  }
}
function showKey(full) {
  $('#keyReveal').textContent = full;
  openModal('#keyModal');
}
$('#copyKey').onclick = async () => {
  try { await navigator.clipboard.writeText($('#keyReveal').textContent); toast('Copied', 'ok'); } catch { toast('Select and copy manually', 'err'); }
};
$('#adminForm').onsubmit = (e) => {
  e.preventDefault();
  adminKey = $('#adminKey').value.trim();
  sessionStorage.setItem('cg_admin', adminKey);
  loadAdmin();
};
$('#tenantForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await adminApi('/admin/api/tenants', { method: 'POST', body: { name: $('#tenantName').value, plan: $('#tenantPlan').value } });
    $('#tenantName').value = '';
    toast('Tenant created', 'ok');
    loadAdmin();
  } catch (err) { toast(err.message, 'err'); }
};



load().catch(e=>toast(e.message));loadAdmin();
