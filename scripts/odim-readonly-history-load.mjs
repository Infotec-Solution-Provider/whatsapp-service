import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const OFFICIAL='C:/Users/rgran/.agents/skills/investigar-producao/scripts';
const DOMAINS=['w_setores','w_clientes_numeros','w_atendimentos','w_mensagens','w_atendimentos_historico','w_mensagens_arquivos','w_mensagens_prontas','w_mensagens_prontas_arquivos'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const gate=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const fileHash=async file=>{const h=crypto.createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
export function indexedRow(domain,row){
 const int=v=>v===null||v===undefined?null:Number.isSafeInteger(Number(v))?Number(v):null;
 return [int(row.CODIGO),int(domain.endsWith('_arquivos')?row.CODIGO_MENSAGEM:row.CODIGO_ATENDIMENTO),int(row.CODIGO_NUMERO),int(row.CODIGO_OPERADOR),domain==='w_atendimentos'?Number(row.CONCLUIDO)?1:0:null,
 domain==='w_atendimentos'?row.DATA_INICIO:null,domain==='w_clientes_numeros'?String(row.NOME||'').slice(0,255):null,domain==='w_clientes_numeros'?String(row.NUMERO||'').slice(0,100):null];
}
export function validateManifest(manifest){
 gate(manifest.kind==='odim-readonly-consultation-snapshot'&&manifest.state==='COMPLETE_READONLY_SNAPSHOT'&&manifest.tenant==='odim'&&manifest.source.host==='172.22.139.22'&&manifest.source.database==='crm_sgr'&&manifest.sourceWritten===false&&manifest.cutoverEligible===false,'SNAPSHOT_SCOPE_INVALID');
 gate(manifest.tables.length===8&&new Set(manifest.tables.map(t=>t.table)).size===8&&manifest.tables.every(t=>DOMAINS.includes(t.table)&&t.file===t.table+'.ndjson'&&Number.isSafeInteger(t.rows)&&t.rows>=0&&/^[a-f0-9]{64}$/.test(t.sha256)),'SNAPSHOT_DOMAINS_INVALID');
}
async function main(){
 const a=process.argv.slice(2),arg=k=>a[a.indexOf(k)+1],out=arg('--out'),dir=arg('--snapshot');
 gate(a.includes('--out')&&a.includes('--snapshot'),'PRIVATE_PATHS_REQUIRED');await preparePrivateOutput(out);
 const manifestRaw=await fs.readFile(path.join(dir,'snapshot.json')),manifest=JSON.parse(manifestRaw);validateManifest(manifest);
 const manifestSha=hash(manifestRaw),hex=manifestSha.slice(0,32),id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
 const ddl=await fs.readFile(new URL('./odim-readonly-history-schema.sql',import.meta.url),'utf8');
 for(const table of manifest.tables)gate(await fileHash(path.join(dir,table.file))===table.sha256,'SOURCE_FILE_HASH_MISMATCH');
 const plan={version:1,kind:'odim-readonly-history-load-plan',snapshotId:id,manifestSha,ddlSha:hash(ddl),target:{host:'82.25.64.46',database:'inpulse-whatsapp'},tables:manifest.tables.map(({table,rows})=>({table,rows})),operationalTablesWritten:false,sourceWritten:false,cutover:false};
 await privateWrite(out,'plan.json',plan);
 if(!a.includes('--apply')){console.log(JSON.stringify(plan));return;}
 gate(a.includes('--ack-history-only-no-cutover')&&arg('--manifest-sha256')===manifestSha&&arg('--ddl-sha256')===hash(ddl),'REVIEWED_HASH_ACK_REQUIRED');
 const {loadProdEnv}=await import(pathToFileURL(path.join(OFFICIAL,'prod-env.mjs')).href),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);
 gate(u.hostname==='82.25.64.46'&&Number(u.port||3306)===3306&&decodeURIComponent(u.pathname.slice(1))==='inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_CONFIG_UNREVIEWED');
 const mysql=createRequire(path.join(OFFICIAL,'package.json'))('mysql2/promise');
 const db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',charset:'utf8mb4',multipleStatements:false,dateStrings:true,connectTimeout:15000});
 try {
  const [pin]=await db.query('SELECT DATABASE() db,@@hostname hostname,@@server_uuid uuid,VERSION() version');
  gate(pin[0].db==='inpulse-whatsapp'&&pin[0].hostname==='srv733293'&&pin[0].uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405'&&pin[0].version==='8.0.36-28','TARGET_IDENTITY_MISMATCH');
  const [names]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('legacy_readonly_history_snapshots','legacy_readonly_history_rows')");
  gate(names.length===0||names.length===2,'PARTIAL_SCHEMA_INSPECT_REQUIRED');
  if(!names.length){for(const sql of ddl.trim().split(/;\s*(?:\r?\n|$)/).filter(Boolean))await db.query(sql);}
  const [triggers]=await db.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('legacy_readonly_history_snapshots','legacy_readonly_history_rows')");gate(triggers.length===0,'ARCHIVE_TRIGGERS_UNREVIEWED');
  const [old]=await db.execute('SELECT manifest_sha,state FROM legacy_readonly_history_snapshots WHERE id=?',[id]);
  if(old.length)gate(old[0].manifest_sha===manifestSha&&old[0].state==='STAGED','SNAPSHOT_ALREADY_VALIDATED_OR_CHANGED');
  else await db.execute("INSERT INTO legacy_readonly_history_snapshots(id,instance,manifest_sha,source_snapshot_at,manifest,state) VALUES(?,'odim',?,?,?,'STAGED')",[id,manifestSha,manifest.snapshotAt,manifestRaw.toString()]);
  for(const table of manifest.tables){
   let scanned=0,batch=[];const actual=crypto.createHash('sha256');
   const flush=async()=>{if(!batch.length)return;await db.beginTransaction();try{
    const ids=batch.map(r=>r[2]);const [existing]=await db.query('SELECT source_id,payload_sha,SHA2(payload,256) current_sha FROM legacy_readonly_history_rows WHERE snapshot_id=? AND domain=? AND source_id IN (?)',[id,table.table,ids]);
    const map=new Map(existing.map(r=>[Number(r.source_id),r]));
    for(const row of batch){const prior=map.get(row[2]);if(prior)gate(prior.payload_sha===row.at(-1)&&prior.current_sha===prior.payload_sha,'EXISTING_ARCHIVE_ROW_CHANGED');}
    const fresh=batch.filter(r=>!map.has(r[2]));if(fresh.length)await db.query('INSERT INTO legacy_readonly_history_rows(snapshot_id,domain,source_id,parent_id,contact_id,operator_id,is_finished,started_civil,name_text,phone_text,payload,payload_sha) VALUES ?',[fresh]);
    await db.commit();batch=[];
   }catch(e){await db.rollback();throw e;}};
   const lines=readline.createInterface({input:createReadStream(path.join(dir,table.file)),crlfDelay:Infinity});
   for await(const line of lines){actual.update(line+'\n');const row=JSON.parse(line),indexed=indexedRow(table.table,row);gate(indexed[0]!==null,'INVALID_SOURCE_ID');batch.push([id,table.table,...indexed,line,hash(line)]);scanned++;if(batch.length>=2000)await flush();}
   await flush();gate(scanned===table.rows&&actual.digest('hex')===table.sha256,'SOURCE_CHANGED_DURING_LOAD');
   const [verified]=await db.execute('SELECT COUNT(*) n,SUM(payload_sha<>SHA2(payload,256)) mismatches FROM legacy_readonly_history_rows WHERE snapshot_id=? AND domain=?',[id,table.table]);
   gate(Number(verified[0].n)===scanned&&Number(verified[0].mismatches||0)===0,'ARCHIVE_VERIFY_FAILED');
   console.log(JSON.stringify({domain:table.table,rows:scanned,state:'VERIFIED',operationalTablesWritten:false}));
  }
  await db.execute("UPDATE legacy_readonly_history_snapshots SET state='VALIDATED' WHERE id=? AND state='STAGED'",[id]);
  const receipt={...plan,state:'VALIDATED_NOT_PUBLISHED',at:new Date().toISOString(),sourceStillActive:true,bytesImported:false,parametersChanged:false};await privateWrite(out,'receipt.json',receipt);console.log(JSON.stringify(receipt));
 }finally{await db.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({ok:false,code:error.safeCode||'SAFE_LOAD_FAILURE',automaticRetry:false,inspectPrivateOutput:true}));process.exitCode=1;});
