'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const mysql=require('mysql2/promise'),{PrismaClient}=require('@prisma/client');
const {createActivation}=require('./activate-operator-pilot.cjs');
const {metadata,parseSchema,verifyPresent,sha,canonical}=require('./operator-runtime-migrate.cjs');
const factoryFile=require.resolve('./activate-operator-pilot.cjs'),testedFactorySha256=sha(fs.readFileSync(factoryFile));
const ROOT='C:/Workspace/infotec/planejamento/cross-service/INF-20261113-002-telefonia-finalizacao-financeiro/artifacts/production-20261116/migration-stage';
const INSTANCES=['exatron','infotec','karsten','nunes','odim','suprimaxxi','testes','vollo'];

test('Odim534 activation factory on isolated MySQL8 only',{skip:process.env.RUN_OPERATOR_PILOT_MYSQL!=='1'},async t=>{
 t.diagnostic('testedFactorySha256='+testedFactorySha256);
 const mysqlPort=Number(process.env.OPERATOR_PILOT_MYSQL_PORT||13480);
 const admin=await mysql.createConnection({host:'127.0.0.1',port:mysqlPort,user:'root'}),clients=[],databases=[],directories=[];
 const schemaSql=fs.readFileSync(process.env.OPERATOR_PILOT_SCHEMA_FILE||path.join(ROOT,'schema.sql'),'utf8');
 const expected=JSON.parse(fs.readFileSync(process.env.OPERATOR_PILOT_SCHEMA8_FILE||path.join(ROOT,'expected-schema.json'),'utf8'));
 let sequence=0;
 async function fixture(label){
  const database='operator_pilot534_cli_'+process.pid+'_'+Date.now()+'_'+(++sequence)+'_'+label;
  assert(/^operator_pilot534_cli_[a-z0-9_]+$/.test(database));
  await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');databases.push(database);
  const db=new PrismaClient({datasources:{db:{url:'mysql://root@127.0.0.1:'+mysqlPort+'/'+database+'?connection_limit=3'}}});clients.push(db);
  for(const item of parseSchema(schemaSql))await db.$executeRawUnsafe(item.sql);
  verifyPresent((await metadata(db)).schema,expected,true);
  for(const instance of INSTANCES){const reviewed=['infotec','karsten','odim','suprimaxxi'].includes(instance);await db.$executeRawUnsafe('INSERT INTO operator_runtime_policy(instance,enabled,schema_version,revision,review_sha256) VALUES(?,0,1,?,?)',instance,reviewed?3:1,reviewed?'a'.repeat(64):null);}
  const before=await metadata(db),control=fs.mkdtempSync(path.join(os.tmpdir(),'operator-pilot534-test-'));directories.push(control);
  const review={instance:'odim',allowedOperatorIds:[534],commonProfileSha256:'c'.repeat(64),features:{operator:true,telephony:true,crm:true,whatsapp:true}};
  fs.writeFileSync(path.join(control,'runtime-schema.json'),JSON.stringify(expected));fs.writeFileSync(path.join(control,'review.json'),JSON.stringify(review));fs.writeFileSync(path.join(control,'evidence.json'),'{}');
  const plan={version:1,environment:'test',control,instance:'odim',operatorId:534,identity:before.identity,expectedPolicies:before.policies,
   runtimeSchema:{file:'runtime-schema.json',sha256:sha(fs.readFileSync(path.join(control,'runtime-schema.json')))},review:{file:'review.json',sha256:sha(fs.readFileSync(path.join(control,'review.json')))},evidence:{'evidence.json':sha('{}')}};
  fs.writeFileSync(path.join(control,'pilot-policy-plan.json'),JSON.stringify(plan));
  const hooks={updates:[],transactions:0,readyCalls:0,readyFailure:false,loseCommit:false,transactionDatabase:null};
  const facade={$queryRawUnsafe:db.$queryRawUnsafe.bind(db),$executeRawUnsafe:db.$executeRawUnsafe.bind(db),$transaction:async work=>{
   hooks.transactions++;
   const result=await (hooks.transactionDatabase||db).$transaction(tx=>work({$queryRawUnsafe:tx.$queryRawUnsafe.bind(tx),$executeRawUnsafe:async(...args)=>{hooks.updates.push(args);return tx.$executeRawUnsafe(...args);}}));
   if(hooks.loseCommit){hooks.loseCommit=false;throw Error('fixture lost COMMIT response');}
   return result;
  }};
  const options={db:facade,control,environment:'test',owner:()=>{},verifyReadiness:async()=>{hooks.readyCalls++;if(hooks.readyFailure)throw Error('fixture readiness unavailable');return true;}};
  return{db,control,plan,before,hooks,engine:createActivation(options)};
 }
 const policies=async f=>(await metadata(f.db)).policies;
 const odim=rows=>rows.find(row=>row.instance==='odim');
 const others=rows=>rows.filter(row=>row.instance!=='odim');
 try{
  await t.test('plan is SQL read-only; CAS activates only Odim revision3→4 and keeps every other policy OFF',async()=>{
   const f=await fixture('normal');assert((await f.engine.plan()).prepared);assert.equal(f.hooks.updates.length,0);assert.equal(canonical(await policies(f)),canonical(f.before.policies));
   assert((await f.engine.activate()).activated);const current=await policies(f);assert.deepEqual(others(current),others(f.before.policies));assert.equal(Number(odim(current).enabled),1);assert.equal(Number(odim(current).revision),4);assert.equal(odim(current).review_sha256,f.plan.review.sha256);assert.equal(f.hooks.updates.length,1);assert.equal(f.hooks.updates[0][2],'odim');assert((await f.engine.verify()).verified);
  });
  await t.test('a changed policy after plan rejects the CAS before UPDATE',async()=>{
   const f=await fixture('cas');await f.engine.plan();await f.db.$executeRawUnsafe('UPDATE operator_runtime_policy SET revision=99 WHERE instance=?','odim');await assert.rejects(f.engine.activate(),/POLICY_BASELINE_DRIFT/);assert.equal(f.hooks.updates.length,0);assert.equal(Number(odim(await policies(f)).enabled),0);assert.equal(Number(odim(await policies(f)).revision),99);
  });
  await t.test('lost COMMIT acknowledgement is observed once; recover does not replay UPDATE',async()=>{
   const f=await fixture('lost_ack');await f.engine.plan();f.hooks.loseCommit=true;const result=await f.engine.activate();assert(result.activated&&result.commitAcknowledgementLost);assert.equal(f.hooks.transactions,1);assert.equal(f.hooks.updates.length,1);assert((await f.engine.recover()).mutationRepeated===false);await assert.rejects(f.engine.activate(),/ACTIVATION_ALREADY_STARTED/);assert.equal(f.hooks.updates.length,1);assert.equal(Number(odim(await policies(f)).revision),4);
  });
  await t.test('wrong datasource only inside TX cannot activate or roll back',async()=>{
   const a=await fixture('identity_a'),b=await fixture('identity_b');await a.engine.plan();a.hooks.transactionDatabase=b.db;await assert.rejects(a.engine.activate(),/DATABASE_IDENTITY/);assert.equal(a.hooks.updates.length,0);assert.equal(Number(odim(await policies(a)).enabled),0);assert.equal(Number(odim(await policies(b)).enabled),0);
   const c=await fixture('identity_rollback');await c.engine.plan();await c.engine.activate();const count=c.hooks.updates.length;c.hooks.transactionDatabase=b.db;await assert.rejects(c.engine.rollback(),/DATABASE_IDENTITY/);assert.equal(c.hooks.updates.length,count);assert.equal(Number(odim(await policies(c)).revision),4);assert.equal(Number(odim(await policies(b)).enabled),0);
  });
  await t.test('readiness failure produces zero UPDATE and does not start an activation receipt',async()=>{
   const f=await fixture('readiness');f.hooks.readyFailure=true;await assert.rejects(f.engine.plan(),/readiness unavailable/);assert.equal(f.hooks.updates.length,0);assert(!fs.existsSync(path.join(f.control,'receipts/pilot-policy-prepared.json')));f.hooks.readyFailure=false;await f.engine.plan();f.hooks.readyFailure=true;await assert.rejects(f.engine.activate(),/readiness unavailable/);assert.equal(f.hooks.updates.length,0);assert(!fs.existsSync(path.join(f.control,'receipts/pilot-policy.json')));assert.deepEqual(await policies(f),f.before.policies);
  });
  await t.test('foreign review or revision never grants rollback ownership',async()=>{
   for(const kind of['review','revision']){const f=await fixture('foreign_'+kind);await f.engine.plan();await f.engine.activate();const count=f.hooks.updates.length;if(kind==='review')await f.db.$executeRawUnsafe('UPDATE operator_runtime_policy SET review_sha256=? WHERE instance=?','b'.repeat(64),'odim');else await f.db.$executeRawUnsafe('UPDATE operator_runtime_policy SET revision=99 WHERE instance=?','odim');await assert.rejects(f.engine.rollback(),kind==='review'?/ROLLBACK_OWNERSHIP/:/ROLLBACK_REVISION_DRIFT/);assert.equal(f.hooks.updates.length,count);assert.equal(Number(odim(await policies(f)).enabled),1);}
  });
  await t.test('owned rollback moves Odim to revision5 once and remains idempotent',async()=>{
   const f=await fixture('rollback');await f.engine.plan();await f.engine.activate();assert((await f.engine.rollback()).rolledBack);assert((await f.engine.rollback()).rolledBack);const current=await policies(f);assert.equal(f.hooks.updates.length,2);assert.equal(Number(odim(current).enabled),0);assert.equal(Number(odim(current).revision),5);assert.equal(odim(current).review_sha256,f.plan.review.sha256);assert.deepEqual(others(current),others(f.before.policies));assert((await f.engine.recover()).rolledBack);
  });
 }finally{
  for(const client of clients)await client.$disconnect();
  for(const database of databases){assert(/^operator_pilot534_cli_[a-z0-9_]+$/.test(database));await admin.query('DROP DATABASE `'+database+'`');}await admin.end();
  for(const directory of directories){const absolute=path.resolve(directory);assert(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('operator-pilot534-test-'));fs.rmSync(absolute,{recursive:true,force:true});}
  assert.equal(sha(fs.readFileSync(factoryFile)),testedFactorySha256,'FACTORY_CHANGED_DURING_TEST');
 }
});
