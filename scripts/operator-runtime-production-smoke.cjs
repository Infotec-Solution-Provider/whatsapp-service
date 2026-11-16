'use strict';
// Application-owned fixture. No CRM, provider, SIP or AMI endpoint is contacted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {CONTROL,LIVE,TABLES,metadata,verifyPresent,sha}=require('./operator-runtime-migrate.cjs');
const INSTANCE='infotec',ACTOR=2147483000,REASON=2147483000;
const normalized=v=>typeof v==='bigint'?v.toString():v instanceof Date?v.toISOString():Array.isArray(v)?v.map(normalized):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalized(x)])):v;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function regular(file){const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink(),'REGULAR_FILE_REQUIRED');return s;}
function writeJson(file,value){const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});assert(!fs.lstatSync(dir).isSymbolicLink(),'RECEIPT_DIRECTORY');const tmp=file+'.tmp.'+crypto.randomUUID(),fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(normalized(value),null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
function reviewedProductionInputs(){
 const read=name=>{assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name),'INPUT_PATH');const file=path.join(CONTROL,name);regular(file);return fs.readFileSync(file);};
 const plan=JSON.parse(read('release-plan.json'));assert.equal(plan.environment,'production');assert.equal(plan.control,CONTROL);assert.equal(plan.database,'inpulse-whatsapp');assert.equal(plan.schemaVersion,1);
 const bytes=read(plan.expectedSchema.file);assert.equal(sha(bytes),plan.expectedSchema.sha256,'SCHEMA_REFERENCE_DRIFT');
 const activation=JSON.parse(read('activation-plan.json'));assert.equal(activation.environment,'production');assert.equal(activation.migrationPlanHash,sha(read('release-plan.json')),'ACTIVATION_PLAN_DRIFT');
 const target=activation.targets.find(t=>t.instance===INSTANCE);assert(target,'INFOTEC_REVIEW_REQUIRED');assert(/^[a-f0-9]{64}$/.test(target.reviewSha256),'REVIEW_HASH');assert.equal(sha(read(target.reviewFile)),target.reviewSha256,'REVIEW_DRIFT');
 const keyFile=path.join(CONTROL,'runtime-hmac.key'),s=regular(keyFile);assert.equal(s.uid,1003,'KEY_OWNER');assert.equal(s.mode&0o777,0o600,'KEY_MODE');const key=fs.readFileSync(keyFile);assert(/^[a-f0-9]{64}$/.test(key.toString()),'KEY_FORMAT');
 return{expectedSchema:JSON.parse(bytes),expectedReviewSha256:target.reviewSha256,key};
}
function createProductionSmoke(options){
 const db=options.db,control=options.control||CONTROL,receipt=path.join(control,'receipts','production-smoke.json'),environment=options.environment||'production';
 const database=options.expectedDatabase||'inpulse-whatsapp',host=options.expectedHost||'srv733293',port=options.expectedPort||3306,transport=options.transport||fetch;
 const owner=options.owner||(()=>{assert.equal(process.platform,'linux');assert.equal(process.getuid(),1003,'OWNER_UID');assert.equal(control,CONTROL,'CONTROL_SCOPE');});
 const inputs=()=>options.inputs?options.inputs():reviewedProductionInputs();
 function assertIdentity(id){assert.equal(id.database_name,database,'DATABASE_SCOPE');assert.equal(id.hostname,host,'HOST_SCOPE');assert.equal(Number(id.port),port,'PORT_SCOPE');assert(/^8\./.test(id.mysql_version),'MYSQL8_REQUIRED');}
 async function policy(tx,review){const rows=await tx.$queryRawUnsafe('SELECT enabled,schema_version,revision,review_sha256 FROM operator_runtime_policy WHERE instance=? LOCK IN SHARE MODE',INSTANCE),p=rows[0];assert(p,'POLICY_REQUIRED');assert.equal(Number(p.enabled),1,'POLICY_NOT_ENABLED');assert.equal(Number(p.schema_version),1);assert.equal(p.review_sha256,review,'POLICY_REVIEW_DRIFT');return Number(p.revision);}
 async function snapshot(){owner();const input=inputs();assert(/^[a-f0-9]{64}$/.test(input.expectedReviewSha256),'REVIEW_HASH');const current=await metadata(db);assertIdentity(current.identity);verifyPresent(current.schema,input.expectedSchema,true);return{input,current};}
 async function command(input,action,body){const target=`/api/internal/operator-runtime/${INSTANCE}/commands`,payload=JSON.stringify({operation:'operator.runtime',actorId:ACTOR,action,input:body}),timestamp=String(Date.now()),nonce=crypto.randomUUID(),signature=crypto.createHmac('sha256',input.key).update(`${timestamp}\n${nonce}\n${target}\n${payload}`).digest('hex');const response=await transport('http://127.0.0.1:8005'+target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','x-operator-timestamp':timestamp,'x-operator-nonce':nonce,'x-operator-signature':signature},body:payload});const raw=await response.text();assert(raw.length<=131072,'RESPONSE_SIZE');return{status:response.status,value:JSON.parse(raw)};}
 async function actorRows(tx){
  const out={};for(const table of TABLES.filter(t=>t!=='operator_runtime_policy')){const column=table==='operator_runtime_operations'?'actor_id':'operator_id';out[table]=await tx.$queryRawUnsafe('SELECT * FROM `'+table+'` WHERE instance=? AND `'+column+'`=?',INSTANCE,ACTOR);}return out;
 }
 function loadReceipt(){owner();regular(receipt);const state=JSON.parse(fs.readFileSync(receipt));assert.equal(state.version,1);assert.equal(state.environment,environment);assert.equal(state.instance,INSTANCE);assert.equal(state.actorId,ACTOR);assert(uuid(state.pauseOperationId)&&uuid(state.resumeOperationId)&&uuid(state.callId),'RECEIPT_UUID');assert(new Set([state.pauseOperationId,state.resumeOperationId,state.callId]).size===3);assert(/^[a-f0-9]{64}$/.test(state.reviewSha256));return state;}
 async function cleanup(){
  const state=loadReceipt();if(state.phase==='cleaned')return{cleaned:true,replayed:true};
  const {input}=await snapshot();assert.equal(input.expectedReviewSha256,state.reviewSha256,'CLEANUP_REVIEW_DRIFT');
  await db.$transaction(async tx=>{
   assertIdentity((await tx.$queryRawUnsafe('SELECT DATABASE() AS database_name,@@hostname AS hostname,@@port AS port,VERSION() AS mysql_version'))[0]);await tx.$queryRawUnsafe('SELECT instance FROM operator_runtime_policy WHERE instance=? LOCK IN SHARE MODE',INSTANCE);
   await tx.$queryRawUnsafe('SELECT operator_id FROM operator_runtime_state WHERE instance=? AND operator_id=? FOR UPDATE',INSTANCE,ACTOR);
   const rows=await actorRows(tx),states=rows.operator_runtime_state,segments=rows.operator_runtime_pause_segments,ops=rows.operator_runtime_operations,calls=rows.operator_runtime_calls;
   assert(states.length<=1&&segments.length<=1&&ops.length<=2&&calls.length<=1,'FIXTURE_ROW_COUNT');
   assert(rows.operator_runtime_call_events.length===0&&rows.operator_runtime_phone_intents.length===0&&rows.operator_runtime_web_sessions.length===0,'UNOWNED_ACTOR_ROWS');
   for(const op of ops)assert(op.kind==='pause'&&[state.pauseOperationId,state.resumeOperationId].includes(op.operation_id),'UNOWNED_OPERATION');
   for(const seg of segments)assert(seg.operation_id===state.pauseOperationId&&Number(seg.reason_id)===REASON&&seg.reason_name==='Verificação técnica de pausa'&&Number(seg.max_seconds)===0&&Number(seg.productive)===0,'UNOWNED_SEGMENT');
   for(const call of calls)assert(call.id===state.callId&&call.direction==='outgoing'&&call.number==='0'&&call.schedule_id==null&&call.customer_id==null&&call.state==='prepared'&&call.sent_at==null&&call.answered_at==null&&call.ended_at==null,'UNOWNED_CALL');
   for(const s of states){assert(['available','paused'].includes(s.state)&&[0,1,2].includes(Number(s.version))&&s.pending_schedule_id==null&&s.pending_call_id==null&&s.pending_operation_id==null&&(s.active_call_id==null||s.active_call_id===state.callId),'UNOWNED_STATE');if(s.state==='paused')assert(Number(s.reason_id)===REASON&&s.reason_name==='Verificação técnica de pausa'&&segments.some(x=>x.id===s.pause_id),'UNOWNED_PAUSE_STATE');else assert(s.pause_id==null&&s.reason_id==null,'UNOWNED_AVAILABLE_STATE');}
   const deletes=[['operator_runtime_operations','actor_id','operation_id',[state.pauseOperationId,state.resumeOperationId]],['operator_runtime_pause_segments','operator_id','operation_id',[state.pauseOperationId]],['operator_runtime_calls','operator_id','id',[state.callId]]];
   for(const[table,column,id,ids]of deletes){const n=await tx.$executeRawUnsafe('DELETE FROM `'+table+'` WHERE instance=? AND `'+column+'`=? AND `'+id+'` IN ('+ids.map(()=>'?').join(',')+')',INSTANCE,ACTOR,...ids);assert.equal(n,rows[table].length,'DELETE_ROW_GUARD');}
   const removed=await tx.$executeRawUnsafe('DELETE FROM operator_runtime_state WHERE instance=? AND operator_id=?',INSTANCE,ACTOR);assert.equal(removed,states.length,'STATE_DELETE_GUARD');
   const remaining=await actorRows(tx);assert(Object.values(remaining).every(r=>r.length===0),'FIXTURE_CLEANUP_INCOMPLETE');
  });
  state.phase='cleaned';state.cleanedAt=new Date().toISOString();writeJson(receipt,state);return{cleaned:true,actorRowsRemaining:0};
 }
 async function run(){
  owner();assert(!fs.existsSync(receipt),'SMOKE_ALREADY_STARTED');const {input,current}=await snapshot();let state;
  await db.$transaction(async tx=>{assertIdentity((await tx.$queryRawUnsafe('SELECT DATABASE() AS database_name,@@hostname AS hostname,@@port AS port,VERSION() AS mysql_version'))[0]);const revision=await policy(tx,input.expectedReviewSha256),rows=await actorRows(tx);assert(Object.values(rows).every(r=>r.length===0),'RESERVED_ACTOR_NOT_EMPTY');state={version:1,environment,instance:INSTANCE,actorId:ACTOR,phase:'prepared',at:new Date().toISOString(),reviewSha256:input.expectedReviewSha256,policyRevision:revision,schemaHash:current.schemaHash,pauseOperationId:crypto.randomUUID(),resumeOperationId:crypto.randomUUID(),callId:crypto.randomUUID(),checks:[]};writeJson(receipt,state);});
  let failure;
  try{
   let r=await command(input,'status',{});assert.equal(r.status,200);const initial=r.value.data;assert.equal(initial.authority,'central-v1');assert.equal(initial.enabled,true);assert.equal(initial.state,'available');assert.equal(initial.version,0);assert.equal(initial.policyRevision,input.expectedReviewSha256);state.checks.push('status');writeJson(receipt,state);
   const pause={operationId:state.pauseOperationId,kind:'now',expectedVersion:0,reasonSnapshot:{id:REASON,name:'Verificação técnica de pausa',maxSeconds:0,productive:false}};
   r=await command(input,'pause',pause);assert.equal(r.status,200);assert.equal(r.value.data.state,'paused');assert.equal(r.value.data.version,1);state.checks.push('pause');writeJson(receipt,state);
   r=await command(input,'pause',pause);assert.equal(r.status,200);assert.equal(r.value.data.state,'paused');assert.equal(r.value.data.version,1);state.checks.push('same-operation-replay');writeJson(receipt,state);
   r=await command(input,'prepare',{callId:state.callId,direction:'outgoing',number:'0'});assert.equal(r.status,409);assert.equal(r.value.code,'OPERATOR_PAUSED');state.checks.push('new-call-blocked-before-record');writeJson(receipt,state);
   r=await command(input,'pause',{operationId:state.resumeOperationId,kind:'resume',expectedVersion:1});assert.equal(r.status,200);assert.equal(r.value.data.state,'available');assert.equal(r.value.data.version,2);state.checks.push('resume');writeJson(receipt,state);
  }catch(error){failure=error;state.failed=true;state.phase='failed';writeJson(receipt,state);}
  let cleaned;try{cleaned=await cleanup();}catch(error){state.phase='cleanup-needs-review';writeJson(receipt,state);throw error;}
  if(failure)throw failure;return{passed:true,instance:INSTANCE,checks:state.checks,cleaned:cleaned.cleaned,actorRowsRemaining:0,crmQueries:0,providerCalls:0,sipInvites:0};
 }
 return{run,cleanup};
}
module.exports={createProductionSmoke,reviewedProductionInputs,INSTANCE,ACTOR};
if(require.main===module){(async()=>{
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),1003,'OWNER_UID');assert.equal(path.resolve(process.cwd()),path.join(LIVE,'dist'),'APPLICATION_CWD');
 const action=process.argv[2];assert(['--apply-production','--cleanup-production'].includes(action)&&process.argv.length===3,'ACTION_REQUIRED');
 const {createRequire}=require('node:module'),appRequire=createRequire(path.join(LIVE,'dist/main.js'));appRequire('dotenv/config');const {PrismaClient}=appRequire('@prisma/client'),url=process.env['WHATSAPP_DATABASE_URL'],db=new PrismaClient(url?{datasources:{db:{url}}}:{});
 try{console.log(JSON.stringify(await createProductionSmoke({db})[action==='--apply-production'?'run':'cleanup']()));}finally{await db.$disconnect();}
})().catch(error=>{console.error(JSON.stringify({error:'OPERATOR_RUNTIME_SMOKE_FAILED',code:String(error?.code||error?.name||'ERROR').replace(/[^A-Za-z0-9_]/g,'').slice(0,80)}));process.exitCode=1;});}
