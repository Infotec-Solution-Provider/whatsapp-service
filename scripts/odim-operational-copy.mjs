import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const SNAPSHOT='d60d646da75bdb65c5faeb346177f2e7346788cb71e31b40e87f2742d7a0a8b5';
const RUN='f3c51f9d-9c0a-4654-a630-36f13ce7df40',ORIGIN='172.22.139.22/crm_sgr/',PREFIX='odim-live-copy-v1/';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),gate=(b,e)=>{if(!b)throw Object.assign(Error(e),{safeCode:e})};
const sid=r=>String(r.CODIGO),digits=v=>String(v??'').replace(/\D/g,''),decode=v=>{try{return decodeURI(String(v??''))}catch{return String(v??'')}};
export function priority(r){const value=[r.URGENCIA_SUPERVISOR,r.URGENCIA_AGENDAMENTO,r.URGENCIA_OPERADOR].find(v=>v!=null&&v!=='');return({NORMAL:'NORMAL',MEDIA:'NORMAL',ALTA:'HIGH',MUITO_ALTA:'VERY_HIGH',URGENTE:'URGENCY'})[value]||'NORMAL'}
export function messageTime(r){const raw=Number(r.TIMESTAMP),milliseconds=raw>10000000000?raw:raw*1000;gate(Number.isSafeInteger(milliseconds)&&milliseconds>=0&&milliseconds<=4102444800000,'INVALID_MESSAGE_UNIX');return{timestamp:String(milliseconds),sentAt:new Date(milliseconds).toISOString().slice(0,19).replace('T',' ')}}
export function status(v){return({PLAYED:'READ',UNKNOWN_4:'UNKNOWN'})[v]||(['PENDING','SENT','RECEIVED','READ','DOWNLOADED','ERROR','REVOKED','UNKNOWN'].includes(v)?v:'UNKNOWN')}
async function* rows(dir,domain){for await(const line of readline.createInterface({input:createReadStream(path.join(dir,domain+'.ndjson')),crlfDelay:Infinity})){if(line)yield{raw:JSON.parse(line),fingerprint:hash(line)}}}
async function fileHash(file){const h=crypto.createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex')}
function fence(){const raw=execFileSync('ssh',['inpulse-prod','curl --silent --fail http://127.0.0.1:8005/health'],{encoding:'utf8',windowsHide:true,timeout:15000});const v=JSON.parse(raw);gate(v.service==='whatsapp'&&v.odimAccessOnly===true&&v.odimAccessOnlyProfile==='valid','PROVIDER_FENCE_REQUIRED')}
async function main(){
 const a=process.argv.slice(2),arg=k=>a[a.indexOf(k)+1],dir=arg('--snapshot'),out=arg('--out');gate(a.includes('--snapshot')&&a.includes('--out'),'PRIVATE_PATHS_REQUIRED');await preparePrivateOutput(out);
 const manifestRaw=await fs.readFile(path.join(dir,'snapshot.json'));gate(hash(manifestRaw)===SNAPSHOT,'SOURCE_MANIFEST_PIN');const manifest=JSON.parse(manifestRaw);
 for(const t of manifest.tables)gate(await fileHash(path.join(dir,t.file))===t.sha256,'SOURCE_HASH_MISMATCH');
 const contacts=[],chats=[],sectors=[];for await(const r of rows(dir,'w_clientes_numeros'))contacts.push(r);for await(const r of rows(dir,'w_atendimentos'))chats.push(r);for await(const r of rows(dir,'w_setores'))sectors.push(r);
 const native=new Map(),messageRanks=new Map();let rank=0;
 for await(const {raw:r}of rows(dir,'w_mensagens')){const time=messageTime(r);messageRanks.set(sid(r),++rank);if(r.ID){const id=String(r.ID);gate(id.length<=191&&!native.has(id.toLowerCase()),'SOURCE_NATIVE_ID_AMBIGUOUS');native.set(id.toLowerCase(),{rank,id,sourceId:sid(r),bodySha:hash(decode(r.MENSAGEM)),timestamp:time.timestamp,fromMe:Number(r.FROM_ME)===1})}}
 const plan={runId:RUN,kind:'usable-operational-copy-no-cutover',sourceManifest:SNAPSHOT,source:ORIGIN,order:['contacts','chats','messages-newest-first'],counts:{contacts:contacts.length,chats:chats.length,messages:rank},civilChatDates:'NULL pending verified timezone; original values retained in immutable archive',messageDates:'explicit Unix timestamp',providersEnabled:false,sourceWrites:false,operationalCopy:true,cutover:false};await privateWrite(out,'plan.json',plan);console.log(JSON.stringify(plan));if(!a.includes('--apply-usable-copy'))return;
 gate(a.includes('--ack-keep-legacy-channel')&&arg('--manifest-sha')===SNAPSHOT,'APPLY_ACK_REQUIRED');fence();
 const official='C:/Users/rgran/.agents/skills/investigar-producao/scripts', {loadProdEnv}=await import('file:///'+official+'/prod-env.mjs'),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);gate(u.hostname==='82.25.64.46'&&u.pathname==='/inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_PIN');
 const mysql=createRequire(path.join(official,'package.json'))('mysql2/promise'),db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',charset:'utf8mb4',timezone:'Z',multipleStatements:false,dateStrings:true});let stage='identity';
 try{
  const [pin]=await db.query('SELECT DATABASE() db,@@hostname host,@@server_uuid uuid,VERSION() version,@@auto_increment_increment inc');gate(pin[0].db==='inpulse-whatsapp'&&pin[0].host==='srv733293'&&pin[0].uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405'&&pin[0].version==='8.0.36-28'&&pin[0].inc===1,'IDENTITY_PIN');
  const [[lock]]=await db.query("SELECT GET_LOCK('odim-operational-copy-v1',0) held");gate(lock.held===1,'COPY_ALREADY_RUNNING');
  const [triggers]=await db.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('contacts','chats','messages','instance_migration_runs','instance_migration_maps')");gate(triggers.length===6&&triggers.every(r=>/^session_changes_(messages|chats)_(insert|update|delete)$/.test(r.TRIGGER_NAME)),'TRIGGER_SET_CHANGED_REVIEW_REQUIRED');
  const [old]=await db.execute('SELECT status,config_json FROM instance_migration_runs WHERE id=?',[RUN]);let config;
  if(!old.length){
   const [oldContacts]=await db.query("SELECT * FROM contacts WHERE instance='odim'");const [oldMessages]=await db.query("SELECT * FROM messages WHERE instance='odim'");
   const [[counts]]=await db.query("SELECT (SELECT COUNT(*) FROM chats WHERE instance='odim') chats,(SELECT COUNT(*) FROM contacts WHERE instance='odim') contacts,(SELECT COUNT(*) FROM messages WHERE instance='odim') messages");gate(Number(counts.chats)===0&&Number(counts.contacts)===149&&Number(counts.messages)===1317,'INITIAL_TARGET_CHANGED_REVIEW_REQUIRED');
   const existingMessages={},nativeVariants={},reconciled=[];
   for(const m of oldMessages){const source=[m.waba_id,m.wwebjs_id].map(id=>id&&native.get(String(id).toLowerCase())).find(Boolean);if(!source)continue;
    const sameBody=source.bodySha===hash(String(m.body??'')),sameTime=source.timestamp===messageTime({TIMESTAMP:m.timestamp}).timestamp,sameDirection=source.fromMe===/^(me:|user:|bot:)/.test(m.from);
    reconciled.push({sourceId:source.sourceId,targetId:m.id,sameBody,sameTime,sameDirection});if(sameBody&&sameTime&&sameDirection)existingMessages[source.sourceId]=m.id;else if(sameTime&&sameDirection)nativeVariants[source.sourceId]=m.id;
   }
   await privateWrite(out,'native-reconciliation.json',reconciled);console.log(JSON.stringify({stage:'native-reconciliation',matchingNativeIds:reconciled.length,provenIdentical:Object.keys(existingMessages).length,unresolved:reconciled.length-Object.keys(existingMessages).length}));
   gate(reconciled.length===Object.keys(existingMessages).length+Object.keys(nativeVariants).length,'EXISTING_NATIVE_IDENTITY_CONFLICT');
   await privateWrite(out,'target-before.json',{contacts:oldContacts,messages:oldMessages});
   const reuse={},sourcePhones=new Map(),sourceIds=new Map();for(const {raw:r}of contacts){const phone=digits(r.NUMERO),wa=digits(r.IDENTIFICADOR)||phone;sourcePhones.set(phone,(sourcePhones.get(phone)||0)+1);sourceIds.set(wa,(sourceIds.get(wa)||0)+1)}
   for(const {raw:r}of contacts){const phone=digits(r.NUMERO),wa=digits(r.IDENTIFICADOR)||phone;const found=oldContacts.filter(c=>(c.whatsapp_id&&digits(c.whatsapp_id)===wa)||(c.phone&&digits(c.phone)===phone));if(found.length===1&&(!found[0].whatsapp_id||digits(found[0].whatsapp_id)===wa))reuse[sid(r)]=found[0].id}
   const ranges={};for(const [table,n]of Object.entries(plan.counts)){const [[v]]=await db.query(`SELECT COALESCE(MAX(id),0) maxId FROM ${table}`);gate(Number(v.maxId)+n+10000<2147483647,'ID_CAPACITY');ranges[table]={base:Number(v.maxId)+10000,end:Number(v.maxId)+10000+n};}
   config={...plan,ranges,reuse,existingMessages,nativeVariants,oldContacts:oldContacts.map(c=>({id:c.id,phone:c.phone,whatsapp_id:c.whatsapp_id})),stage:'RESERVING',clientIds:{},sectorIds:{}};
   await privateWrite(out,'reservation-intent.json',config);
   await db.execute("INSERT INTO instance_migration_runs(id,instance,status,current_phase,config_json,updated_at) VALUES(?,'odim','LIVE_COPY','RESERVING',?,UTC_TIMESTAMP(3))",[RUN,JSON.stringify(config)]);
  }else{gate(a.includes('--resume')&&old[0].status==='LIVE_COPY','EXPLICIT_RESUME_REQUIRED');config=typeof old[0].config_json==='string'?JSON.parse(old[0].config_json):old[0].config_json;gate(config.sourceManifest===SNAPSHOT,'RESUME_SOURCE_MISMATCH')}
  for(const [table,r]of Object.entries(config.ranges)){if(config.stage==='RESERVING'){await db.query(`ALTER TABLE ${table} AUTO_INCREMENT=${r.end+1}`);const [[v]]=await db.query(`SELECT COUNT(*) n FROM ${table} WHERE id>? AND id<=?`,[r.base,r.end]);gate(Number(v.n)===0,'RESERVATION_COLLISION');}}
  config.stage='COPYING';await db.execute("UPDATE instance_migration_runs SET current_phase='COPYING',config_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[JSON.stringify(config),RUN]);
  const maps=new Map();const [saved]=await db.execute('SELECT entity,source_id,target_id,source_fingerprint FROM instance_migration_maps WHERE run_id=?',[RUN]);for(const r of saved)maps.set(r.entity+'|'+r.source_id,r);
  const key=(domain,id)=>PREFIX+domain+'|'+ORIGIN+id;
  const saveMaps=async(entries)=>{if(entries.length)await db.query('INSERT INTO instance_migration_maps(run_id,instance,entity,source_id,target_id,source_fingerprint,updated_at) VALUES ?',[entries.map(e=>[RUN,'odim',PREFIX+e.domain,ORIGIN+e.sourceId,e.targetId,e.fingerprint,new Date()])])};
  const targetContact=new Map(contacts.map(({raw:r},i)=>[sid(r),config.reuse[sid(r)]||config.ranges.contacts.base+i+1]));
  const targetChat=new Map(chats.map(({raw:r},i)=>[sid(r),config.ranges.chats.base+i+1]));
  const phoneCounts=new Map(),waCounts=new Map();for(const {raw:r}of contacts){const phone=digits(r.NUMERO),wa=digits(r.IDENTIFICADOR)||phone;phoneCounts.set(phone,(phoneCounts.get(phone)||0)+1);waCounts.set(wa,(waCounts.get(wa)||0)+1)}
  const contactRaw=new Map(contacts.map(({raw})=>[sid(raw),raw]));
  stage='sectors';
  for(const {raw:r,fingerprint}of sectors){const prior=maps.get(key('sectors',sid(r)));if(prior){config.sectorIds[sid(r)]=prior.target_id;continue}
   await db.beginTransaction();try{
    const phoneId=String(r.WHATSAPP_NUMERO_ID||sid(r));let clientId=config.clientIds[phoneId];
    if(!clientId){const [insert]=await db.execute("INSERT INTO clients(name,phone,instance,type,is_active,waba_phone_id) VALUES(?,?,'odim','WABA',0,?)",['odim-legacy-copy-'+phoneId,digits(r.WHATSAPP_NUMERO)||null,r.WHATSAPP_NUMERO_ID?String(r.WHATSAPP_NUMERO_ID):null]);clientId=insert.insertId;config.clientIds[phoneId]=clientId}
    const [sector]=await db.execute("INSERT INTO sectors(name,instance,start_chats,receive_chats,default_client_id) VALUES(?,'odim',0,0,?)",[String(r.NOME||'Setor')+' · Odim (cópia)',clientId]);config.sectorIds[sid(r)]=sector.insertId;
    await saveMaps([{domain:'sectors',sourceId:sid(r),targetId:sector.insertId,fingerprint}]);await db.execute('UPDATE instance_migration_runs SET config_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?',[JSON.stringify(config),RUN]);await db.commit();
   }catch(e){await db.rollback();throw e}
  }
  const defaultClient=Object.values(config.clientIds)[0];gate(defaultClient,'COPY_CLIENT_REQUIRED');
  async function batch(domain,table,columns,entries){
   const fresh=entries.filter(e=>{const old=maps.get(key(domain,e.sourceId));if(!old)return true;gate(old.target_id===e.targetId&&old.source_fingerprint===e.fingerprint,'RESUME_MAP_MISMATCH');return false});if(!fresh.length)return;
   if(domain==='messages'){
    const wi=columns.indexOf('wwebjs_id'),wa=columns.indexOf('waba_id'),ids=fresh.flatMap(e=>[e.values[wi],e.values[wa]]).filter(Boolean);
    if(ids.length){const [registered]=await db.query('SELECT id,instance,wwebjs_id,waba_id FROM messages WHERE waba_id IN (?) OR wwebjs_id IN (?)',[ids,ids]);const collisions=[];
     for(const e of fresh.filter(e=>!e.reused))for(const [column,index]of [['wwebjs_id',wi],['waba_id',wa]]){const native=e.values[index];if(!native)continue;const prior=registered.find(r=>r[column]&&r[column].toLowerCase()===native.toLowerCase()&&r.id!==e.targetId);if(prior){collisions.push({sourceId:e.sourceId,targetId:e.targetId,registeredId:prior.id,registeredInstance:prior.instance,column,nativePreservedInSourceArchive:true});e.values[index]=null}}
     if(collisions.length)await privateWrite(out,'native-registry-collision-'+fresh[0].sourceId+'.json',collisions);
    }
   }
   await db.beginTransaction();try{
    const inserting=fresh.filter(e=>!e.reused);if(inserting.length){
     await db.query(`INSERT INTO ${table}(${columns.map(c=>'`'+c+'`').join(',')}) VALUES ?`,[inserting.map(e=>e.values)]);
     const [actual]=await db.query(`SELECT ${columns.map(c=>'`'+c+'`').join(',')} FROM ${table} WHERE id IN (?)`,[inserting.map(e=>e.targetId)]);gate(actual.length===inserting.length,'PHYSICAL_COUNT_MISMATCH');const byId=new Map(actual.map(r=>[r.id,r]));
     const normalize=v=>v==null?null:v instanceof Date?v.toISOString().replace('T',' ').replace('Z',''):String(v);
     for(const e of inserting){const row=byId.get(e.targetId);gate(row&&columns.every((c,i)=>normalize(row[c])===normalize(e.values[i])),'PHYSICAL_VALUES_MISMATCH');}
    }
    if(domain==='messages')for(const e of fresh.filter(e=>e.reused)){
     const value=Object.fromEntries(columns.map((c,i)=>[c,e.values[i]]));
     const [[old]]=await db.query("SELECT chat_id,contact_id FROM messages WHERE id=? AND instance='odim' FOR UPDATE",[e.targetId]);gate(old&&(!old.chat_id||old.chat_id===value.chat_id)&&(!old.contact_id||old.contact_id===value.contact_id),'PROVEN_MESSAGE_LINK_CONFLICT');
     await db.execute("UPDATE messages SET chat_id=COALESCE(chat_id,?),contact_id=COALESCE(contact_id,?),user_id=COALESCE(user_id,?),quoted_id=COALESCE(quoted_id,?),file_name=COALESCE(file_name,?),file_type=COALESCE(file_type,?) WHERE id=? AND instance='odim'",[value.chat_id,value.contact_id,value.user_id,value.quoted_id,value.file_name,value.file_type,e.targetId]);
    }
    await saveMaps(fresh.map(e=>({...e,domain})));await db.commit();for(const e of fresh)maps.set(key(domain,e.sourceId),{target_id:e.targetId,source_fingerprint:e.fingerprint});
   }catch(e){await db.rollback();throw e}
  }
  stage='contacts';const now=new Date();let pending=[];
  for(const {raw:r,fingerprint}of [...contacts].reverse()){const phone=digits(r.NUMERO),wa=digits(r.IDENTIFICADOR)||phone,reused=config.reuse[sid(r)],targetId=targetContact.get(sid(r));
   gate(String(r.NOME||phone).length<=191,'CONTACT_NAME_TOO_LONG');
   const phoneAvailable=phoneCounts.get(phone)===1&&!config.oldContacts.some(c=>c.phone&&digits(c.phone)===phone),waAvailable=waCounts.get(wa)===1&&!config.oldContacts.some(c=>c.whatsapp_id&&digits(c.whatsapp_id)===wa);
   pending.push({sourceId:sid(r),targetId,fingerprint,reused,values:[targetId,String(r.NOME||phone),phoneAvailable?phone:null,waAvailable?wa:null,Number(r.CODIGO_CLIENTE)>0?Number(r.CODIGO_CLIENTE):null,'odim',0,0,0,now,now]});
   if(pending.length>=1000){await batch('contacts','contacts',['id','name','phone','whatsapp_id','customer_id','instance','is_deleted','is_blocked','is_only_admin','created_at','updated_at'],pending);pending=[]}
  }await batch('contacts','contacts',['id','name','phone','whatsapp_id','customer_id','instance','is_deleted','is_blocked','is_only_admin','created_at','updated_at'],pending);console.log(JSON.stringify({stage,rows:contacts.length,normalTables:true}));
  stage='chats';pending=[];
  for(const {raw:r,fingerprint}of [...chats].reverse()){
   const targetId=targetChat.get(sid(r));pending.push({sourceId:sid(r),targetId,fingerprint,values:[targetId,'odim',targetContact.get(String(r.CODIGO_NUMERO))||null,r.CODIGO_OPERADOR??null,r.RESULTADO??null,config.sectorIds[String(r.SETOR)]||null,String(r.ATIVO_RECEP).toUpperCase().includes('RECEP')?'RECEPTIVE':'ACTIVE',priority(r),r.AVATAR_URL||null,Number(r.CONCLUIDO)?1:0,null,null,Number(r.CONCLUIDO)?r.CODIGO_OPERADOR??null:null,0]});
   if(pending.length>=1000){await batch('chats','chats',['id','instance','contact_id','user_id','result_id','sector_id','type','priority','avatar_url','is_finished','started_at','finished_at','finished_by','is_schedule'],pending);pending=[]}
  }await batch('chats','chats',['id','instance','contact_id','user_id','result_id','sector_id','type','priority','avatar_url','is_finished','started_at','finished_at','finished_by','is_schedule'],pending);console.log(JSON.stringify({stage,rows:chats.length,normalTables:true}));
  // Source ID order is retained in reserved destination IDs; write newest rows first.
  const files=new Map();for await(const {raw:r}of rows(dir,'w_mensagens_arquivos'))if(!files.has(String(r.CODIGO_MENSAGEM)))files.set(String(r.CODIGO_MENSAGEM),r);
  const messageRows=[];for await(const e of rows(dir,'w_mensagens'))messageRows.push(e);
  stage='messages';pending=[];let copied=0;
  const columns=['id','instance','wwebjs_id','waba_id','from','to','type','quoted_id','chat_id','contact_id','body','timestamp','sent_at','status','user_id','client_id','is_forwarded','is_edited','file_name','file_type'];
  for(const {raw:r,fingerprint}of messageRows.reverse()){
   const targetId=config.existingMessages[sid(r)]||config.ranges.messages.base+messageRanks.get(sid(r)),contact=contactRaw.get(String(r.CODIGO_NUMERO)),address=contact?(digits(contact.IDENTIFICADOR)||digits(contact.NUMERO)):'legacy-unlinked',external=r.ID&&!config.nativeVariants[sid(r)]?String(r.ID):null,quote=r.ID_REFERENCIA?native.get(String(r.ID_REFERENCIA).toLowerCase()):null,time=messageTime(r),own=Number(r.FROM_ME)===1;
   const file=files.get(sid(r)),fileName=file?decode(file.NOME_ORIGINAL||file.NOME_ARQUIVO||'Anexo legado').split(/[\\/]/).pop():null;
   gate(!fileName||fileName.length<=500,'FILE_NAME_TOO_LONG');
   pending.push({sourceId:sid(r),targetId,fingerprint,reused:!!config.existingMessages[sid(r)],values:[targetId,'odim',external&&!external.startsWith('wamid.')?external:null,external?.startsWith('wamid.')?external:null,own?'me:odim-legacy-copy':address,own?address:'me:odim-legacy-copy',r.TIPO==='text'?'chat':r.TIPO||'chat',quote?(config.existingMessages[quote.sourceId]||config.ranges.messages.base+quote.rank):null,targetChat.get(String(r.CODIGO_ATENDIMENTO))||null,targetContact.get(String(r.CODIGO_NUMERO))||null,decode(r.MENSAGEM),time.timestamp,time.sentAt,status(r.STATUS),r.CODIGO_OPERADOR??null,defaultClient,0,0,fileName,file?String(file.TIPO||'arquivo'):null]});
   if(pending.length>=1000){await batch('messages','messages',columns,pending);copied+=pending.length;pending=[];if(copied%10000===0){fence();console.log(JSON.stringify({stage,processed:copied,total:rank,newestFirst:true}))}}
  }await batch('messages','messages',columns,pending);
  const [counts]=await db.execute('SELECT entity,COUNT(*) n FROM instance_migration_maps WHERE run_id=? GROUP BY entity',[RUN]);gate(['contacts','chats','messages','sectors'].every(domain=>Number(counts.find(r=>r.entity===PREFIX+domain)?.n||0)===(domain==='sectors'?sectors.length:plan.counts[domain])),'MAP_COUNTS_MISMATCH');
  await db.execute("UPDATE instance_migration_runs SET status='COPY_VALIDATED',current_phase='DATA_COPIED',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status='LIVE_COPY'",[RUN]);
  const receipt={state:'OPERATIONAL_DATA_COPIED',runId:RUN,counts:plan.counts,sourceStillActive:true,providersEnabled:false,datesPolicyPending:true,filesPending:true,cutover:false};await privateWrite(out,'receipt.json',receipt);console.log(JSON.stringify(receipt));
 }catch(e){await privateWrite(out,'failure.json',{stage,code:e.safeCode||e.code||'COPY_FAILURE',automaticRetry:false}).catch(()=>{});throw Object.assign(Error('COPY_FAILED_INSPECT_PRIVATE_OUTPUT'),{safeCode:'COPY_FAILED_INSPECT_PRIVATE_OUTPUT'})}finally{await db.end()}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.safeCode||'COPY_FAILED',automaticRetry:false}));process.exitCode=1});
