import {createRequire} from 'node:module';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const RUN='f3c51f9d-9c0a-4654-a630-36f13ce7df40',SNAP='d60d646d-a75b-db65-c5fa-eb346177f2e7',ENTITY='odim-live-copy-v1/messages';
const gate=(b,e)=>{if(!b)throw Error(e)};
async function main(){
 const args=process.argv.slice(2),out=args[args.indexOf('--out')+1];gate(args.includes('--repair-copied-timestamps-only')&&args.includes('--out'),'ACK_REQUIRED');await preparePrivateOutput(out);
 const {loadProdEnv}=await import('file:///C:/Users/rgran/.agents/skills/investigar-producao/scripts/prod-env.mjs'),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);gate(u.hostname==='82.25.64.46'&&u.pathname==='/inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_PIN');
 const mysql=createRequire('C:/Users/rgran/.agents/skills/investigar-producao/scripts/package.json')('mysql2/promise'),db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',multipleStatements:false});
 try{
  const [[pin]]=await db.query('SELECT @@hostname host,@@server_uuid uuid,VERSION() version');gate(pin.host==='srv733293'&&pin.uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405'&&pin.version==='8.0.36-28','IDENTITY_PIN');
  const [[run]]=await db.execute('SELECT status,config_json FROM instance_migration_runs WHERE id=? AND instance=\'odim\'',[RUN]);gate(run?.status==='COPY_VALIDATED','WAIT_INITIAL_COPY_COMPLETE');const config=typeof run.config_json==='string'?JSON.parse(run.config_json):run.config_json;const {base,end}=config.ranges.messages;gate(Number.isSafeInteger(base)&&Number.isSafeInteger(end)&&end-base===688145,'RANGE_PIN');
  const [indexes]=await db.query("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='instance_migration_maps' AND INDEX_NAME='copy_run_entity_target' ORDER BY SEQ_IN_INDEX");gate(!indexes.length||indexes.map(i=>i.COLUMN_NAME).join(',')==='run_id,entity,target_id','INDEX_DRIFT');
  await privateWrite(out,'intent.json',{runId:RUN,snapshot:SNAP,range:{base,end},scope:'copied rows only; restore exact source Unix in milliseconds',sourceWritten:false,existingReusedMessagesExcluded:true,indexAdded:!indexes.length});
  if(!indexes.length)await db.query('ALTER TABLE instance_migration_maps ADD INDEX copy_run_entity_target(run_id,entity,target_id), ALGORITHM=INPLACE, LOCK=NONE');
  const raw="CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.TIMESTAMP')) AS UNSIGNED)",expected=`CAST(CASE WHEN ${raw}>10000000000 THEN ${raw} ELSE ${raw}*1000 END AS CHAR)`;
  const join=" FROM messages m JOIN instance_migration_maps mp FORCE INDEX(copy_run_entity_target) ON mp.target_id=m.id AND mp.run_id=? AND mp.entity=? JOIN legacy_readonly_history_rows r ON r.snapshot_id=? AND r.domain='w_mensagens' AND r.source_id=CAST(SUBSTRING_INDEX(mp.source_id,'/',-1) AS UNSIGNED)";
  let changed=0;
  for(let upper=end;upper>base;upper-=5000){const lower=Math.max(base,upper-5000),values=[RUN,ENTITY,SNAP,lower,upper];
   const [before]=await db.query('SELECT m.id,m.timestamp'+join+` WHERE m.instance='odim' AND m.id>? AND m.id<=? AND m.timestamp<>${expected}`,values);if(!before.length)continue;
   await privateWrite(out,'before-'+upper+'.json',before);
   const [result]=await db.query('UPDATE messages m JOIN instance_migration_maps mp FORCE INDEX(copy_run_entity_target) ON mp.target_id=m.id AND mp.run_id=? AND mp.entity=? JOIN legacy_readonly_history_rows r ON r.snapshot_id=? AND r.domain=\'w_mensagens\' AND r.source_id=CAST(SUBSTRING_INDEX(mp.source_id,\'/\',-1) AS UNSIGNED) SET m.timestamp='+expected+` WHERE m.instance='odim' AND m.id>? AND m.id<=? AND m.timestamp<>${expected}`,values);
   changed+=result.affectedRows;if(changed%50000<5000)console.log(JSON.stringify({changed,unit:'milliseconds',sourceWritten:false}));
  }
  const [[remaining]]=await db.query('SELECT COUNT(*) n'+join+` WHERE m.instance='odim' AND m.id>? AND m.id<=? AND m.timestamp<>${expected}`,[RUN,ENTITY,SNAP,base,end]);gate(Number(remaining.n)===0,'TIMESTAMP_VALIDATION_FAILED');
  const receipt={state:'TIMESTAMPS_VALIDATED',changed,remaining:0,existingRowsOutsideCopyRangeWritten:false,sourceWritten:false,at:new Date().toISOString()};await privateWrite(out,'receipt.json',receipt);console.log(JSON.stringify(receipt));
 }finally{await db.end()}
}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:['WAIT_INITIAL_COPY_COMPLETE','TIMESTAMP_VALIDATION_FAILED'].includes(e.message)?e.message:'REPAIR_FAILED_INSPECT_PRIVATE_OUTPUT',automaticRetry:false}));process.exitCode=1});
