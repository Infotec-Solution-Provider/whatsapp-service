// Read-only OPTIONS on the legacy CORS endpoint. Never invokes its POST handler.
require('dotenv/config');
const fs=require('node:fs'),crypto=require('node:crypto'),https=require('node:https'),mysql=require('mysql2/promise');
const RUN='f3c51f9d-9c0a-4654-a630-36f13ce7df40',ORIGIN='172.22.139.22/crm_sgr/';
(async()=>{
 const db=await mysql.createConnection({uri:process.env.WHATSAPP_DATABASE_URL,dateStrings:true});
 try{
  const [[pin]]=await db.query('SELECT @@hostname host,@@server_uuid uuid');if(pin.host!=='srv733293'||pin.uuid!=='fa36075c-fd89-11ef-b8d7-bc241123d405')throw Error('TARGET_PIN');
  const [[state]]=await db.query("SELECT message_cursor FROM odim_operational_copy_sync_state WHERE instance='odim'");let chosen;
  for(let offset=0;offset<20&&!chosen;offset++){const [rows]=await db.execute("SELECT m.waba_id id,m.timestamp FROM instance_migration_maps mp JOIN messages m ON m.id=mp.target_id AND m.instance='odim' WHERE mp.run_id=? AND mp.entity='odim-live-copy-v1/messages' AND mp.source_id=? AND m.waba_id IS NOT NULL LIMIT 1",[RUN,ORIGIN+(Number(state.message_cursor)-offset)]);chosen=rows[0]}
  if(!chosen)throw Error('EXISTING_SOURCE_WABA_MESSAGE_REQUIRED');
  const timestamp=String(Math.floor(Number(chosen.timestamp)/1000)),item={id:chosen.id,timestamp,type:'text'},entryId='odim-copy-readonly-check-20261110',phoneId='internal-noop-check';
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:entryId,changes:[{field:'messages',value:{metadata:{phone_number_id:phoneId},messages:[item]}}]}]});
  const eventId=crypto.createHash('sha256').update(JSON.stringify([entryId,phoneId,'message',chosen.id,'',timestamp])).digest('hex');
  const status=await new Promise((resolve,reject)=>{const request=https.request({hostname:'127.0.0.1',port:443,servername:'contec.inf.br',path:'/api/odim/whatsapp-cloud-api/webhook',method:'OPTIONS',headers:{Host:'contec.inf.br',Origin:'https://odim.contec.inf.br','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:10000},response=>{response.resume();response.on('end',()=>resolve(response.statusCode))});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('PROBE_TIMEOUT')));request.end(body)});
  if(status!==204)throw Error('LEGACY_CORS_STATUS_'+status);
  let observed;for(let retry=0;retry<15;retry++){const [rows]=await db.execute('SELECT state,attempts FROM odim_operational_copy_webhooks WHERE id=?',[eventId]);observed=rows[0];if(observed?.state==='APPLIED')break;await new Promise(r=>setTimeout(r,1000))}
  const receipt={legacyOptionsStatus:status,sourcePostInvoked:false,externalMessageSent:false,syntheticConversationCreated:false,existingMessageOnly:true,mirrorObserved:!!observed,state:observed?.state||'NOT_OBSERVED',at:new Date().toISOString()};
  fs.writeFileSync('/home/inpulse/odim-access-20261110/staging/usable-live-20261110/mirror-probe.sanitized.json',JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));if(observed?.state!=='APPLIED')process.exitCode=1;
 }finally{await db.end()}
})().catch(e=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_0-9]+$/.test(e.code||'')?e.code:/^[A-Z_0-9]+$/.test(e.message||'')?e.message:'SAFE_PROBE_FAILURE',externalMessageSent:false}));process.exitCode=1});
