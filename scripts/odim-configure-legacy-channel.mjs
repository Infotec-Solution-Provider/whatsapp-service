// Closed-purpose Odim pilot configuration. No provider bootstrap, subscription or source writes.
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const gate=(ok,code)=>{if(!ok)throw Error(code)},RUN='f3c51f9d-9c0a-4654-a630-36f13ce7df40',ORIGIN='172.22.139.22/crm_sgr/';
const SOURCE=String.raw`(async()=>{
 const get=async path=>{const r=await fetch('http://127.0.0.1:10001/api/odim/'+path,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('SOURCE_HTTP');return r.json()};
 const names=['mode','whatsapp_token','whatsapp_account_id'],values=await Promise.all(names.map(n=>get('parameters/'+n)));
 if(values.some((v,i)=>v.parameter_key!==names[i]||v.client_id!==values[0].client_id))throw Error('SOURCE_PARAMETER_IDENTITY');
 const health=await fetch('http://127.0.0.1:8125/health').then(r=>r.json());if(!health.sourceVerified||health.providersEnabled!==false||health.lastError)throw Error('SOURCE_HEALTH');
 process.stdout.write(JSON.stringify({parameters:values,sectors:await get('sectors'),sourceVerified:true,at:new Date().toISOString()}));
})().catch(()=>{process.stderr.write('SOURCE_EXPORT_FAILED');process.exitCode=1});`;
async function main(){
 const a=process.argv.slice(2),out=a[a.indexOf('--out')+1],apply=a.includes('--apply-reviewed-channel');gate(a.includes('--out')&&(apply||a.includes('--plan')),'ACK_REQUIRED');await preparePrivateOutput(out);
 const remote=spawnSync('ssh',['inpulse-prod','/home/inpulse/.nvm/versions/node/v22.14.0/bin/node','-'],{input:SOURCE,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024});gate(remote.status===0,'SOURCE_EXPORT_FAILED');
 let source;try{source=JSON.parse(remote.stdout)}catch{throw Error('SOURCE_EXPORT_INVALID')}
 const params=Object.fromEntries(source.parameters.map(p=>[p.parameter_key,String(p.parameter_value)]));gate(params.mode==='OFFICIAL','SOURCE_MODE_NOT_OFFICIAL');gate(/^\d+$/.test(params.whatsapp_account_id)&&params.whatsapp_token.length>30,'SOURCE_CREDENTIALS_INCOMPLETE');gate(Array.isArray(source.sectors)&&source.sectors.length===2,'SOURCE_SECTORS_CHANGED');
 const configured=source.sectors.filter(s=>/^\d{8,}$/.test(String(s.WHATSAPP_NUMERO_ID||'')));gate(configured.length===1&&Number(configured[0].CODIGO)===1,'SOURCE_CHANNEL_SET_CHANGED');
 const {loadProdEnv}=await import('file:///C:/Users/rgran/.agents/skills/investigar-producao/scripts/prod-env.mjs'),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);gate(u.hostname==='82.25.64.46'&&u.pathname==='/inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_PIN');
 const mysql=createRequire('C:/Users/rgran/.agents/skills/investigar-producao/scripts/package.json')('mysql2/promise'),db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',multipleStatements:false});
 try{
  const [[pin]]=await db.query('SELECT @@hostname host,@@server_uuid uuid');gate(pin.host==='srv733293'&&pin.uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405','IDENTITY_PIN');
  const profileCheck=spawnSync('ssh',['inpulse-prod',"sha256sum /home/inpulse/htdocs/inpulse.infotecrs.inf.br/whatsapp/config/odim-access-only.json"],{encoding:'utf8',windowsHide:true});gate(profileCheck.status===0&&profileCheck.stdout.startsWith('580dd990da186e755cd26893185b5b522963b0973c39efceae33500a598982b3 '),'ACCESS_ONLY_PROFILE_CHANGED');
  await db.beginTransaction();
  const [[run]]=await db.query('SELECT instance,status,config_json FROM instance_migration_runs WHERE id=? FOR UPDATE',[RUN]);gate(run?.instance==='odim'&&run.status==='COPY_VALIDATED','COPY_RUN_REQUIRED');
  const config=typeof run.config_json==='string'?JSON.parse(run.config_json):run.config_json;
  const [clients]=await db.query("SELECT * FROM clients WHERE instance='odim' FOR UPDATE"),[sectors]=await db.query("SELECT * FROM sectors WHERE instance='odim' FOR UPDATE"),[links]=await db.query('SELECT sc.* FROM _sector_clients sc JOIN sectors s ON s.id=sc.B WHERE s.instance=\'odim\' FOR UPDATE');
  gate(clients.length===3&&sectors.length===2,'TARGET_SET_CHANGED');
  const operations=configured.map(s=>{const clientId=config.clientIds[String(s.WHATSAPP_NUMERO_ID)],sectorId=config.sectorIds[String(s.CODIGO)],client=clients.find(c=>c.id===clientId),sector=sectors.find(t=>t.id===sectorId);gate(client?.id===13&&sector?.id===138&&client.type==='WABA'&&client.is_active===0&&client.waba_phone_id===String(s.WHATSAPP_NUMERO_ID),'CHANNEL_TARGET_CHANGED');gate(!client.waba_token&&!client.waba_account_id&&sector.default_client_id===client.id,'CHANNEL_ALREADY_CONFIGURED_OR_CHANGED');return{clientId,sectorId,phone:String(s.WHATSAPP_NUMERO||'').replace(/\D/g,''),phoneId:String(s.WHATSAPP_NUMERO_ID),name:'Odim · WhatsApp'};});
  const [maps]=await db.query('SELECT source_id,target_id FROM instance_migration_maps WHERE run_id=? AND instance=\'odim\' AND entity=\'odim-live-copy-v1/sectors\'',[RUN]);gate(operations.every(o=>maps.some(m=>m.source_id===ORIGIN+'1'&&m.target_id===o.sectorId)),'SECTOR_IDENTITY_MAP_CHANGED');
  gate(links.every(l=>clients.some(c=>c.id===l.A)),'FOREIGN_CHANNEL_LINK');
  await privateWrite(out,'before-and-intent.json',{source,clients,sectors,links,operations,legacyRemainsOwner:true,providersEnabled:false,cutover:false});
  if(!apply){await db.rollback();console.log(JSON.stringify({plan:true,sourceVerified:true,credentialKeysPresent:true,configuredChannels:operations.length,sectorLinks:operations.length,oldPlaceholderWillBeDisabled:true,providersEnabled:false,cutover:false}));return}
  for(const o of operations){
   const [update]=await db.execute("UPDATE clients SET name=?,phone=?,waba_account_id=?,waba_token=? WHERE id=? AND instance='odim' AND is_active=0 AND waba_token IS NULL AND waba_account_id IS NULL",[o.name,o.phone,params.whatsapp_account_id,params.whatsapp_token,o.clientId]);gate(update.affectedRows===1,'CHANNEL_CAS_FAILED');
   await db.execute('INSERT IGNORE INTO _sector_clients(A,B) VALUES(?,?)',[o.clientId,o.sectorId]);
  }
  // Existing client 12 and its data remain intact, but its obsolete channel cannot auto-start.
  await db.execute("UPDATE clients SET is_active=0 WHERE id=12 AND instance='odim' AND type='WABA'");
  const [after]=await db.query("SELECT id,name,is_active,waba_account_id,waba_token FROM clients WHERE instance='odim' AND id=13");gate(after.length===1&&after[0].waba_token===params.whatsapp_token&&after[0].waba_account_id===params.whatsapp_account_id&&after[0].is_active===0,'READBACK_FAILED');
  await db.commit();
  const receipt={configured:true,source:'legacy database parameters via loopback API',target:'inpulse-whatsapp.clients',clientIds:operations.map(o=>o.clientId),sectorIds:operations.map(o=>o.sectorId),credentialsMatchSource:true,oldPlaceholderDisabled:true,providersEnabled:false,legacyRemainsOwner:true,cutover:false,at:new Date().toISOString()};
  await privateWrite(out,'receipt.json',receipt);console.log(JSON.stringify(receipt));
 }catch(e){await db.rollback().catch(()=>{});throw Error(['SOURCE_MODE_NOT_OFFICIAL','SOURCE_CHANNEL_SET_CHANGED'].includes(e.message)?e.message:'CHANNEL_CONFIGURATION_FAILED_INSPECT_PRIVATE_RECEIPT')}finally{await db.end()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
