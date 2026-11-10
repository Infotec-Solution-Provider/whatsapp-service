const assert=require('node:assert/strict');
let enabled=true,readOnly=true,owned=null,mapped=138,calls=[];
const stub=(p,value)=>{const id=require.resolve(p);require.cache[id]={id,filename:id,loaded:true,exports:{__esModule:true,...value}}};
stub('../dist/utils/odim-access-only',{isOdimAccessOnly:instance=>readOnly&&instance==='odim',sameTenantIdentity:(a,b)=>a===b});
stub('../dist/services/parameters.service',{default:{getInstanceBooleanParam:async(i,k,d)=>{assert.equal(i,'odim');assert.equal(k,'feature_odim_usable_copy_enabled');assert.equal(d,false);return enabled}}});
stub('../dist/services/prisma.service',{default:{
 wppSector:{findFirst:async q=>{assert.equal(q.where.instance,'odim');return owned}},
 $queryRawUnsafe:async(q,...args)=>{assert(q.includes('s.instance=m.instance'));assert.deepEqual(args.slice(1,3),['odim','odim-live-copy-v1/sectors']);assert.match(args[3],/^172\.22\.139\.22\/crm_sgr\/\d+$/);return mapped?[{target_id:mapped}]:[]},
 wppClient:{findMany:async q=>{calls.push(q);assert.deepEqual(q.select,{id:true,name:true,type:true});assert.equal(q.where.instance,'odim');assert.equal(q.where.sectors.some.instance,'odim');assert.deepEqual(q.where.WABAToken,{not:null});assert.equal(q.where.isActive,readOnly?undefined:true);return[{id:13,name:'Odim · WhatsApp',type:'WABA'}]}}
}});
(async()=>{const {getOdimCopiedSectorClients:get}=require('../dist/services/odim-operational-channel.service');
 assert.equal((await get('odim',1))[0].id,13);assert.equal(calls[0].where.sectors.some.id,138);
 owned={id:138};await get('odim',138);assert.equal(calls[1].where.sectors.some.id,138);
 readOnly=false;await get('odim',138);assert.equal(calls[2].where.isActive,true);
 owned=null;mapped=null;assert.deepEqual(await get('odim',999),[]);
 enabled=false;assert.deepEqual(await get('odim',1),[]);assert.deepEqual(await get('foreign',1),[]);
 assert.deepEqual(await get('odim',NaN),[]);assert.deepEqual(await get('odim',1.5),[]);assert.equal(calls.length,3);
 console.log(JSON.stringify({passed:true,crmSectorMapped:true,tenantIsolation:true,credentialsExcludedFromDto:true,defaultOff:true,inactivePilotChannelReadable:true,providersCalled:false}));
})().catch(e=>{console.error(e);process.exitCode=1});
