import assert from 'node:assert/strict';
process.env.CODGUARD_DATA_FILE=':memory:';delete process.env.ANTHROPIC_API_KEY;
const {createTenant,policyFor,setTenantPolicy}=await import('../src/tenants.js');const o=await import('../src/orders.js');const {feeFor,bandFor,validatePolicyPatch}=await import('../src/policyConfig.js');const {evaluateSellerRule}=await import('../src/policy.js');
const t=createTenant({name:'Test'}),p=policyFor(t.id);await o.seed(t.id);
const expected=[[0,'LOW'],[30,'MEDIUM'],[55,'HIGH'],[30,'MEDIUM'],[25,'LOW']];
for(const [i,x]of o.listOrders(t.id).entries()){assert.equal(x.score,expected[i][0]);assert.equal(x.risk,expected[i][1]);assert.equal(x.status,'PENDING_REVIEW');assert.equal(x.decision,null);}
for(const [score,fee,band]of [[0,0,'LOW'],[29,0,'LOW'],[30,0,'MEDIUM'],[49,0,'MEDIUM'],[50,49,'HIGH'],[69,49,'HIGH'],[70,99,'VERY_HIGH'],[84,99,'VERY_HIGH'],[85,149,'EXTREME'],[100,149,'EXTREME']]){assert.equal(feeFor(score,p),fee);assert.equal(bandFor(score,p),band);}
for(const reply of ['confirm','paid','cancel','wrong_address','no_reply']){await o.seed(t.id);const x=await o.applyReply(t.id,'CG-1003',reply);assert.equal(x.status,'PENDING_REVIEW',reply);assert.equal(x.decision,null);}
setTenantPolicy(t.id,{autoCancelSilent:false});await o.seed(t.id);await o.timeWarp(t.id,30);for(const x of o.listOrders(t.id)){assert.equal(x.status,'PENDING_REVIEW');assert.equal(x.decision,null);}assert.ok(o.getOrder(t.id,'CG-1003').silence_flagged_at);
for(const action of ['ship','hold','cancel','ship']){const x=await o.applyAction(t.id,'CG-1003',{action});assert.equal(x.decision,action);assert.equal(x.status,{ship:'SHIPPED',hold:'HOLD',cancel:'CANCELLED'}[action]);}
assert.ok(o.getOrder(t.id,'CG-1003').events.filter(e=>['ship','hold','cancel'].includes(e.type)).length>=4);
assert.equal(evaluateSellerRule('block all buyers from Jaipur').accepted,false);
const input={buyer_name:'Test Buyer',phone:'9810000001',pin:'560034',address:'Flat 4, Main Road, near bank',amount:900};const a=await o.runPipeline({...input,city:'Jaipur'},p),b=await o.runPipeline({...input,city:'Mumbai'},p);assert.equal(a.score.score,b.score.score);
const high=await o.runPipeline({...input,amount:2500,orders_same_phone_today:3},p);assert.ok(high.score.breakdown.some(x=>x.signal==='order_value'));assert.ok(high.score.breakdown.some(x=>x.signal==='phone_frequency'));
assert.throws(()=>validatePolicyPatch({},{veryHighMin:40}));assert.equal(validatePolicyPatch({},{feeExtreme:199}).feeExtreme,199);
console.log('Seed, fee boundaries, human-final decisions, silence, configurable policy and fairness passed');

setTenantPolicy(t.id,{autoCancelSilent:true});await o.seed(t.id);await o.timeWarp(t.id,25);assert.equal(o.getOrder(t.id,'CG-1003').status,'CANCELLED');assert.equal(o.getOrder(t.id,'CG-1003').decision_by,'system');await o.seed(t.id);await o.applyAction(t.id,'CG-1003',{action:'hold'});await o.timeWarp(t.id,25);assert.equal(o.getOrder(t.id,'CG-1003').status,'HOLD');

// Recorded no_reply is silence, not a response: it must NOT prevent the 24h auto-cancel.
setTenantPolicy(t.id,{autoCancelSilent:true});await o.seed(t.id);await o.applyReply(t.id,'CG-1003','no_reply');await o.timeWarp(t.id,25);
{const x=o.getOrder(t.id,'CG-1003');assert.equal(x.status,'CANCELLED');assert.equal(x.decision,'cancel');assert.equal(x.decision_by,'system');assert.ok(x.events.some(e=>e.type==='auto_cancel'));}
// Any actual buyer response prevents automatic cancellation.
for(const reply of ['paid','confirm','cancel','wrong_address']){await o.seed(t.id);await o.applyReply(t.id,'CG-1003',reply);await o.timeWarp(t.id,25);const x=o.getOrder(t.id,'CG-1003');assert.equal(x.status,'PENDING_REVIEW',reply);assert.equal(x.decision,null,reply);}
// A human decision always prevents it, even after a recorded no_reply.
await o.seed(t.id);await o.applyReply(t.id,'CG-1003','no_reply');await o.applyAction(t.id,'CG-1003',{action:'ship'});await o.timeWarp(t.id,25);assert.equal(o.getOrder(t.id,'CG-1003').decision_by,'human');assert.equal(o.getOrder(t.id,'CG-1003').status,'SHIPPED');
// No automatic shipping or holding: after the sweep, every order is undecided or system-CANCELLED (upfront-request only).
await o.seed(t.id);for(const id of ['CG-1002','CG-1004'])await o.applyReply(t.id,id,'no_reply');await o.timeWarp(t.id,48);
for(const x of o.listOrders(t.id)){if(x.decision===null){assert.equal(x.status,'PENDING_REVIEW');continue;}assert.equal(x.decision_by,'system');assert.equal(x.status,'CANCELLED');assert.ok(x.commitment_fee_rs>0);}
console.log('no_reply-as-silence auto-cancel, response/human blocks, and no auto ship/hold passed');
