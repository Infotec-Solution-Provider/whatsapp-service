// Independent read-only source snapshot. NOT a cutover export or operational migrator.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const OFFICIAL='C:/Users/rgran/.agents/skills/investigar-producao/scripts';
const TABLES=['w_setores','w_clientes_numeros','w_atendimentos','w_mensagens','w_atendimentos_historico','w_mensagens_arquivos','w_mensagens_prontas','w_mensagens_prontas_arquivos'];
const require=createRequire(path.join(OFFICIAL,'package.json'));
const mysql=require('mysql2/promise');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const gate=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const out=process.argv[process.argv.indexOf('--out')+1];
gate(process.argv.includes('--snapshot-readonly')&&process.argv.includes('--out')&&out,'EXPLICIT_READONLY_SNAPSHOT_REQUIRED');
await preparePrivateOutput(out);
let connection;
const manifest={version:1,kind:'odim-readonly-consultation-snapshot',state:'IN_PROGRESS',tenant:'odim',source:{host:'172.22.139.22',port:3306,database:'crm_sgr'},startedAt:new Date().toISOString(),operationalMigrationEligible:false,cutoverEligible:false,legacyPaused:false,sourceWritten:false,tables:[]};
try {
 const {loadProdEnv}=await import(pathToFileURL(path.join(OFFICIAL,'prod-env.mjs')).href);
 const u=new URL(loadProdEnv().PROD_SQL_TENANT_ODIM_URL);
 gate(u.protocol==='mysql:'&&u.hostname==='172.22.139.22'&&Number(u.port||3306)===3306&&decodeURIComponent(u.pathname.slice(1))==='crm_sgr','SOURCE_CONFIG_MISMATCH');
 connection=await mysql.createConnection({host:u.hostname,port:3306,database:'crm_sgr',user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,charset:'latin1_swedish_ci',multipleStatements:false,connectTimeout:15000});
 const [identity]=await connection.query('SELECT DATABASE() db,@@hostname hostname,VERSION() version');
 gate(identity[0]?.db==='crm_sgr'&&identity[0]?.hostname==='INPULSE'&&identity[0]?.version==='5.5.0-m2-community','SOURCE_IDENTITY_MISMATCH');
 const [engines]=await connection.query('SELECT TABLE_NAME name,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)',[TABLES]);
 gate(engines.length===TABLES.length&&engines.every(row=>row.engine==='InnoDB'),'SOURCE_SNAPSHOT_REQUIRES_INNODB');
 manifest.identity=identity[0];manifest.charset='latin1_swedish_ci';
 await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
 await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
 manifest.snapshotAt=new Date().toISOString();
 for(const table of TABLES){
  const [columns]=await connection.query('SHOW COLUMNS FROM `'+table+'`');
  gate(columns.some(column=>column.Field==='CODIGO'&&column.Key==='PRI'),'SOURCE_PRIMARY_KEY_UNREVIEWED');
  const [counts]=await connection.query('SELECT COUNT(*) n FROM `'+table+'`');
  const expected=Number(counts[0].n),file=table+'.ndjson',stream=await fs.open(path.join(out,file),'wx',0o600),hash=crypto.createHash('sha256');
  let last=null,count=0;
  try {
   for(;;){
    const [rows]=await connection.query('SELECT * FROM `'+table+'`'+(last===null?'':' WHERE CODIGO > ?')+' ORDER BY CODIGO ASC LIMIT 2000',last===null?[]:[last]);
    if(!rows.length)break;
    for(const row of rows){const id=Number(row.CODIGO);gate(Number.isSafeInteger(id)&&(last===null||id>Number(last)),'SOURCE_PK_ORDER_INVALID');last=id;const bytes=Buffer.from(JSON.stringify(row)+'\n');hash.update(bytes);await stream.write(bytes);count++;}
   }
   await stream.sync();
  } finally {await stream.close();}
  gate(count===expected,'SOURCE_SNAPSHOT_COUNT_MISMATCH');
  manifest.tables.push({table,file,rows:count,sha256:hash.digest('hex'),columnsSha256:sha(JSON.stringify(columns))});
  await privateWrite(out,'progress-'+table+'.json',{...manifest,updatedAt:new Date().toISOString()});
  console.log(JSON.stringify({table,rows:count,complete:true,sourceWritten:false}));
 }
 await connection.rollback();
 manifest.state='COMPLETE_READONLY_SNAPSHOT';manifest.finishedAt=new Date().toISOString();
 await privateWrite(out,'snapshot.json',manifest);
 console.log(JSON.stringify({state:manifest.state,tables:manifest.tables.map(({table,rows})=>({table,rows})),sourceWritten:false,legacyPaused:false,cutover:false}));
} catch(error){
 await connection?.rollback().catch(()=>{});
 await privateWrite(out,'failure.json',{at:new Date().toISOString(),state:'INCOMPLETE_NOT_FOR_IMPORT',code:error.safeCode||'SOURCE_OR_IO_FAILURE',sourceWritten:false,cutover:false}).catch(()=>{});
 console.error(JSON.stringify({ok:false,code:error.safeCode||'SOURCE_OR_IO_FAILURE',privateEvidence:out,sourceWritten:false}));process.exitCode=1;
} finally {await connection?.end().catch(()=>{});}
