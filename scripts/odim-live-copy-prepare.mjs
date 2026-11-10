import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const gate=(v,c)=>{if(!v)throw Error(c)},hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],ddl=await fs.readFile(new URL('./odim-live-copy-schema.sql',import.meta.url),'utf8');
 if(!a.includes('--apply-live-copy-only')){console.log(JSON.stringify({ddlSha:hash(ddl),tables:3,sourceWrites:false,providersEnabled:false}));return}
 gate(get('--ddl-sha')===hash(ddl)&&a.includes('--out'),'ACK_REQUIRED');const out=get('--out');await preparePrivateOutput(out);
 const {loadProdEnv}=await import('file:///C:/Users/rgran/.agents/skills/investigar-producao/scripts/prod-env.mjs'),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);gate(u.hostname==='82.25.64.46'&&u.pathname==='/inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_PIN');
 const mysql=createRequire('C:/Users/rgran/.agents/skills/investigar-producao/scripts/package.json')('mysql2/promise'),db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',multipleStatements:false});
 try{
  const [[pin]]=await db.query('SELECT @@hostname host,@@server_uuid uuid,VERSION() version');gate(pin.host==='srv733293'&&pin.uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405'&&pin.version==='8.0.36-28','IDENTITY_PIN');
  const [[run]]=await db.query("SELECT status FROM instance_migration_runs WHERE id='f3c51f9d-9c0a-4654-a630-36f13ce7df40' AND instance='odim'");gate(run?.status==='COPY_VALIDATED','INITIAL_COPY_REQUIRED');
  const [tables]=await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('odim_operational_copy_sync_state','odim_operational_copy_webhooks','odim_operational_copy_source_versions')");gate(!tables.length,'SCHEMA_ALREADY_EXISTS_INSPECT_FIRST');
  await privateWrite(out,'intent.json',{ddlSha:hash(ddl),tables:3,purpose:'isolated receive-only operational copy',sourceWrites:false,providersEnabled:false});
  for(const statement of ddl.trim().split(/;\s*(?:\r?\n|$)/).filter(Boolean))await db.query(statement);
  const receipt={state:'LIVE_COPY_SCHEMA_PREPARED',ddlSha:hash(ddl),tables:3,sourceWritten:false,providersEnabled:false,at:new Date().toISOString()};await privateWrite(out,'receipt.json',receipt);console.log(JSON.stringify(receipt));
 }finally{await db.end()}
}
main().catch(()=>{console.error('LIVE_COPY_SCHEMA_FAILED_INSPECT_PRIVATE_OUTPUT_NO_RETRY');process.exitCode=1});
