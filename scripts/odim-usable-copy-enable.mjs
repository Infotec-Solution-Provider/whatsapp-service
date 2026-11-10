import {createRequire} from 'node:module';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const gate=(b,e)=>{if(!b)throw Error(e)};
async function main(){
 const a=process.argv.slice(2),out=a[a.indexOf('--out')+1];gate(a.includes('--enable-normal-copy')&&a.includes('--out'),'ACK_REQUIRED');await preparePrivateOutput(out);
 const {loadProdEnv}=await import('file:///C:/Users/rgran/.agents/skills/investigar-producao/scripts/prod-env.mjs'),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);gate(u.hostname==='82.25.64.46'&&u.pathname==='/inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_PIN');
 const mysql=createRequire('C:/Users/rgran/.agents/skills/investigar-producao/scripts/package.json')('mysql2/promise'),db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',multipleStatements:false});
 try{
  const [[pin]]=await db.query('SELECT @@hostname host,@@server_uuid uuid');gate(pin.host==='srv733293'&&pin.uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405','IDENTITY_PIN');await db.beginTransaction();
  const [[run]]=await db.query("SELECT status FROM instance_migration_runs WHERE id='f3c51f9d-9c0a-4654-a630-36f13ce7df40' AND instance='odim' FOR UPDATE");gate(run&&['LIVE_COPY','COPY_VALIDATED'].includes(run.status),'COPY_RUN_REQUIRED');
  const [counts]=await db.query("SELECT entity,COUNT(*) n FROM instance_migration_maps WHERE run_id='f3c51f9d-9c0a-4654-a630-36f13ce7df40' GROUP BY entity");const count=d=>Number(counts.find(c=>c.entity==='odim-live-copy-v1/'+d)?.n||0);gate(count('contacts')===26085&&count('chats')===94699&&count('messages')>=1000,'DEPENDENCIES_REQUIRED');
  const [before]=await db.query("SELECT * FROM parameters WHERE `key` IN ('feature_odim_usable_copy_enabled','feature_legacy_history_enabled') FOR UPDATE");gate(before.length===1&&before[0].id===63&&before[0].instance==='odim'&&before[0].scope==='INSTANCE'&&before[0].value==='true','PARAMETERS_CHANGED');
  await privateWrite(out,'intent.json',{before,operation:'enable normal Odim copy; hide history menu',providersRemainBlocked:true,cutover:false});
  await db.query("INSERT INTO parameters(scope,`key`,value,instance,sectorId,userId) VALUES('INSTANCE','feature_odim_usable_copy_enabled','true','odim',NULL,NULL)");await db.query("UPDATE parameters SET value='false' WHERE id=63 AND `key`='feature_legacy_history_enabled' AND instance='odim'");await db.commit();
  await privateWrite(out,'receipt.json',{enabled:true,normalTables:true,at:new Date().toISOString(),messageCopyStillRunning:run.status==='LIVE_COPY',providersEnabled:false});console.log(JSON.stringify({normalCopyEnabled:true,historyMenuHidden:true,messagesCurrentlyMapped:count('messages'),cutover:false}));
 }catch(e){await db.rollback().catch(()=>{});throw Error('ENABLE_FAILED_INSPECT_PRIVATE_RECEIPT_NO_RETRY')}finally{await db.end()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
