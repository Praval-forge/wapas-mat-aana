const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let orders=[],selected=null,meta={},policy={},settings={},filter='To review';
const statusLabel=s=>({SHIPPED:'Shipped',HOLD:'On hold',CANCELLED:'Cancelled',PENDING_REVIEW:'Needs human decision'}[s]??s);
const time=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const money=n=>'₹'+Number(n).toLocaleString('en-IN');
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json'},body:opts.body&&JSON.stringify(opts.body)});const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error?.message??'Request failed'),{details:d.error?.details});return d;}
function toast(text,kind=''){const el=document.createElement('div');el.className='toast '+kind;el.textContent=text;$('#toasts').append(el);setTimeout(()=>el.remove(),4500);}
function openModal(s){$(s).classList.add('open');}function closeModals(){$$('.modal-back').forEach(x=>x.classList.remove('open'));}
$$('.modal-back').forEach(m=>m.onclick=e=>{if(e.target===m||e.target.hasAttribute('data-close'))closeModals();});
$$('.navbtn').forEach(b=>b.onclick=()=>{$$('.navbtn').forEach(x=>x.classList.toggle('active',x===b));$$('.page').forEach(x=>x.classList.toggle('active',x.id==='page-'+b.dataset.page));if(b.dataset.page==='data')renderData();});
const BAND_LABEL={LOW:'Low',MEDIUM:'Medium',HIGH:'High',VERY_HIGH:'Very high',EXTREME:'Extreme'};
const SOURCE_LABEL={seed:'Demo seed',dashboard:'Dashboard',api:'Platform API',csv:'CSV import',storefront:'Test store',shopify_demo:'Shopify simulator'};
const bandOf=o=>o.payment_mode==='prepaid'?'PREPAID':(o.risk_band??o.risk);
const bandName=o=>o.payment_mode==='prepaid'?'Prepaid':(BAND_LABEL[o.risk_band]??o.risk);
const payNow=o=>o.payment_mode==='prepaid'?'prepaid':o.payment?`paid ${money(o.payment.amount_rs)} (sim)`:`pay now ${money(o.pay_now_rs??0)}`;
const askText=o=>o.payment_mode==='prepaid'?'Prepaid · nothing to collect':o.payment?`Paid ${money(o.payment.amount_rs)} (simulated)`:o.commitment_fee_rs>0?`Pay ${money(o.commitment_fee_rs)} upfront`:o.risk==='MEDIUM'?'Free confirmation · reply YES':'No confirmation needed';
const decided=o=>!!o.decision;
const match=(o,f)=>f==='All'||f==='To review'&&!decided(o)||f==='Risky'&&o.risk!=='LOW'&&o.payment_mode!=='prepaid'||f==='Safe'&&o.risk==='LOW'&&o.payment_mode!=='prepaid'||f==='Prepaid'&&o.payment_mode==='prepaid'||f==='Decided'&&decided(o);
const visible=()=>orders.filter(o=>match(o,filter)).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
let lastSig='',knownIds=null,refreshing=false,busy=0;
function remember(list){lastSig=JSON.stringify(list);knownIds=new Set(list.map(o=>o.id));}
async function load(){[meta,orders,settings]=await Promise.all([api('/api/meta'),api('/api/orders'),api('/api/settings')]);remember(orders);policy=meta.policy;$('#brandLabel').textContent=settings.brand_name;$('#mode').textContent=meta.mode==='llm'?'LLM address check':'Rule-based address check';const qp=new URLSearchParams(location.search).get('order');if(qp&&orders.some(o=>o.id===qp)&&!selected){selected=qp;filter='All';}if(!selected||!orders.some(o=>o.id===selected))selected=visible()[0]?.id??orders[0]?.id;render();renderPlatforms();loadRules();renderPolicy();if($('#page-data').classList.contains('active'))renderData();}
function render(){renderKpis();renderRows();renderDetail();}
function renderLadder(){const o=orders.find(x=>x.id===selected);const active=o&&o.payment_mode!=='prepaid'?o.risk_band:null;$('#ladder').innerHTML=`<div class="ladder-title"><b>Fee ladder</b><small>from your current policy</small></div>`+(meta.fee_ladder??[]).map(r=>`<div class="rung band-${r.band}${active===r.band?' active':''}" data-band="${r.band}"><span class="rung-range">${r.min}–${r.max}</span><span class="rung-name">${esc(r.label)}</span><strong>${money(r.fee_rs)}</strong><small>${r.fee_rs?'upfront · adjusted at delivery':r.band==='MEDIUM'?'free · reply YES':'no confirmation'}</small></div>`).join('')+`<div class="ladder-now" id="ladderNow"><span>${o?(o.payment_mode==='prepaid'?`${esc(o.id)} · prepaid · nothing to collect`:`${esc(o.id)} · ${o.score}/100 · ${esc(bandName(o))} · pay now <b>${money(o.pay_now_rs??0)}</b> · balance at delivery <b>${money(o.balance_at_delivery_rs??o.amount)}</b>`):'Select an order'}</span></div>`;}
function renderKpis(){const cod=orders.filter(o=>o.payment_mode!=='prepaid'),flagged=cod.filter(o=>o.risk!=='LOW');const paid=orders.filter(o=>o.payment),paidSum=paid.reduce((t,o)=>t+Number(o.payment.amount_rs),0),awaiting=cod.filter(o=>!o.payment&&o.commitment_fee_rs>0&&!o.decision);const estimate=flagged.length*(settings.return_rate/100)*(settings.prevention_share/100)*settings.cost_per_return*30;$('#kpis').innerHTML=[[cod.length,'COD orders',`of ${orders.length} orders`],[flagged.length,'Flagged as risky',`${cod.length?Math.round(flagged.length/cod.length*100):0}% of COD`],[money(Math.round(paidSum)),'Simulated paid upfront',`${paid.length} paid · ${awaiting.length} awaiting · demo, not revenue`],[orders.filter(decided).length,'Decided',`of ${orders.length} orders`],[money(Math.round(estimate)),'Est. saved this month','estimate from settings · not measured']].map(([v,l,n],i)=>`<div class="kpi ${i===4?'green':''}"><span>${l}</span><strong>${v}</strong><small>${n}</small></div>`).join('');}
function renderRows(){const tabs=['To review','Risky','Safe','Prepaid','Decided','All'];$('#tabs').innerHTML=tabs.map(t=>`<button class="${filter===t?'active':''}" data-tab="${t}">${t} <span>${orders.filter(o=>match(o,t)).length}</span></button>`).join('');$$('[data-tab]').forEach(b=>b.onclick=()=>{filter=b.dataset.tab;selected=visible()[0]?.id;renderRows();renderDetail();});$('#rows').innerHTML=visible().map(o=>`<button class="order-row ${selected===o.id?'selected':''}" data-id="${esc(o.id)}"><span class="circle band-${bandOf(o)}">${o.score}</span><span class="row-name"><b>${esc(o.buyer_name)}</b><small>${esc(o.external_id??o.id)} · <em class="band-text band-${bandOf(o)}">${esc(bandName(o))}</em> · ${esc(payNow(o))} · ${money(o.amount)}</small></span><span class="queue-badge">${decided(o)?statusLabel(o.status):o.buyer_reply?'Reply: '+esc(o.buyer_reply):o.whatsapp?'Message ready':o.payment_mode==='prepaid'?'Prepaid':'Safe'}</span></button>`).join('')||'<p class="empty">No orders in this view.</p>';$$('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;renderRows();renderDetail();});}
const suggestion=o=>o.suggested_action??'wait';
function renderDetail(){renderLadder();const o=orders.find(o=>o.id===selected);if(!o){$('#detail').innerHTML='<div class="empty"><h2>You are all caught up.</h2>Select another view to see orders.</div>';return;}const h=o.steps.history,s=o.steps.score;const canReply=!!o.whatsapp;const message=o.whatsapp;const phone=String(o.phone??'').replace(/\D/g,'');const wa=message&&phone.length===10?'https://wa.me/91'+phone+'?text='+encodeURIComponent(message):null;const b=bandOf(o);const cod=o.payment_mode!=='prepaid';
$('#detail').innerHTML=`<div class="detail-title"><div><h1>${esc(o.buyer_name)}</h1><p>${esc(o.external_id??o.id)} · ${money(o.amount)} · ${cod?'COD':'Prepaid'} · ${esc(o.city)} ${esc(o.pin)}</p></div><span class="risk band-${b}">${cod?esc(bandName(o))+' band':'Prepaid'}</span></div><div class="pay-strip band-${b}" id="payStrip"><div><span>Risk score</span><b>${o.score}<small>/100</small></b></div><div><span>Band</span><b>${esc(bandName(o))}</b></div><div><span>Pay now</span><b>${cod?money(o.pay_now_rs??0):'—'}</b></div><div><span>Balance at delivery</span><b>${cod?money(o.balance_at_delivery_rs??o.amount):'₹0 (prepaid)'}</b></div><div class="wide"><span>Ask the buyer</span><b>${esc(askText(o))}</b></div></div><div class="detail-grid"><section class="panel"><label>RISK SCORE</label><div class="big-score">${o.score}<small>/ 100</small></div><div class="meter"><i class="band-${b}" style="width:${o.score}%"></i></div><div class="reasons">${s.breakdown.map(x=>`<div><b>${x.points>0?'+':''}${x.points}</b><span>${esc(x.signal.replace('_',' '))}</span></div>`).join('')||'<p>No COD risk signals.</p>'}${o.reasons.map(r=>`<small>${esc(r)}</small>`).join('')}</div></section><section class="panel"><label>ORDER</label><dl><dt>Phone</dt><dd>${esc(o.phone?'+91 '+o.phone:'Not provided')}</dd><dt>Address</dt><dd>${esc(o.address)}</dd><dt>City</dt><dd>${esc(o.city)} ${esc(o.pin)}</dd><dt>Value</dt><dd>${money(o.amount)}</dd><dt>History</dt><dd>${h.past_orders} orders, ${h.past_returns} returned</dd><dt>Today</dt><dd>${o.orders_same_phone_today??1} order(s) from this phone (IST day)</dd><dt>Source</dt><dd>${esc(SOURCE_LABEL[o.source]??o.source??'—')}</dd><dt>Payment</dt><dd>${o.payment?`${o.payment.type==='full_online'?'Full online':'Upfront'} ${money(o.payment.amount_rs)} · balance ${money(o.payment.balance_due_rs)} · simulated, no money collected`:'None recorded'}</dd><dt>Status</dt><dd>${statusLabel(o.status)}</dd></dl></section><section class="panel whatsapp"><label>BUYER MESSAGE <span class="muted">· manual send only</span></label>${message?`<div class="wa-head">${esc(settings.brand_name)} → +91 ${esc(o.phone)}</div><pre>${esc(message)}</pre>`:'<p class="hint">No message needed. A human must still decide.</p>'}<div class="row">${wa?`<a class="button primary" href="${esc(wa)}" target="_blank" rel="noopener noreferrer">Send on WhatsApp ↗</a>`:''}${o.buyer_path?`<a class="button" id="openBuyer" href="${esc(o.buyer_path)}" target="_blank" rel="noopener noreferrer">Open buyer page ↗</a>`:''}${message?'<button id="copyMessage">Copy message</button>':''}</div><small>WhatsApp opens a prefilled chat; you review and press Send yourself. The buyer page is a demo: payments are simulated.</small>${canReply?`<div class="reply"><label>RECORD BUYER REPLY · SIMULATION</label><div class="row"><button data-reply="confirm">Replied YES</button>${o.commitment_fee_rs>0&&!o.payment?`<button data-reply="paid">Paid ${money(o.commitment_fee_rs)}</button>`:''}<button data-reply="address_fixed">Address fixed</button><button data-reply="no_reply">No reply</button><button data-reply="wrong_address">Wrong address</button><button data-reply="cancel">Cancelled</button>${o.buyer_reply&&!o.payment?'<button data-clear="1" class="ghost">Clear reply</button>':''}</div></div>`:''}${o.buyer_reply?`<p>Recorded reply: <b>${esc(o.buyer_reply)}</b></p>`:''}</section><section class="panel"><label>YOUR DECISION</label><h3 class="suggestion">Tool suggests: ${esc(suggestion(o))}</h3>${o.decision?`<p class="decided-line">Decided: <b>${esc(o.decision)}</b> by ${esc(o.decision_by)}${o.decided_at?` at ${time(o.decided_at)}`:''}</p>`:''}<p class="hint">Recorded in the audit log. Only silent upfront-request orders auto-cancel after 24h when the brand toggle is ON; any human action or real reply prevents it.</p><div class="row decisions"><button class="primary" data-decision="ship">Ship <kbd>S</kbd></button><button data-decision="hold">Hold <kbd>H</kbd></button><button data-decision="cancel">Cancel <kbd>C</kbd></button>${o.decision?'<button data-undo="1">Undo <kbd>U</kbd></button>':''}</div><details><summary>Scoring evidence</summary><p>${esc(o.steps.pin_check.note)}</p><p>Address: ${esc(o.steps.address_check.reason)} (${esc(o.steps.address_check.source)})</p></details>${o.policy_notice?'<p class="notice">Blanket group rule refused. Only this order\'s signals were used.</p>':''}</section><section class="panel timeline-panel"><label>TIMELINE · ${esc(SOURCE_LABEL[o.source]??o.source??'')} · placed ${new Date(o.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} IST</label><ol class="timeline">${o.events.slice().reverse().map(e=>`<li class="ev-${esc(e.type)}"><time>${time(e.ts)}</time><span class="who">${esc(e.by??'system')}</span><span>${esc(e.text)}</span></li>`).join('')}</ol></section></div>`;
$('#copyMessage')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(message);toast('Message copied');}catch{toast('Copy unavailable. Select the message text.');}});$$('[data-reply]').forEach(x=>x.onclick=()=>mutate(`/api/orders/${o.id}/reply`,{reply:x.dataset.reply}));$$('[data-clear]').forEach(x=>x.onclick=()=>mutate(`/api/orders/${o.id}/reply`,{reply:'clear'}));$$('[data-decision]').forEach(x=>x.onclick=()=>decide(x.dataset.decision));$$('[data-undo]').forEach(x=>x.onclick=()=>undo());}
async function mutate(path,body,advance=false){busy++;try{await api(path,{method:'POST',body});const list=visible(),index=list.findIndex(o=>o.id===selected);orders=await api('/api/orders');remember(orders);if(advance)selected=list[index+1]?.id??list[index-1]?.id??selected;render();toast('Updated · saved to audit log');}catch(e){toast(e.message,'err');}finally{busy--;}}
function undo(){const o=orders.find(o=>o.id===selected);if(o?.decision)mutate(`/api/orders/${o.id}/action`,{action:'undo'});}
function decide(action){if(!selected)return;const o=orders.find(o=>o.id===selected);mutate(`/api/orders/${selected}/action`,{action,note:'Human seller decision from review queue.'},true);}
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||$('.modal-back.open')||$('.drawer-back.open')||!$('#page-dashboard').classList.contains('active'))return;const k=e.key.toLowerCase();const a={s:'ship',h:'hold',c:'cancel'}[k];if(a&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();decide(a);}if(k==='u'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();undo();}if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const list=visible(),i=list.findIndex(o=>o.id===selected);selected=list[Math.max(0,Math.min(list.length-1,i+(e.key==='ArrowDown'?1:-1)))]?.id;renderRows();renderDetail();}});
/* ---------- live refresh: every 15s while visible, never overlapping, keeps selection/filter/focus ---------- */
function focusKey(){const a=document.activeElement;if(!a||!($('#detail').contains(a)||$('#rows').contains(a)||$('#tabs').contains(a)))return null;for(const k of ['decision','reply','undo','clear','id','tab'])if(a.dataset?.[k]!==undefined)return `[data-${k}="${a.dataset[k]}"]`;return a.id?'#'+a.id:null;}
async function refreshOrders(){if(refreshing||busy||document.hidden)return;refreshing=true;try{const next=await api('/api/orders');const sig=JSON.stringify(next);if(sig===lastSig)return;const fresh=knownIds?next.filter(o=>!knownIds.has(o.id)):[];orders=next;remember(next);if(!orders.some(o=>o.id===selected))selected=visible()[0]?.id??null;const fk=focusKey(),st=[$('.queue').scrollTop,$('#detail').scrollTop];render();$('.queue').scrollTop=st[0];$('#detail').scrollTop=st[1];if(fk)document.querySelector(fk)?.focus({preventScroll:true});if($('#page-data').classList.contains('active'))renderData();for(const o of fresh.slice(0,3))toast(`New order ${o.id} · ${o.buyer_name} · ${SOURCE_LABEL[o.source]??o.source}`,'ok');if(fresh.length>3)toast(`${fresh.length-3} more new orders`,'ok');}catch{/* transient: next tick retries */}finally{refreshing=false;}}
setInterval(refreshOrders,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOrders();});
$('#newOrderBtn').onclick=()=>openModal('#orderModal');$('#newOrder').onsubmit=async e=>{e.preventDefault();try{const o=await api('/api/orders',{method:'POST',body:Object.fromEntries(new FormData(e.target))});selected=o.id;filter='All';closeModals();await load();toast('Order scored');}catch(err){toast(err.message);}};
$('#reset').onclick=async()=>{if(!confirm('Reset the shared sandbox orders?'))return;await api('/api/reset',{method:'POST'});selected=null;await load();};
$('#advance').onclick=async()=>{await api('/api/demo/advance',{method:'POST',body:{hours:13}});await load();toast('Demo clock advanced 13 hours');};
for(const [id,action]of [['shipSafe','ship_safe'],['simulate','simulate_replies'],['accept','accept_suggestions']])$('#'+id).onclick=async()=>{if(!confirm('Apply this bulk action to the shared demo orders?'))return;try{const r=await api('/api/demo/bulk',{method:'POST',body:{action}});await load();toast(`${r.changed} orders updated`);}catch(e){toast(e.message);}};
$('#settingsBtn').onclick=()=>{for(const[k,v]of Object.entries(settings))$('#settingsForm').elements[k].value=v;$('#autoCancel').checked=policy.autoCancelSilent;$('#feeInputs').innerHTML=['feeHigh','feeVeryHigh','feeExtreme'].map((k,i)=>`<label>${['High (50–69)','Very high (70–84)','Extreme (85+)'][i]}</label><input type="number" min="0" max="10000" data-fee="${k}" value="${policy[k]}">`).join('');$('#settingsDrawer').classList.add('open');};$('#helpBtn').onclick=()=>$('#helpDrawer').classList.add('open');$$('[data-dclose]').forEach(b=>b.onclick=()=>b.closest('.drawer-back').classList.remove('open'));$$('.drawer-back').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.classList.remove('open');}));
$('#settingsForm').onsubmit=async e=>{e.preventDefault();try{const fees=Object.fromEntries($$('[data-fee]').map(e=>[e.dataset.fee,Number(e.value)]));fees.autoCancelSilent=$('#autoCancel').checked;await api('/api/policy',{method:'PUT',body:fees});settings=await api('/api/settings',{method:'PUT',body:Object.fromEntries(new FormData(e.target))});await load();toast('Settings saved. New messages use the new brand name.');}catch(err){toast(err.message);}};
function parseCSV(text){const rows=[];let row=[],cell='',quote=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===','&&!quote){row.push(cell);cell='';}else if(c==='\n'&&!quote){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}if(quote)throw Error('Unclosed CSV quote');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}const headers=rows.shift()?.map(h=>h.trim().replace(/^\uFEFF/,''))??[];return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));}
let droppedFile=null;const dz=$('#dropzone');dz.onclick=()=>$('#csvFile').click();dz.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#csvFile').click();}};dz.ondragover=e=>{e.preventDefault();dz.classList.add('over');};dz.ondragleave=()=>dz.classList.remove('over');dz.ondrop=e=>{e.preventDefault();dz.classList.remove('over');const f=e.dataTransfer?.files?.[0];if(f){droppedFile=f;$('#dropName').textContent='Selected: '+f.name;}};$('#csvFile').onchange=()=>{droppedFile=null;$('#dropName').textContent=$('#csvFile').files[0]?'Selected: '+$('#csvFile').files[0].name:'';};
$('#importCsv').onclick=async()=>{try{const file=droppedFile??$('#csvFile').files[0];if(!file)throw Error('Choose or drop a CSV file');if(file.size>200000)throw Error('CSV is too large');const rows=parseCSV(await file.text());if(rows.length>100)throw Error('Maximum 100 rows');const mode=document.querySelector('input[name="csvMode"]:checked')?.value??'append';if(mode==='replace'&&!confirm(`Replace ALL ${orders.length} current orders of this shared demo account with ${rows.length} CSV row(s)? Every row is validated first; nothing is deleted if any row is invalid.`))return;const r=await api('/api/import',{method:'POST',body:{orders:rows,mode,confirm:mode==='replace'?'REPLACE':undefined}});$('#importResult').textContent=JSON.stringify(r,null,2);selected=null;await load();toast(mode==='replace'?`Replaced ${r.replaced} orders. Review row results below.`:'Import complete. Review row results below.');}catch(e){$('#importResult').textContent=e.details?JSON.stringify({error:e.message,rows:e.details},null,2):e.message;toast(e.message,'err');}};
const SAMPLE_CSV=['order_id,name,phone,address,city,pincode,order_value,payment_mode,past_orders,past_rto_count,orders_same_phone_today','SAMPLE-1,Sample Buyer One,9999900002,"Flat 12, Lake View Apartments, 5th Cross, Koramangala",Bengaluru,560034,1200,cod,4,0,1','SAMPLE-2,Sample Buyer Two,9999900003,Near bus stand,Hyderabad,500081,2400,cod,2,1,2','SAMPLE-3,Sample Buyer Three,9999900004,"House 7, MI Road, C-Scheme",Jaipur,302001,900,prepaid,1,0,1'].join('\n')+'\n';
$('#sampleCsvDownload').onclick=()=>{const url=URL.createObjectURL(new Blob([SAMPLE_CSV],{type:'text/csv'}));const a=Object.assign(document.createElement('a'),{href:url,download:'wapas-mat-aana-sample.csv'});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('#sampleCsvCopy').onclick=async()=>{try{await navigator.clipboard.writeText(SAMPLE_CSV);toast('Sample CSV copied');}catch{$('#importResult').textContent=SAMPLE_CSV;toast('Copy unavailable. Sample shown below.');}};
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
/* ---------- order data (read-only) + CSV export ---------- */
const pct=n=>n==null?'—':Math.round(n*100)+'%';
async function renderData(){$('#dataRows').innerHTML=orders.map(o=>`<tr><td>${esc(o.id)}</td><td>${esc(o.external_id??'')}</td><td>${esc(SOURCE_LABEL[o.source]??o.source??'')}</td><td>${esc(o.buyer_name)}</td><td>${esc(o.phone)}</td><td>${esc(o.city)} ${esc(o.pin)}</td><td>${money(o.amount)}</td><td>${o.payment_mode==='prepaid'?'Prepaid':'COD'}</td><td>${o.steps.history.past_orders}</td><td>${o.steps.history.past_returns}</td><td>${o.orders_same_phone_today??1}</td><td>${pct(o.steps.pin_check.return_rate)}</td><td>${esc(o.steps.address_check.address_quality)}</td><td><b>${o.score}</b></td><td><span class="band-text band-${bandOf(o)}">${esc(bandName(o))}</span></td><td>${o.payment_mode==='prepaid'?'—':money(o.pay_now_rs??0)}</td><td>${o.payment_mode==='prepaid'?'—':money(o.balance_at_delivery_rs??o.amount)}</td><td>${esc(o.buyer_reply??'')}</td><td>${o.payment?esc(o.payment.type)+' '+money(o.payment.amount_rs)+' (sim)':''}</td><td>${statusLabel(o.status)}</td><td>${esc(o.decision_by??'')}</td></tr>`).join('');try{const ref=await api('/api/reference');$('#pinRows').innerHTML=ref.pin_table.map(p=>`<tr><td>${esc(p.pin)}</td><td>${esc(p.area)}</td><td>${pct(p.return_rate)}</td><td>${p.sample_orders}</td></tr>`).join('');}catch{}}
const csvCell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
$('#exportCsv').onclick=()=>{const head=['order_id','name','phone','address','city','pincode','order_value','payment_mode','past_orders','past_rto_count','orders_same_phone_today','wma_id','source','score','risk_band','pay_now_rs','balance_at_delivery_rs','pin_return_rate','address_quality','buyer_reply','payment_type','payment_amount_rs_simulated','status','decision','decision_by'];const rows=orders.map(o=>[o.external_id??o.id,o.buyer_name,o.phone,o.address,o.city,o.pin,o.amount,o.payment_mode,o.steps.history.past_orders,o.steps.history.past_returns,o.orders_same_phone_today??1,o.id,o.source,o.score,o.payment_mode==='prepaid'?'PREPAID':o.risk_band,o.pay_now_rs??0,o.balance_at_delivery_rs??'',o.steps.pin_check.return_rate??'',o.steps.address_check.address_quality,o.buyer_reply??'',o.payment?.type??'',o.payment?.amount_rs??'',o.status,o.decision??'',o.decision_by??'']);const csv=[head,...rows].map(r=>r.map(csvCell).join(',')).join('\n')+'\n';const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=Object.assign(document.createElement('a'),{href:url,download:'wapas-mat-aana-demo-orders.csv'});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Exported synthetic demo orders');};



load().catch(e=>toast(e.message));loadAdmin();
