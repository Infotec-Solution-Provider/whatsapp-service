'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const mysql=require('mysql2/promise'),{PrismaClient}=require('@prisma/client');
require('ts-node/register');
const {runCentralRuntime}=require('../src/operator-runtime/engine');
const {OperatorRuntimeError}=require('../src/operator-runtime/core');
const {parseSchema,metadata,TABLES}=require('./operator-runtime-migrate.cjs');
const {createProductionSmoke,INSTANCE,ACTOR}=require('./operator-runtime-production-smoke.cjs');

test('production smoke on isolated MySQL8 only',{skip:process.env.RUN_OPERATOR_RUNTIME_SMOKE_MYSQL!=='1'},async t=>{
 const admin=await mysql.createConnection({host:'127.0.0.1',port:13480,user:'root'}),made=[],clients=[],dirs=[],schema=fs.readFileSync(path.join(__dirname,'../src/operator-runtime/schema.sql'),'utf8');let seq=0;
 const identity=(await admin.query('SELECT @@hostname AS hostname,@@port AS port'))[0][0];
 async function fixture(){
  const database='operator_runtime_smoke_'+process.pid+'_'+Date.now()+'_'+(++seq);assert(/^operator_runtime_smoke_[a-z0-9_]+$/.test(database));await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4');made.push(database);
  const db=new PrismaClient({datasources:{db:{url:'mysql://root@127.0.0.1:13480/'+database+'?connection_limit=3'}}});clients.push(db);for(const item of parseSchema(schema))await db.$executeRawUnsafe(item.sql);
  const review='a'.repeat(64);await db.$executeRawUnsafe('INSERT INTO operator_runtime_policy(instance,enabled,schema_version,revision,review_sha256) VALUES(?,1,1,2,?)',INSTANCE,review);
  const expectedSchema=(await metadata(db)).schema,key=Buffer.from('isolated-smoke-test-key-32-byte-minimum-not-a-production-secret'),control=fs.mkdtempSync(path.join(os.tmpdir(),'operator-runtime-smoke-'));dirs.push(control);let losePause=false,corruptBlock=false,requests=0;
  const transport=async(url,options)=>{
   requests++;assert.equal(new URL(url).origin,'http://127.0.0.1:8005');const target=new URL(url).pathname,timestamp=options.headers['x-operator-timestamp'],nonce=options.headers['x-operator-nonce'];assert.equal(options.headers['x-operator-signature'],crypto.createHmac('sha256',key).update(`${timestamp}\n${nonce}\n${target}\n${options.body}`).digest('hex'));
   const command=JSON.parse(options.body);assert.equal(command.actorId,ACTOR);assert.equal(target,'/api/internal/operator-runtime/'+INSTANCE+'/commands');
   if(corruptBlock&&command.action==='prepare')return new Response(JSON.stringify({data:{incorrect:true}}),{status:200});
   try{const data=await runCentralRuntime(db,INSTANCE,command);if(losePause&&command.action==='pause'&&command.input.kind==='now'){losePause=false;throw Error('fixture lost acknowledgement after real COMMIT');}return new Response(JSON.stringify({data}),{status:200});}
   catch(error){if(error instanceof OperatorRuntimeError)return new Response(JSON.stringify({code:error.code,outcome:error.outcome}),{status:error.status});throw error;}
  };
  const options={db,control,environment:'test',expectedDatabase:database,expectedHost:identity.hostname,expectedPort:Number(identity.port),owner:()=>{},inputs:()=>({expectedSchema,expectedReviewSha256:review,key}),transport};
  return{db,database,control,options,smoke:createProductionSmoke(options),lose:()=>{losePause=true;},badBlock:()=>{corruptBlock=true;},get requests(){return requests;}};
 }
 async function empty(db){for(const table of TABLES.filter(n=>n!=='operator_runtime_policy'))assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `'+table+'`'))[0].n,0n);}
 try{
  await t.test('HMAC pause/replay/block/resume leaves no fixture rows or policy changes',async()=>{const f=await fixture(),result=await f.smoke.run();assert.equal(result.passed,true);assert.equal(result.providerCalls,0);assert.equal(result.crmQueries,0);assert.equal(result.checks.length,5);assert.equal(f.requests,5);await empty(f.db);const policy=(await f.db.$queryRawUnsafe('SELECT enabled,revision FROM operator_runtime_policy'))[0];assert.equal(Number(policy.enabled),1);assert.equal(Number(policy.revision),2);const st=fs.statSync(path.join(f.control,'receipts/production-smoke.json'));if(process.platform!=='win32')assert.equal(st.mode&0o777,0o600);await assert.rejects(f.smoke.run(),/SMOKE_ALREADY_STARTED/);assert((await f.smoke.cleanup()).replayed);});
  await t.test('lost real pause COMMIT acknowledgement still cleans exact owned UUIDs',async()=>{const f=await fixture();f.lose();await assert.rejects(f.smoke.run(),/lost acknowledgement/);await empty(f.db);const receipt=JSON.parse(fs.readFileSync(path.join(f.control,'receipts/production-smoke.json')));assert.equal(receipt.phase,'cleaned');assert.equal(receipt.failed,true);});
  await t.test('a failed block assertion performs cleanup and does not claim success',async()=>{const f=await fixture();f.badBlock();await assert.rejects(f.smoke.run());await empty(f.db);});
  await t.test('an existing reserved actor is never touched',async()=>{const f=await fixture();await f.db.$executeRawUnsafe('INSERT INTO operator_runtime_state(instance,operator_id) VALUES(?,?)',INSTANCE,ACTOR);await assert.rejects(f.smoke.run(),/RESERVED_ACTOR_NOT_EMPTY/);assert.equal(f.requests,0);assert.equal((await f.db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM operator_runtime_state'))[0].n,1n);});
  await t.test('a datasource swapped inside the transaction is rejected before HTTP or writes',async()=>{const a=await fixture(),b=await fixture();const db={$queryRawUnsafe:a.db.$queryRawUnsafe.bind(a.db),$executeRawUnsafe:a.db.$executeRawUnsafe.bind(a.db),$transaction:b.db.$transaction.bind(b.db)};await assert.rejects(createProductionSmoke({...a.options,db}).run(),/DATABASE_SCOPE/);assert.equal(a.requests,0);await empty(a.db);await empty(b.db);});
 }finally{
  for(const db of clients)await db.$disconnect();for(const name of made){assert(/^operator_runtime_smoke_[a-z0-9_]+$/.test(name));await admin.query('DROP DATABASE `'+name+'`');}await admin.end();
  for(const dir of dirs){const resolved=path.resolve(dir);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('operator-runtime-smoke-'));fs.rmSync(resolved,{recursive:true,force:true});}
 }
});
