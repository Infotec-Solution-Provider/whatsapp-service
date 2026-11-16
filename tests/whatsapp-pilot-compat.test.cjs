const assert=require('node:assert/strict');
const r=require('../dist/operator-features/rollout.js');
const policy=()=>({allowedOperatorIds:[534],features:{operator:true,telephony:true,crm:true,whatsapp:false},effectiveAt:'2026-11-16T14:22:51.590Z',revision:'test'});
for(const userId of [1,6,9,32,534]){
  assert.doesNotThrow(()=>r.assertOperatorFeature({instance:'odim',userId},'whatsapp',()=>{throw Error('existing WhatsApp must not depend on pilot policy')}));
  assert.equal(r.operatorFeatures({instance:'odim',userId},policy).features.whatsapp,true);
  if(userId===534)assert.doesNotThrow(()=>r.assertOperatorFeature({instance:'odim',userId},'telephony',policy));
  else assert.throws(()=>r.assertOperatorFeature({instance:'odim',userId},'telephony',policy),{code:'OPERATOR_FEATURE_PILOT_REQUIRED'});
}
if(r.whatsappEligibleIds)assert.deepEqual(r.whatsappEligibleIds('odim',[1,6,9,32,534],()=>{throw Error('distribution must not depend on pilot')}),[1,6,9,32,534]);
assert.doesNotThrow(()=>r.assertOperatorFeature({instance:'exatron',userId:1},'telephony',()=>{throw Error('other tenant')}));
console.log('PASS: existing WhatsApp restored, distribution preserved, new telephony remains pilot-only');
