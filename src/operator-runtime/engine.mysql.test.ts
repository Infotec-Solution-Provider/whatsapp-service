import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { createConnection, createPool, type PoolConnection } from "mysql2/promise";
import { once } from "node:events";
import express from "express";
import { runCentralRuntime, digest } from "./engine";
import { createOperatorRuntimeRouter } from "./router";
import { lockRuntimeAdmission, type RuntimeDb, type RuntimeTx } from "./core";
import type { CentralCommand } from "./contract";

const r={id:1,name:"Fixture",maxSeconds:60,productive:false};
function adapter(connection:PoolConnection):RuntimeTx{return{$queryRawUnsafe:async<T>(sql:string,...values:unknown[])=>{const[result]=await connection.execute(sql,values as any[]);return result as T;},$executeRawUnsafe:async(sql,...values)=>{const[result]=await connection.execute(sql,values as any[]);return Number((result as {affectedRows:number}).affectedRows);}};}
test("central runtime MySQL8: isolation, replay, durable finish and transactional races",async t=>{
	const name=`central_runtime_${process.pid}_${Date.now()}`,admin=await createConnection({host:"127.0.0.1",port:13480,user:"root",multipleStatements:true});
	await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
	const pool=createPool({host:"127.0.0.1",port:13480,user:"root",database:name,connectionLimit:5,timezone:"Z",multipleStatements:true});
	let loseCommit=false;
	const database:RuntimeDb={$transaction:async callback=>{const c=await pool.getConnection();try{await c.beginTransaction();const value=await callback(adapter(c));await c.commit();if(loseCommit){loseCommit=false;throw Error("fixture response lost after commit");}return value;}catch(error){await c.rollback();throw error;}finally{c.release();}}};
	const send=(actorId:number,action:CentralCommand["action"],input:Record<string,unknown>={},instance="tenant-a")=>runCentralRuntime(database,instance,{operation:"operator.runtime",actorId,action,input}) as Promise<any>;
	try{
		await pool.query(fs.readFileSync(path.join(__dirname,"schema.sql"),"utf8"));
		await pool.execute("INSERT INTO operator_runtime_policy(instance,enabled,review_sha256) VALUES('tenant-a',1,?),('tenant-b',1,?)",["a".repeat(64),"b".repeat(64)]);
		await t.test("same operator and operation IDs are isolated by canonical tenant",async()=>{
			const id=randomUUID(),a=await send(7,"pause",{operationId:id,kind:"now",reasonId:1,reasonSnapshot:r,expectedVersion:0}," Tenant-A "),b=await send(7,"status",{},"tenant-b");
			assert.equal(a.state,"paused");assert.equal(a.authority,"central-v1");assert.equal(b.state,"available");
			const replay=await send(7,"pause",{operationId:id,kind:"now",reasonId:1,reasonSnapshot:{...r,name:"Renamed"},expectedVersion:0});assert.equal(replay.reason,"Fixture");
			await assert.rejects(send(8,"pause",{operationId:id,kind:"now",reasonId:1,reasonSnapshot:r,expectedVersion:0}),{code:"OPERATOR_RUNTIME_OPERATION_REUSED"});
			await send(7,"pause",{operationId:randomUUID(),kind:"resume",expectedVersion:a.version});
		});
		await t.test("pending waits for verified CRM finish and preserves its cutoff",async()=>{
			const callId=randomUUID();await send(7,"prepare",{callId,direction:"outgoing",number:"100",scheduleId:41,scheduleOwnerVerified:true});
			let state=await send(7,"status");await assert.rejects(send(7,"pause",{operationId:randomUUID(),kind:"now",reasonId:1,reasonSnapshot:r,expectedVersion:state.version}),{code:"OPERATOR_RUNTIME_CALL_ACTIVE"});
			state=await send(7,"pause",{operationId:randomUUID(),kind:"after_attendance",reasonId:1,reasonSnapshot:r,expectedVersion:state.version,scheduleId:41,callId,scheduleOwnerVerified:true});const cutoff=state.unavailableSince;
			await send(7,"event",{eventId:randomUUID(),callId,type:"ended",occurredAt:new Date().toISOString()});assert.equal((await send(7,"status")).state,"pending");
			const operationId=randomUUID(),expected={resultId:5,historyAfter:17},input={operationId,scheduleId:41,callId,request:{resultId:5},snapshot:{historyMax:16},expected};
			assert.equal((await send(7,"finish.begin",input)).created,true);assert.equal((await send(7,"finish.begin",input)).created,false);
			await send(7,"finish.verify",{operationId,expectedHash:digest(expected),proof:{outcome:"UNKNOWN"}});assert.equal((await send(7,"status")).state,"pending");
			const verified=await send(7,"finish.verify",{operationId,expectedHash:digest(expected),proof:{outcome:"VERIFIED",historyId:17,scheduleId:41,operatorId:7}});
			assert.equal(verified.outcome,"COMMITTED");state=await send(7,"status");assert.equal(state.state,"paused");assert.equal(state.unavailableSince,cutoff);assert.equal(state.reason,"Fixture");
			await send(7,"pause",{operationId:randomUUID(),kind:"resume",expectedVersion:state.version});assert.equal((await send(7,"status")).unavailableSince,null);
		});
		await t.test("pause and assignment share an actor lock; policy revision cannot change before commit",async()=>{
			let release!:()=>void,reached!:()=>void;const gate=new Promise<void>(x=>release=x),locked=new Promise<void>(x=>reached=x);
			const work=database.$transaction(async tx=>{await lockRuntimeAdmission(tx,"tenant-a",[9]);reached();await gate;});await locked;
			let policyChanged=false,second=false;const c=await pool.getConnection();const p=c.execute("UPDATE operator_runtime_policy SET revision=revision+1 WHERE instance='tenant-a'").then(()=>{policyChanged=true;});
			const queued=database.$transaction(async tx=>{await lockRuntimeAdmission(tx,"tenant-a",[9]);second=true;});await new Promise(x=>setTimeout(x,40));assert.equal(policyChanged,false);assert.equal(second,false);release();await work;await p;await queued;c.release();
		});
		await t.test("parallel/lost finish admission never grants a replay permission to mutate CRM",async()=>{
			const id=randomUUID(),input={operationId:id,scheduleId:61,request:{resultId:5},snapshot:{historyMax:"16"},expected:{resultId:5}};
			const both=await Promise.all([send(16,"finish.begin",input),send(16,"finish.begin",input)]);assert.deepEqual(both.map(x=>x.created).sort(),[false,true]);
			const lostInput={...input,operationId:randomUUID(),scheduleId:62};loseCommit=true;await assert.rejects(send(16,"finish.begin",lostInput),/response lost/);
			assert.equal((await send(16,"finish.begin",lostInput)).created,false);assert.equal((await send(16,"finish.status",{operationId:lostInput.operationId})).outcome,"UNKNOWN");
		});
		await t.test("late confirmation of an old finish cannot activate a new pending generation",async()=>{
			const callId=randomUUID();await send(17,"prepare",{callId,direction:"outgoing",number:"100",scheduleId:71,scheduleOwnerVerified:true});await send(17,"event",{eventId:randomUUID(),callId,type:"ended",occurredAt:new Date().toISOString()});
			let state=await send(17,"status");state=await send(17,"pause",{operationId:randomUUID(),kind:"after_attendance",reasonId:1,reasonSnapshot:r,expectedVersion:state.version,scheduleId:71,callId,scheduleOwnerVerified:true});
			const oldId=randomUUID(),expected={resultId:8};await send(17,"finish.begin",{operationId:oldId,scheduleId:71,callId,request:{resultId:8},snapshot:{historyMax:"17"},expected});
			state=await send(17,"pause",{operationId:randomUUID(),kind:"cancel_pending",expectedVersion:state.version});state=await send(17,"pause",{operationId:randomUUID(),kind:"after_attendance",reasonId:1,reasonSnapshot:r,expectedVersion:state.version,scheduleId:71,callId,scheduleOwnerVerified:true});
			await send(17,"finish.verify",{operationId:oldId,expectedHash:digest(expected),proof:{outcome:"VERIFIED",historyId:"18",scheduleId:71,operatorId:17}});
			const current=await send(17,"status");assert.equal(current.state,"pending");assert.equal(current.unavailableSince,state.unavailableSince);assert.equal(current.version,state.version);
		});
		await t.test("lost COMMIT response is UNKNOWN and same operation replays exactly once through HMAC",async()=>{
			const key=Buffer.from("fixture-only-signature-key-at-least-32-bytes"),app=express();app.use(createOperatorRuntimeRouter(database,()=>({authority:"central-v1",instances:["tenant-a","tenant-b"],signingKeyFile:"/unused-fixture"}),()=>key));
			const server=app.listen(0,"127.0.0.1");await once(server,"listening");
			try{
				const url="/api/internal/operator-runtime/Tenant-A/commands",body={operation:"operator.runtime",actorId:11,action:"pause",input:{operationId:randomUUID(),kind:"now",reasonId:1,reasonSnapshot:r,expectedVersion:0}};
				async function post(){const timestamp=String(Date.now()),nonce=randomUUID(),signature=createHmac("sha256",key).update(`${timestamp}\n${nonce}\n${url}\n${JSON.stringify(body)}`).digest("hex"),address=server.address() as {port:number};return fetch(`http://127.0.0.1:${address.port}${url}`,{method:"POST",headers:{"Content-Type":"application/json","x-operator-timestamp":timestamp,"x-operator-nonce":nonce,"x-operator-signature":signature},body:JSON.stringify(body)});}
				loseCommit=true;const lost=await post();assert.equal(lost.status,503);assert.equal((await lost.json()).outcome,"UNKNOWN");assert.equal((await send(11,"status")).state,"paused");
				const retry=await post();assert.equal(retry.status,200);assert.equal((await retry.json()).data.state,"paused");
				const[count]=await pool.query<any[]>("SELECT COUNT(*) n FROM operator_runtime_pause_segments WHERE instance='tenant-a' AND operator_id=11");assert.equal(count[0].n,1);
			}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
		});
		await t.test("configured missing policy row fails closed and explicit OFF remains compatible",async()=>{
			await assert.rejects(send(7,"status",{},"tenant-missing"),{code:"OPERATOR_AVAILABILITY_UNAVAILABLE"});
			await pool.query("UPDATE operator_runtime_policy SET enabled=0 WHERE instance='tenant-b'");assert.equal((await send(7,"status",{},"tenant-b")).enabled,false);
		});
		await t.test("offline incoming journal prepare then resume retains its pause version and cannot release a newer pause",async()=>{
			const initial=await send(14,"pause",{operationId:randomUUID(),kind:"now",reasonId:1,reasonSnapshot:r,expectedVersion:0}),callId=randomUUID();
			await send(14,"prepare",{callId,direction:"incoming",number:"100"});assert.equal((await send(14,"status")).version,initial.version);
			const resume={operationId:randomUUID(),kind:"resume",expectedVersion:initial.version,occurredAt:new Date().toISOString()};
			await send(14,"pause",resume);await send(14,"event",{eventId:randomUUID(),callId,type:"answered",occurredAt:new Date().toISOString(),sipCallId:"fixture-observation-only"});
			let current=await send(14,"status");assert.equal(current.state,"available");assert.equal(current.unavailableSince,null);assert.equal(current.activeCallId,callId);
			await send(14,"event",{eventId:randomUUID(),callId,type:"ended",occurredAt:new Date().toISOString()});current=await send(14,"status");
			const newer=await send(14,"pause",{operationId:randomUUID(),kind:"now",reasonId:1,reasonSnapshot:r,expectedVersion:current.version});
			await send(14,"pause",resume);assert.equal((await send(14,"status")).state,"paused");assert.equal((await send(14,"status")).unavailableSince,newer.unavailableSince);
			await assert.rejects(send(14,"pause",{...resume,operationId:randomUUID()}),{code:"OPERATOR_RUNTIME_VERSION_CONFLICT"});
		});
		await t.test("observed metrics union browser tabs and retain unavailable CRM indicators as null",async()=>{
			await pool.execute("INSERT INTO operator_runtime_calls(instance,id,operator_id,direction,number,state,prepared_at,sent_at,answered_at,ended_at,updated_at) VALUES('tenant-a',?,19,'outgoing','100','ended',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 300 SECOND),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 300 SECOND),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 240 SECOND),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 60 SECOND),UTC_TIMESTAMP())",[randomUUID()]);
			await pool.execute("INSERT INTO operator_runtime_pause_segments(instance,id,operator_id,reason_id,reason_name,max_seconds,productive,started_at,ended_at,operation_id) VALUES('tenant-a',?,19,1,'Fixture',60,1,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 120 SECOND),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 SECOND),?)",[randomUUID(),randomUUID()]);
			for(const[start,end]of [[240,60],[180,0]])await pool.execute(`INSERT INTO operator_runtime_web_sessions(instance,operator_id,session_id,segment_id,started_at,observed_at) VALUES('tenant-a',19,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL ${start} SECOND),DATE_SUB(UTC_TIMESTAMP(),INTERVAL ${end} SECOND))`,[randomUUID(),randomUUID()]);
			const value=await send(19,"metrics",{periodStart:new Date(Date.now()-3600000).toISOString(),crmDay:new Date().toISOString().slice(0,10)});assert.equal(value.conversationSeconds,180);assert.equal(value.pauseSeconds,90);assert.equal(value.productivePauseSeconds,60);assert.equal(value.connectedSeconds,240);assert.equal(value.contacts,null);assert.equal(value.availability.contacts,false);assert.equal(value.closedOrders,null);
		});
	}finally{await pool.end();assert(/^central_runtime_[0-9_]+$/.test(name));await admin.query(`DROP DATABASE \`${name}\``);await admin.end();}
});
