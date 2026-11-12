const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const compiled = process.env.ODIM_READ_TEST_DIST || path.resolve(__dirname, '../dist');
const { OdimCopyReadReconciler } = require(path.join(compiled, 'services/odim-copy-read-reconciliation'));
const { ODIM_COPY_RUN, ODIM_COPY_ORIGIN, OdimLiveCopyWriter } = require(path.join(compiled, 'services/odim-live-copy.core'));
const origin = ODIM_COPY_ORIGIN;
const epoch = 1794331041000;

function fixture() {
 const central = new DatabaseSync(':memory:'), legacy = new DatabaseSync(':memory:');
 central.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,instance TEXT,chat_id INTEGER,contact_id INTEGER,status TEXT,timestamp TEXT,\`from\` TEXT,\`to\` TEXT);
 CREATE TABLE instance_migration_maps(run_id TEXT,instance TEXT,entity TEXT,source_id TEXT,target_id INTEGER);
 CREATE INDEX copy_run_entity_target ON instance_migration_maps(run_id,entity,target_id);
 CREATE TABLE session_changes(entity_id INTEGER);
 CREATE TRIGGER read_journal AFTER UPDATE ON messages BEGIN INSERT INTO session_changes VALUES(NEW.id); END;`);
 legacy.exec('CREATE TABLE w_mensagens(CODIGO INTEGER PRIMARY KEY,CODIGO_ATENDIMENTO INTEGER,CODIGO_NUMERO INTEGER,FROM_ME INTEGER,TIMESTAMP TEXT,STATUS TEXT)');
 const notifications = [], queries = [];
 let beforeUpdate, sourceFailure = false, notifyFailure = false, updateFailure = false, sourceWait = null;
 const execute = async (sql, values) => {
  queries.push(sql);
  if (sql.startsWith('UPDATE') && beforeUpdate) { const hook = beforeUpdate; beforeUpdate = null; hook(); }
  if (sql.startsWith('UPDATE') && updateFailure) throw Error('write unavailable');
  const statement = central.prepare(sql);
  return sql.startsWith('SELECT') ? [statement.all(...values), []] : [{ affectedRows: Number(statement.run(...values).changes) }, []];
 };
 const reconciler = new OdimCopyReadReconciler(execute, async (sql, values) => {
  assert(sql.startsWith('SELECT CODIGO,CODIGO_ATENDIMENTO,CODIGO_NUMERO,FROM_ME,TIMESTAMP,STATUS FROM w_mensagens'));
  assert(values.length <= 50);
  if (sourceFailure) throw Error('private source detail must never escape');
  if (sourceWait) await sourceWait;
  return legacy.prepare(sql).all(...values);
 }, async change => { notifications.push(change); if (notifyFailure) throw Error('optional notification unavailable'); });
 function mapping(domain, source, target) {
  central.prepare('INSERT INTO instance_migration_maps VALUES(?,?,?,?,?)').run(ODIM_COPY_RUN, 'odim', 'odim-live-copy-v1/' + domain, origin + source, target);
 }
 function add(id, change = {}, sourceChange = {}) {
  const msg = { id, instance: 'odim', chat: id + 1000, contact: id + 2000, status: 'RECEIVED', timestamp: String(epoch), from: 'fixture-customer', to: 'me:odim-legacy-copy', ...change };
  central.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(msg.id,msg.instance,msg.chat,msg.contact,msg.status,msg.timestamp,msg.from,msg.to);
  mapping('messages',id,id); mapping('chats',msg.chat,msg.chat); mapping('contacts',msg.contact,msg.contact);
  const src = { id, chat: msg.chat, contact: msg.contact, own: 0, timestamp: String(epoch), status: 'READ', ...sourceChange };
  legacy.prepare('INSERT INTO w_mensagens VALUES(?,?,?,?,?,?)').run(src.id,src.chat,src.contact,src.own,src.timestamp,src.status);
 }
 const status = id => central.prepare('SELECT status FROM messages WHERE id=?').get(id).status;
 return { central,legacy,reconciler,queries,notifications,add,mapping,status,
  race: fn => { beforeUpdate=fn; }, sourceFail: value => {sourceFailure=value;}, notifyFail: value => {notifyFailure=value;},
  updateFail: value => {updateFailure=value;}, holdSource: () => {let release;sourceWait=new Promise(resolve=>{release=resolve;});return()=>{sourceWait=null;release();};},
  close: () => {central.close();legacy.close();} };
}

test('exact historical links promote only confirmed inbound READ/PLAYED and publish the journal', async () => {
 const f=fixture();
 try {
  f.add(100); f.add(101,{}, {status:'PLAYED'}); f.add(102,{}, {status:'RECEIVED'});
  f.add(103,{}, {own:1}); f.add(104,{from:'me:fixture'}); f.add(105,{instance:'foreign'});
  f.add(106,{status:'READ'}); f.add(107,{status:'REVOKED'}); f.add(108,{from:'system'});
  f.add(109,{from:'bot:1'}); f.add(110,{from:'thirdparty:1'}); f.add(111,{from:'user:1'});
  f.add(112,{}, {chat:999}); f.add(113,{}, {contact:999}); f.add(114,{}, {timestamp:String(epoch+1)});
  f.add(115); f.central.prepare("DELETE FROM instance_migration_maps WHERE entity='odim-live-copy-v1/messages' AND target_id=115").run();
  f.add(116); f.mapping('messages',999999,116);
  f.add(117); f.central.prepare("UPDATE instance_migration_maps SET source_id='foreign/117' WHERE entity='odim-live-copy-v1/messages' AND target_id=117").run();
  const sourceBefore=f.legacy.prepare('SELECT * FROM w_mensagens ORDER BY CODIGO').all();
  await f.reconciler.run(100000);
  for(const id of [100,101,106]) assert.equal(f.status(id),'READ');
  for(const id of [102,103,104,105,108,109,110,111,112,113,114,115,116,117]) assert.equal(f.status(id),'RECEIVED',String(id));
  assert.equal(f.status(107),'REVOKED');
  assert.equal(f.reconciler.health.updated,2);
  assert.deepEqual(f.central.prepare('SELECT entity_id FROM session_changes ORDER BY entity_id').all().map(r=>r.entity_id),[100,101]);
  assert.deepEqual(f.notifications.map(r=>r.id),[100,101]);
  assert.deepEqual(f.legacy.prepare('SELECT * FROM w_mensagens ORDER BY CODIGO').all(),sourceBefore);
 } finally {f.close();}
});

test('conditional writes preserve concurrent modern status, movement and changed migration links', async () => {
 for (const mutation of [
  "UPDATE messages SET status='REVOKED' WHERE id=100",
  'UPDATE messages SET chat_id=999 WHERE id=100',
  'UPDATE messages SET contact_id=999 WHERE id=100',
  "UPDATE messages SET timestamp='1' WHERE id=100",
  "UPDATE messages SET `from`='me:modern' WHERE id=100",
  "UPDATE messages SET `to`='other' WHERE id=100",
  "UPDATE messages SET instance='foreign' WHERE id=100",
  "DELETE FROM instance_migration_maps WHERE entity='odim-live-copy-v1/messages' AND target_id=100",
  "DELETE FROM instance_migration_maps WHERE entity='odim-live-copy-v1/chats' AND target_id=1100",
  "DELETE FROM instance_migration_maps WHERE entity='odim-live-copy-v1/contacts' AND target_id=2100",
 ]) {
  const f=fixture(); try {f.add(100);f.race(()=>f.central.exec(mutation));await f.reconciler.run(100000);assert.equal(f.reconciler.health.updated,0,mutation);assert.notEqual(f.status(100),'READ',mutation);}finally{f.close();}
 }
});

test('bounded keyset batches rotate past unread old rows and revisit a later confirmation', async () => {
 const f=fixture();try {
  for(let id=100;id<160;id++)f.add(id,{}, {status:'RECEIVED'});
  await f.reconciler.run(100000);assert.equal(f.reconciler.health.checked,50);assert.equal(f.reconciler.health.cursor,149);
  await f.reconciler.run(109999);assert.equal(f.reconciler.health.cursor,149);
  f.legacy.exec("UPDATE w_mensagens SET STATUS='READ' WHERE CODIGO=155");
  await f.reconciler.run(110000);assert.equal(f.reconciler.health.checked,10);assert.equal(f.status(155),'READ');assert.equal(f.reconciler.health.cursor,159);
  await f.reconciler.run(120000);assert.equal(f.reconciler.health.cycles,2);assert.equal(f.reconciler.health.cursor,149);
 }finally{f.close();}
});

test('primary ID windows advance over empty ranges and include newly copied tail mappings next cycle',async()=>{
 const f=fixture();try{
  f.add(100);f.add(30100);
  await f.reconciler.run(100000);assert.equal(f.status(100),'READ');assert.equal(f.status(30100),'RECEIVED');assert.equal(f.reconciler.health.cursor,25099);
  await f.reconciler.run(110000);assert.equal(f.status(30100),'READ');
  f.add(30101);await f.reconciler.run(120000);await f.reconciler.run(130000);assert.equal(f.status(30101),'READ');
 }finally{f.close();}
});

test('source failures keep the cursor for a cooled retry; notification failures keep committed READ',async()=>{
 const f=fixture();try{
  f.add(100);f.sourceFail(true);await f.reconciler.run(100000);
  assert.equal(f.status(100),'RECEIVED');assert.equal(f.reconciler.health.cursor,99);
  assert.equal(f.reconciler.health.lastError,'READ_RECONCILIATION_RETRY_PENDING');
  f.sourceFail(false);await f.reconciler.run(159999);assert.equal(f.status(100),'RECEIVED');
  f.notifyFail(true);await f.reconciler.run(160000);assert.equal(f.status(100),'READ');assert.equal(f.reconciler.health.lastError,null);assert.equal(f.reconciler.health.cursor,100);
  assert(!JSON.stringify(f.reconciler.health).includes('private source detail'));
 }finally{f.close();}
});

test('copy writer preserves already read inbound receipts in both operation modes',async()=>{
 for(const preserveCurrentOperations of [false,true]) {
  let updated;
  const old={id:100,instance:'odim',from:'fixture',to:'me:odim-legacy-copy',status:'READ',body:'modern',chat_id:1100,contact_id:2100,timestamp:String(epoch),sent_at:'2026-11-10 17:17:21',user_id:1,client_id:13,waba_id:null,wwebjs_id:null,file_name:null,file_type:null,quoted_id:null};
  const db={execute:async(sql)=>{
   if(sql.startsWith('SELECT target_id'))return [[{target_id:100}]];
   if(sql.startsWith('SELECT * FROM messages'))return [[old]];
   if(sql.startsWith('INSERT IGNORE'))return [{}];
   throw Error(sql);
  },query:async(sql,values)=>{updated={sql,values};return [{}];}};
  await new OdimLiveCopyWriter(db,{clientIds:{source:13},preserveCurrentOperations}).message({CODIGO:100,FROM_ME:0,TIMESTAMP:epoch,TIPO:'text',MENSAGEM:'legacy',STATUS:'RECEIVED',CODIGO_OPERADOR:1},null,2100,1100,null,null);
  assert(updated);const cols=[...updated.sql.matchAll(/`([^`]+)`=\?/g)].map(m=>m[1]);
  assert.equal(updated.values[cols.indexOf('status')],'READ');
 }
});

test('a failed conditional write retains the cursor and retries after the error cooldown',async()=>{
 const f=fixture();try{
  f.add(100);f.updateFail(true);await f.reconciler.run(100000);
  assert.equal(f.status(100),'RECEIVED');assert.equal(f.reconciler.health.cursor,99);
  assert.equal(f.reconciler.health.lastError,'READ_RECONCILIATION_RETRY_PENDING');
  const queries=f.queries.length;f.updateFail(false);await f.reconciler.run(159999);assert.equal(f.queries.length,queries);
  await f.reconciler.run(160000);assert.equal(f.status(100),'READ');assert.equal(f.reconciler.health.cursor,100);
 }finally{f.close();}
});

test('a concurrent invocation does not duplicate the active source scan or updates',async()=>{
 const f=fixture();try{
  f.add(100);const release=f.holdSource();const active=f.reconciler.run(100000);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.reconciler.running,true);
  const queries=f.queries.length;await f.reconciler.run(200000);assert.equal(f.queries.length,queries);
  release();await active;assert.equal(f.status(100),'READ');assert.equal(f.reconciler.health.updated,1);
 }finally{f.close();}
});
