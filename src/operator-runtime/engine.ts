import { createHash, randomUUID } from "node:crypto";
import { canonicalRuntimeInstance, centralPolicyRequiresProfile, lockRuntimeAdmission, readRuntimePolicy, OperatorRuntimeError, type CentralOperatorState, type CentralRuntimePolicy, type RuntimeDb, type RuntimeRow, type RuntimeTx } from "./core";
import { boundedText, invalid, iso, positive, uuid, type CentralCommand } from "./contract";
import { centralRuntimeMetrics } from "./metrics";
import { assertOperatorFeature, operatorFeatures, OperatorFeatureError } from "../operator-features/rollout";

const fail = (code: string): never => { throw new OperatorRuntimeError("OPERATOR_RUNTIME_"+code); };
const canonical = (value: unknown): string => value && typeof value === "object" ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical((value as RuntimeRow)[k])).join(",")}}` : JSON.stringify(value);
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const rows = <T=RuntimeRow>(tx: RuntimeTx, sql: string, ...values: unknown[]) => tx.$queryRawUnsafe<T[]>(sql,...values);
async function clock(tx: RuntimeTx) { return (await rows(tx,"SELECT UTC_TIMESTAMP(3) AS now"))[0]!["now"]; }
function observed(value: unknown, now: unknown): string {
	const raw=boundedText(value,40);
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw) || !Number.isFinite(Date.parse(raw)) || Date.parse(raw)>Date.parse(iso(now)!)+300000) return invalid();
	return new Date(raw).toISOString().slice(0,23).replace("T"," ");
}
async function receipt(tx: RuntimeTx, instance: string, actorId: number, id: string, kind: string, input: unknown) {
	const found=(await rows(tx,"SELECT actor_id,request_hash,result_json FROM operator_runtime_operations WHERE instance=? AND operation_id=? FOR UPDATE",instance,id))[0];
	if (!found) return null;
	if (Number(found["actor_id"])!==actorId || found["request_hash"]!==digest({actorId,kind,input})) return fail("OPERATION_REUSED");
	return JSON.parse(String(found["result_json"])) as RuntimeRow;
}
async function save(tx: RuntimeTx, instance: string, actorId: number, id: string, kind: string, input: unknown, result: unknown) {
	await tx.$executeRawUnsafe("INSERT INTO operator_runtime_operations(instance,operation_id,actor_id,kind,request_hash,result_json,created_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3))",instance,id,actorId,kind,digest({actorId,kind,input}),JSON.stringify(result));
}
export function disabledState() { return {authority:"central-v1",enabled:false,state:"available",version:0,reasons:[],serverNow:new Date().toISOString(),scope:"telephony",requestedScope:"telephony",scopeReady:false,scopeStorageReady:false,policyRevision:null,afterAttendanceScope:"telephony_schedule",channels:{telephony:{supported:false,enforced:false},whatsapp:{supported:false,enforced:false}}}; }
async function stateView(tx: RuntimeTx, instance: string, actorId: number, policy: CentralRuntimePolicy) {
	const s=(await rows(tx,"SELECT * FROM operator_runtime_state WHERE instance=? AND operator_id=?",instance,actorId))[0];
	const segment=s?.["pause_id"] ? (await rows(tx,"SELECT * FROM operator_runtime_pause_segments WHERE instance=? AND id=?",instance,s["pause_id"]))[0] : undefined;
	return {
		authority:"central-v1",enabled:true,state:s?.["state"]||"available",version:Number(s?.["version"]||0),
		activeCallId:s?.["active_call_id"]??null,pendingScheduleId:s?.["pending_schedule_id"]==null?null:Number(s["pending_schedule_id"]),
		pendingCallId:s?.["pending_call_id"]??null,pendingOperationId:s?.["pending_operation_id"]??null,
		reasonId:s?.["reason_id"]==null?null:Number(s["reason_id"]),pauseId:s?.["pause_id"]??null,reason:s?.["reason_name"]??null,
		startedAt:iso(segment?.["started_at"]),unavailableSince:iso(s?.["unavailable_since"]),maxSeconds:Number(segment?.["max_seconds"]||0),
		reasons:[],allowChangeReason:false,serverNow:iso(await clock(tx)),scope:"all_channels",requestedScope:"all_channels",scopeReady:true,
		scopeStorageReady:true,policyRevision:policy.reviewSha256,policyVersion:policy.revision,afterAttendanceScope:"telephony_schedule",
		channels:{telephony:{supported:true,enforced:true},whatsapp:{supported:true,enforced:true}},
		pbx:{status:"not_configured",detail:"Pausa aplicada às novas entradas no CRM e WhatsApp."},
	};
}
interface Reason {id:number;name:string;maxSeconds:number;productive:boolean}
function reason(value: unknown): Reason {
	if (!value || typeof value!=="object" || Array.isArray(value)) return invalid();
	const r=value as RuntimeRow,id=positive(r["id"])!,name=boundedText(r["name"],255),maxSeconds=r["maxSeconds"];
	if (!Number.isSafeInteger(maxSeconds)||Number(maxSeconds)<0||Number(maxSeconds)>2147483647||typeof r["productive"]!=="boolean") return invalid();
	return {id,name,maxSeconds:Number(maxSeconds),productive:r["productive"]};
}
async function closePause(tx: RuntimeTx, instance: string, s: CentralOperatorState, at: unknown) {
	if (!s.pauseId) return;
	const old=(await rows(tx,"SELECT started_at FROM operator_runtime_pause_segments WHERE instance=? AND id=? FOR UPDATE",instance,s.pauseId))[0];
	if (!old || Date.parse(iso(at)!)<Date.parse(iso(old["started_at"])!)) return fail("INVALID_REQUEST");
	await tx.$executeRawUnsafe("UPDATE operator_runtime_pause_segments SET ended_at=?,duration_seconds=GREATEST(0,TIMESTAMPDIFF(SECOND,started_at,?)),exceeded_seconds=IF(max_seconds>0,GREATEST(0,TIMESTAMPDIFF(SECOND,started_at,?)-max_seconds),0) WHERE instance=? AND id=? AND ended_at IS NULL",at,at,at,instance,s.pauseId);
}
async function beginPause(tx: RuntimeTx, instance: string, s: CentralOperatorState, r: Reason, at: unknown, operationId: string) {
	const id=randomUUID();
	await tx.$executeRawUnsafe("INSERT INTO operator_runtime_pause_segments(instance,id,operator_id,reason_id,reason_name,max_seconds,productive,started_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?)",instance,id,s.operatorId,r.id,r.name,r.maxSeconds,r.productive?1:0,at,operationId);
	await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET state='paused',reason_id=?,reason_name=?,reason_snapshot_json=?,pause_id=?,pending_schedule_id=NULL,pending_call_id=NULL,pending_operation_id=NULL,unavailable_since=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",r.id,r.name,JSON.stringify(r),id,s.state==="available"?at:s.unavailableSince,instance,s.operatorId);
}
async function activateVerifiedPending(tx: RuntimeTx, instance: string, s: CentralOperatorState) {
	if(s.state!=="pending"||s.activeCallId||!s.pendingScheduleId||!s.pendingOperationId)return;
	const intent=(await rows(tx,"SELECT id,expected_json FROM operator_runtime_phone_intents WHERE instance=? AND operator_id=? AND schedule_id=? AND kind='legacy_finish' AND status='verified' AND (call_id=? OR (call_id IS NULL AND ? IS NULL)) ORDER BY created_at DESC LIMIT 1 FOR UPDATE",instance,s.operatorId,s.pendingScheduleId,s.pendingCallId,s.pendingCallId))[0];
	if (!intent)return;
	const intentExpected=JSON.parse(String(intent["expected_json"])) as RuntimeRow;
	if(intentExpected["pendingOperationId"]!==s.pendingOperationId)return;
	const pendingReason=reason(s.reasonSnapshot);
	await beginPause(tx,instance,s,pendingReason,await clock(tx),String(intent["id"]));
}
function callView(c: RuntimeRow) { return {callId:c["id"],operatorId:Number(c["operator_id"]),direction:c["direction"],number:c["number"],extension:c["extension"]??null,scheduleId:c["schedule_id"]==null?null:Number(c["schedule_id"]),customerId:c["customer_id"]==null?null:Number(c["customer_id"]),state:c["state"],preparedAt:iso(c["prepared_at"]),sentAt:iso(c["sent_at"]),ringingAt:iso(c["ringing_at"]),answeredAt:iso(c["answered_at"]),endedAt:iso(c["ended_at"]),rating:c["rating"]??null,comment:c["comment"]||"",reviewVersion:Number(c["review_version"]||0),cursor:String(c["sequence_id"])}; }
function finishView(id: string, row?: RuntimeRow) {
	return{operationId:id,outcome:row?.["status"]==="verified"?"COMMITTED":row?.["status"]==="not_committed"?"NOT_COMMITTED":"UNKNOWN",status:!row?"not_found":row["status"]==="verified"?"verified":row["status"]==="not_committed"?"not_committed":"pending_verification",retryAllowed:false};
}
function jsonObject(value: unknown): RuntimeRow {
	if(!value||typeof value!=="object"||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>32768)return invalid();return value as RuntimeRow;
}
export async function executeCentralRuntime(tx: RuntimeTx, instance: string, command: CentralCommand, context: { trustedReconciliation?: boolean } = {}): Promise<unknown> {
	instance=canonicalRuntimeInstance(instance);
	// Signed internal activation probes must observe the actual OFF policy.
	if(command.action==="policy")return{authority:"central-v1",enabled:await centralPolicyRequiresProfile(tx,instance)};
	if (!(context.trustedReconciliation && ["finish.due", "finish.verify"].includes(command.action))) {
		assertOperatorFeature({ instance, userId: command.actorId }, ["policy", "status", "pause", "session", "metrics"].includes(command.action) ? "operator" : "telephony");
	}
	if(command.action==="finish.due"){
		if(!await readRuntimePolicy(tx,instance))return{intents:[]};
		return{intents:await rows(tx,"SELECT id,operator_id,schedule_id,call_id,snapshot_json,expected_json FROM operator_runtime_phone_intents WHERE instance=? AND kind='legacy_finish' AND status IN ('pending','unknown') AND next_attempt_at<=UTC_TIMESTAMP(3) ORDER BY next_attempt_at,id LIMIT 50",instance)};
	}
	const {actorId,action,input}=command,locked=await lockRuntimeAdmission(tx,instance,[actorId]);
	if(!locked.enabled){
		if(operatorFeatures({instance,userId:actorId}).managed)throw new OperatorFeatureError("OPERATOR_FEATURE_PILOT_PENDING",503);
		if(action==="status")return disabledState();return fail("DISABLED");
	}
	const policy=locked.policy!,s=locked.states.get(actorId)!;
	if(action==="status")return stateView(tx,instance,actorId,policy);
	if(action==="metrics")return centralRuntimeMetrics(tx,instance,actorId,input);
	if(action==="pause"){
		const {reasonSnapshot:_snapshot,scheduleOwnerVerified:_owner,changeReasonAllowed:_change,policyRevision:_policy,...semantic}=input;
		const id=uuid(input["operationId"]),kind=boundedText(input["kind"],32),saved=await receipt(tx,instance,actorId,id,"pause",semantic);
		if(saved)return saved;
		if(Number(input["expectedVersion"])!==s.version)return fail("VERSION_CONFLICT");
		const now=await clock(tx);
		if(kind==="now"||kind==="after_attendance"){
			if(s.state!=="available")return fail("INVALID_STATE");
			const r=reason(input["reasonSnapshot"]);
			if(kind==="now"){
				if(s.activeCallId)return fail("CALL_ACTIVE");
				await beginPause(tx,instance,s,r,now,id);
			}else{
				const scheduleId=positive(input["scheduleId"])!,callId=input["callId"]==null?null:uuid(input["callId"]);
				const call=(await rows(tx,"SELECT id FROM operator_runtime_calls WHERE instance=? AND operator_id=? AND schedule_id=? AND id=? FOR UPDATE",instance,actorId,scheduleId,callId))[0];
				if(!call||input["scheduleOwnerVerified"]!==true)return fail("SCHEDULE_UNAVAILABLE");
				await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET state='pending',reason_id=?,reason_name=?,reason_snapshot_json=?,pending_schedule_id=?,pending_call_id=?,pending_operation_id=?,unavailable_since=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",r.id,r.name,JSON.stringify(r),scheduleId,callId,id,now,instance,actorId);
			}
		}else if(kind==="resume"||kind==="cancel_pending"){
			if(s.state!==(kind==="resume"?"paused":"pending"))return fail("INVALID_STATE");
			const at=kind==="resume"&&input["occurredAt"]?observed(input["occurredAt"],now):now;
			await closePause(tx,instance,s,at);
			await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET state='available',reason_id=NULL,reason_name=NULL,reason_snapshot_json=NULL,pause_id=NULL,pending_schedule_id=NULL,pending_call_id=NULL,pending_operation_id=NULL,unavailable_since=NULL,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",instance,actorId);
		}else if(kind==="change_reason"){
			if(s.state!=="paused"||input["changeReasonAllowed"]!==true)return fail("INVALID_STATE");
			await closePause(tx,instance,s,now);await beginPause(tx,instance,s,reason(input["reasonSnapshot"]),now,id);
		}else if(kind==="release_lost"){
			if(!s.activeCallId||input["confirmNoCall"]!==true)return fail("INVALID_STATE");
			await tx.$executeRawUnsafe("UPDATE operator_runtime_calls SET state='observation_lost',updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND id=? AND operator_id=? AND ended_at IS NULL",instance,s.activeCallId,actorId);
			await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET active_call_id=NULL,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",instance,actorId);
		}else return invalid();
		const result=await stateView(tx,instance,actorId,policy);await save(tx,instance,actorId,id,"pause",semantic,result);return result;
	}
	if(action==="prepare"){
		const id=uuid(input["callId"]),direction=boundedText(input["direction"],12),number=boundedText(input["number"],64),scheduleId=positive(input["scheduleId"],true);
		if(!["incoming","outgoing"].includes(direction)||(direction==="outgoing"&&!/^\+?[0-9*#]{1,32}$/.test(number)))return invalid();
		const old=(await rows(tx,"SELECT * FROM operator_runtime_calls WHERE instance=? AND id=? FOR UPDATE",instance,id))[0];
		if(old){
			if(Number(old["operator_id"])!==actorId||old["direction"]!==direction||old["number"]!==number||(old["schedule_id"]==null?null:Number(old["schedule_id"]))!==scheduleId||(old["extension"]??null)!==(boundedText(input["extension"],32,true)||null)||(old["customer_id"]==null?null:Number(old["customer_id"]))!==positive(input["customerId"],true))return fail("OPERATION_REUSED");
			const intent=input["legacyTrace"]===true?(await rows(tx,"SELECT status FROM operator_runtime_phone_intents WHERE instance=? AND id=? AND operator_id=? AND kind='legacy_prepare' FOR UPDATE",instance,id,actorId))[0]:null;
			if(input["legacyTrace"]===true&&!intent)return fail("OPERATION_REUSED");
			return{...callView(old),created:false,...(intent?{traceVerified:intent["status"]==="verified"}:{})};
		}
		if(direction==="outgoing"){
			if(s.state!=="available"&&!(s.state==="pending"&&scheduleId&&s.pendingScheduleId===scheduleId))throw new OperatorRuntimeError("OPERATOR_PAUSED");
			if(s.activeCallId)return fail("CALL_ACTIVE");
			if(scheduleId&&input["scheduleOwnerVerified"]!==true)return fail("SCHEDULE_UNAVAILABLE");
			if(s.state==="pending"&&(await rows(tx,"SELECT id FROM operator_runtime_phone_intents WHERE instance=? AND operator_id=? AND schedule_id=? AND kind='legacy_finish' AND (call_id=? OR (call_id IS NULL AND ? IS NULL)) AND status IN ('pending','unknown','verified') LIMIT 1 FOR UPDATE",instance,actorId,scheduleId,s.pendingCallId,s.pendingCallId)).length)return fail("FINISH_PENDING");
		}
		await tx.$executeRawUnsafe("INSERT INTO operator_runtime_calls(instance,id,operator_id,direction,number,extension,schedule_id,customer_id,state,prepared_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'prepared',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",instance,id,actorId,direction,number,boundedText(input["extension"],32,true)||null,scheduleId,positive(input["customerId"],true));
		if(direction==="outgoing")await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET active_call_id=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",id,instance,actorId);
		const created=(await rows(tx,"SELECT * FROM operator_runtime_calls WHERE instance=? AND id=?",instance,id))[0]!;
		if(input["legacyTrace"]===true){
			if(!scheduleId||direction!=="outgoing")return invalid();
			await tx.$executeRawUnsafe("INSERT INTO operator_runtime_phone_intents(instance,id,operator_id,schedule_id,call_id,kind,status,snapshot_json,expected_json,created_at,next_attempt_at) VALUES(?,?,?,?,?,'legacy_prepare','pending','{}',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",instance,id,actorId,scheduleId,id,JSON.stringify({startedAt:iso(created["prepared_at"])!.slice(0,19).replace("T"," "),number,operatorId:actorId,scheduleId}));
		}
		return{...callView(created),created:true,...(input["legacyTrace"]===true?{traceVerified:false}:{})};
	}
	if(action==="legacy.prepare.verify"){
		const id=uuid(input["callId"]),intent=(await rows(tx,"SELECT expected_json,status FROM operator_runtime_phone_intents WHERE instance=? AND id=? AND operator_id=? AND kind='legacy_prepare' FOR UPDATE",instance,id,actorId))[0];
		if(!intent)return fail("CALL_UNAVAILABLE");
		if(input["expectedHash"]!==digest(JSON.parse(String(intent["expected_json"]))))return fail("OPERATION_REUSED");
		if(input["traceMatches"]!==true)return{traceVerified:false};
		await tx.$executeRawUnsafe("UPDATE operator_runtime_phone_intents SET status='verified',checked_at=UTC_TIMESTAMP(3) WHERE instance=? AND id=?",instance,id);
		return{traceVerified:true};
	}
	if(action==="event"){
		const callId=uuid(input["callId"]),id=uuid(input["eventId"]),type=boundedText(input["type"],24),saved=await receipt(tx,instance,actorId,id,"event",input);if(saved)return saved;
		if(!["sent","ringing","answered","ended","failed","rejected","transferred"].includes(type))return invalid();
		const call=(await rows(tx,"SELECT * FROM operator_runtime_calls WHERE instance=? AND id=? AND operator_id=? FOR UPDATE",instance,callId,actorId))[0];if(!call)return fail("CALL_UNAVAILABLE");
		const now=await clock(tx),at=observed(input["occurredAt"],now),terminal=["ended","failed","rejected","transferred"].includes(type),column={sent:"sent_at",ringing:"ringing_at",answered:"answered_at",ended:"ended_at",failed:"ended_at",rejected:"ended_at",transferred:"ended_at"}[type]!;
		await tx.$executeRawUnsafe("INSERT INTO operator_runtime_call_events(instance,id,call_id,operator_id,type,occurred_at,received_at,detail,sip_call_id) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3),?,?)",instance,id,callId,actorId,type,at,boundedText(input["detail"],1000,true)||null,boundedText(input["sipCallId"],255,true)||null);
		await tx.$executeRawUnsafe(`UPDATE operator_runtime_calls SET ${column}=IF(${column} IS NULL OR ${column}>?,?,${column}),state=?,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND id=?`,at,at,call["ended_at"]&&!terminal?call["state"]:type,instance,callId);
		if(type==="answered"&&!call["ended_at"])await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET active_call_id=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",callId,instance,actorId);
		if(terminal&&s.activeCallId===callId){await tx.$executeRawUnsafe("UPDATE operator_runtime_state SET active_call_id=NULL,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND operator_id=?",instance,actorId);s.activeCallId=null;await activateVerifiedPending(tx,instance,s);}
		await save(tx,instance,actorId,id,"event",input,{applied:true});return{applied:true};
	}
	if(action==="get"||action==="list"){
		const requested=input["operatorId"]==null?actorId:positive(input["operatorId"])!;if(requested!==actorId&&input["actorRole"]!=="ADMIN")return fail("FORBIDDEN");
		const params:unknown[]=[instance,requested];let filter="instance=? AND operator_id=?";
		if(action==="get"){filter+=" AND id=?";params.push(uuid(input["callId"]));}
		if(input["before"]!=null){const before=String(input["before"]);if(!/^[1-9]\d{0,19}$/.test(before))return invalid();filter+=" AND sequence_id<?";params.push(before);}
		const limit=input["limit"]==null?50:positive(input["limit"])!;if(limit>100)return invalid();
		return{calls:(await rows(tx,`SELECT * FROM operator_runtime_calls WHERE ${filter} ORDER BY sequence_id DESC LIMIT ${limit}`,...params)).map(callView)};
	}
	if(action==="review"){
		const id=uuid(input["operationId"]),callId=uuid(input["callId"]),saved=await receipt(tx,instance,actorId,id,"review",input);if(saved)return saved;
		const call=(await rows(tx,"SELECT * FROM operator_runtime_calls WHERE instance=? AND id=? AND operator_id=? FOR UPDATE",instance,callId,actorId))[0];
		if(!call||(!call["ended_at"]&&call["state"]!=="observation_lost"))return fail("CALL_UNAVAILABLE");
		if(Number(input["expectedVersion"])!==Number(call["review_version"]))return fail("VERSION_CONFLICT");
		const rating=input["rating"]??null;if(rating!==null&&!["RUIM","MÉDIA","BOA"].includes(String(rating)))return invalid();
		const version=Number(call["review_version"])+1;await tx.$executeRawUnsafe("UPDATE operator_runtime_calls SET rating=?,comment=?,review_version=?,updated_at=UTC_TIMESTAMP(3) WHERE instance=? AND id=?",rating,boundedText(input["comment"],1000,true),version,instance,callId);await save(tx,instance,actorId,id,"review",input,{version});return{version};
	}
	if(action==="finish.begin"){
		const id=uuid(input["operationId"]),scheduleId=positive(input["scheduleId"])!,callId=input["callId"]==null?null:uuid(input["callId"]),requestHash=digest(jsonObject(input["request"]));
		const old=(await rows(tx,"SELECT * FROM operator_runtime_phone_intents WHERE instance=? AND id=? FOR UPDATE",instance,id))[0];
		if(old){const expected=JSON.parse(String(old["expected_json"])) as RuntimeRow;if(Number(old["operator_id"])!==actorId||Number(old["schedule_id"])!==scheduleId||expected["requestHash"]!==requestHash)return fail("OPERATION_REUSED");return{...finishView(id,old),created:false,proof:JSON.parse(String(old["snapshot_json"]))};}
		if(s.activeCallId)return fail("CALL_ACTIVE");
		const other=(await rows(tx,"SELECT id FROM operator_runtime_phone_intents WHERE instance=? AND operator_id=? AND schedule_id=? AND kind='legacy_finish' AND status IN ('pending','unknown') LIMIT 1 FOR UPDATE",instance,actorId,scheduleId))[0];if(other)return fail("FINISH_PENDING");
		const snapshot=jsonObject(input["snapshot"]),expected={requestHash,crm:jsonObject(input["expected"]),pendingOperationId:s.state==="pending"&&s.pendingScheduleId===scheduleId?s.pendingOperationId:null};
		await tx.$executeRawUnsafe("INSERT INTO operator_runtime_phone_intents(instance,id,operator_id,schedule_id,call_id,kind,status,snapshot_json,expected_json,created_at,next_attempt_at) VALUES(?,?,?,?,?,'legacy_finish','pending',?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 SECOND))",instance,id,actorId,scheduleId,callId,JSON.stringify(snapshot),JSON.stringify(expected));
		return{...finishView(id,{status:"pending"}),created:true,proof:snapshot};
	}
	if(action==="finish.status"||action==="finish.inspect"||action==="finish.verify"){
		const id=uuid(input["operationId"]),intent=(await rows(tx,"SELECT * FROM operator_runtime_phone_intents WHERE instance=? AND id=? AND operator_id=? FOR UPDATE",instance,id,actorId))[0];
		if(action==="finish.inspect")return{...finishView(id,intent),...(intent?{proof:JSON.parse(String(intent["snapshot_json"])),requestHash:(JSON.parse(String(intent["expected_json"])) as RuntimeRow)["requestHash"],scheduleId:Number(intent["schedule_id"])}:{})};
		if(action==="finish.status"||!intent||intent["status"]==="verified"||intent["status"]==="not_committed")return finishView(id,intent);
		const expected=JSON.parse(String(intent["expected_json"])) as RuntimeRow;
		if(input["expectedHash"]!==digest(expected["crm"]))return fail("OPERATION_REUSED");
		const proof=jsonObject(input["proof"]),verified=proof["outcome"]==="VERIFIED";
		if(verified&&(!/^[1-9]\d{0,19}$/.test(String(proof["historyId"]||""))||Number(proof["scheduleId"])!==Number(intent["schedule_id"])||Number(proof["operatorId"])!==actorId))return invalid();
		if(!["VERIFIED","UNKNOWN","NOT_COMMITTED"].includes(String(proof["outcome"])))return invalid();
		const status=verified?"verified":proof["outcome"]==="NOT_COMMITTED"?"not_committed":"unknown";
		await tx.$executeRawUnsafe("UPDATE operator_runtime_phone_intents SET status=?,observed_json=?,checked_at=UTC_TIMESTAMP(3),next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 SECOND),error_code=? WHERE instance=? AND id=?",status,JSON.stringify(proof),verified?null:"CRM_FINISH_UNCONFIRMED",instance,id);
		if(verified)await activateVerifiedPending(tx,instance,s);
		return finishView(id,{status});
	}
	if(action==="session"){
		const sessionId=uuid(input["sessionId"]),kind=boundedText(input["kind"],16);if(!["connect","heartbeat","disconnect"].includes(kind))return invalid();
		const now=await clock(tx),old=(await rows(tx,"SELECT * FROM operator_runtime_web_sessions WHERE instance=? AND operator_id=? AND session_id=? ORDER BY observed_at DESC LIMIT 1 FOR UPDATE",instance,actorId,sessionId))[0];
		const nowMs=Date.parse(iso(now)!),observedMs=old?Date.parse(iso(old["observed_at"])!):0,continuous=old&&old["ended_at"]==null&&nowMs-observedMs<=60000;
		if(continuous){await tx.$executeRawUnsafe("UPDATE operator_runtime_web_sessions SET observed_at=?,ended_at=? WHERE instance=? AND segment_id=?",now,kind==="disconnect"?now:null,instance,old["segment_id"]);}
		else{
			if(old&&old["ended_at"]==null)await tx.$executeRawUnsafe("UPDATE operator_runtime_web_sessions SET ended_at=? WHERE instance=? AND segment_id=?",new Date(Math.min(nowMs,observedMs+60000)),instance,old["segment_id"]);
			if(kind!=="disconnect")await tx.$executeRawUnsafe("INSERT INTO operator_runtime_web_sessions(instance,operator_id,session_id,segment_id,started_at,observed_at) VALUES(?,?,?,?,?,?)",instance,actorId,sessionId,randomUUID(),now,now);
		}
		return{observed:true};
	}
	return fail("INVALID_REQUEST");
}
export async function runCentralRuntime(database: RuntimeDb, instance: string, command: CentralCommand, context: { trustedReconciliation?: boolean } = {}) {
	return database.$transaction(tx=>executeCentralRuntime(tx,instance,command,context));
}
