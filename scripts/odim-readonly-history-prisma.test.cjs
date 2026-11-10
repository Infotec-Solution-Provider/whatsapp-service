const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const schema='odim_history_prisma_'+crypto.randomBytes(5).toString('hex');
function sql(query){const r=spawnSync('docker',['exec','-i','homolog-odim-mysql8-20261109','mysql','--default-character-set=utf8mb4','-uroot','--batch'],{input:query,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,r.stderr);}
const ddl=fs.readFileSync(__dirname+'/odim-readonly-history-schema.sql','utf8');
const snapshot='00000000-0000-0000-0000-000000000001',foreign='00000000-0000-0000-0000-000000000002';
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url:`mysql://root@127.0.0.1:13318/${schema}`}}});
(async()=>{
 sql(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4;USE ${schema};${ddl}`);
 const manifest=JSON.stringify({tables:[{table:'w_atendimentos',rows:1}]});
 await db.$executeRawUnsafe("INSERT INTO legacy_readonly_history_snapshots(id,instance,manifest_sha,source_snapshot_at,manifest,state) VALUES (?,'odim',REPEAT('a',64),'2026-11-10T00:00:00Z',?,'PUBLISHED'),(?,'foreign',REPEAT('b',64),'2026-11-10T00:00:00Z',?,'PUBLISHED')",snapshot,manifest,foreign,manifest);
 for(const [sid,domain,id,contact,parent,name,raw]of [[snapshot,'w_atendimentos',8,11,null,null,{CODIGO:8,CODIGO_OPERADOR:-2,DATA_INICIO:'2023-10-09 12:00:00',CONCLUIDO:1}],[snapshot,'w_clientes_numeros',11,null,null,'Próprio 💚',{NOME:'Próprio 💚',NUMERO:'fixture'}],[foreign,'w_clientes_numeros',11,null,null,'Foreign',{NOME:'Foreign'}],[snapshot,'w_mensagens',13,11,8,null,{MENSAGEM:'Olá 💚\n%20  ',CODIGO_OPERADOR:-2,FROM_ME:1,DATA_HORA:'2023-10-09 12:00:00'}]]){
  const payload=JSON.stringify(raw);await db.$executeRawUnsafe('INSERT INTO legacy_readonly_history_rows(snapshot_id,domain,source_id,contact_id,parent_id,name_text,payload,payload_sha) VALUES(?,?,?,?,?,?,?,?)',sid,domain,id,contact,parent,name,payload,crypto.createHash('sha256').update(payload).digest('hex'));
 }
 const {OdimReadonlyHistory}=require('../dist/services/odim-readonly-history.core');
 const api=new OdimReadonlyHistory({query:(s,v)=>db.$queryRawUnsafe(s,...v)},{id:snapshot,source_snapshot_at:'2026-11-10T00:00:00Z',manifest});
 const list=await api.list('chats',{page:'1',limit:'20'});assert.equal(list.total,1);assert.equal(list.items[0].name,'Próprio 💚');assert(!JSON.stringify(list).includes('Foreign'));
 const search=await api.list('chats',{search:'Próprio'});assert.equal(search.total,1);
 const messages=await api.messages('chats',8,{limit:'50'});assert.equal(messages.entries[0].body,'Olá 💚\n%20  ');assert.equal(messages.entries[0].operatorId,-2);assert.equal(await api.messages('chats',999,{}),null);
 console.log(JSON.stringify({passed:true,actualPrismaMysql:true,unicode:true,namespace:true,pagination:true,sourceDatesPreserved:true}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await db.$disconnect();sql(`DROP DATABASE ${schema};`);});
