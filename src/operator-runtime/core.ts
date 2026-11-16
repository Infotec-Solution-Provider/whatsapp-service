import { readOperatorFeaturePolicy } from "../operator-features/rollout";
/** Shared SQL authority. Never opens a connection, contacts CRM or sends to a provider. */
export interface RuntimeTx {
	$queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): PromiseLike<T>;
	$executeRawUnsafe(sql: string, ...values: unknown[]): PromiseLike<number>;
}
export interface RuntimeDb {
	$transaction<T>(work: (tx: RuntimeTx) => Promise<T>): Promise<T>;
}
export class OperatorRuntimeError extends Error {
	readonly outcome = "NOT_COMMITTED";
	constructor(readonly code: string, readonly status = 409) { super(code); }
}
export const unavailable = (): never => { throw new OperatorRuntimeError("OPERATOR_AVAILABILITY_UNAVAILABLE", 503); };
export interface CentralRuntimePolicy { revision: number; reviewSha256: string }
export interface CentralOperatorState {
	ignored?: boolean;
	operatorId: number;
	state: "available" | "pending" | "paused";
	version: number;
	unavailableSince: Date | string | null;
	activeCallId: string | null;
	pendingScheduleId: number | null;
	pendingCallId: string | null;
	pendingOperationId: string | null;
	pauseId: string | null;
	reasonId: number | null;
	reasonName: string | null;
	reasonSnapshot: RuntimeRow | null;
}
export type RuntimeRow = Record<string, unknown>;
export function validInstance(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
}
export function canonicalRuntimeInstance(value: unknown): string {
	if (typeof value !== "string") return unavailable();
	const canonical=value.trim().toLowerCase();
	if(!validInstance(canonical))return unavailable();return canonical;
}
/** Persistent ON policy prevents missing/unlisted profile from disabling guards after restart. */
export async function centralPolicyRequiresProfile(tx: RuntimeTx, instance: string): Promise<boolean> {
	instance=canonicalRuntimeInstance(instance);
	try {
		const present=await tx.$queryRawUnsafe<RuntimeRow[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='operator_runtime_policy'");
		if(!present.length)return false;
		const row=(await tx.$queryRawUnsafe<RuntimeRow[]>("SELECT enabled FROM operator_runtime_policy WHERE instance=? LOCK IN SHARE MODE",instance))[0];
		if(!row||Number(row["enabled"])===0)return false;
		if(Number(row["enabled"])!==1)return unavailable();return true;
	}catch(error){if(error instanceof OperatorRuntimeError)throw error;return unavailable();}
}
export function validActor(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
export function stateFromRow(row: RuntimeRow): CentralOperatorState {
	const state = row["state"];
	if (!["available", "pending", "paused"].includes(String(state))) return unavailable();
	return {
		operatorId: Number(row["operator_id"]), state: state as CentralOperatorState["state"], version: Number(row["version"]),
		unavailableSince: row["unavailable_since"] as Date | string | null,
		activeCallId: row["active_call_id"] == null ? null : String(row["active_call_id"]),
		pendingScheduleId: row["pending_schedule_id"] == null ? null : Number(row["pending_schedule_id"]),
		pendingCallId: row["pending_call_id"] == null ? null : String(row["pending_call_id"]),
		pendingOperationId: row["pending_operation_id"] == null ? null : String(row["pending_operation_id"]),
		pauseId: row["pause_id"] == null ? null : String(row["pause_id"]),
		reasonId: row["reason_id"] == null ? null : Number(row["reason_id"]),
		reasonName: row["reason_name"] == null ? null : String(row["reason_name"]),
		reasonSnapshot: row["reason_snapshot_json"] == null ? null : JSON.parse(String(row["reason_snapshot_json"])) as RuntimeRow,
	};
}
export async function readRuntimePolicy(tx: RuntimeTx, instance: string): Promise<CentralRuntimePolicy | null> {
	instance=canonicalRuntimeInstance(instance);
	try {
		const present = await tx.$queryRawUnsafe<RuntimeRow[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='operator_runtime_policy'");
		// Caller opted into the dedicated central profile. Missing schema/row is
		// unavailable even after restart; only an explicit intact OFF row is legacy.
		if (!present.length) return unavailable();
		const rows = await tx.$queryRawUnsafe<RuntimeRow[]>("SELECT enabled,schema_version,revision,review_sha256 FROM operator_runtime_policy WHERE instance=? LOCK IN SHARE MODE", instance);
		const row = rows[0];
		if (!row || Number(row["schema_version"]) !== 1 || !Number.isSafeInteger(Number(row["revision"])) || Number(row["revision"]) < 1) return unavailable();
		if (Number(row["enabled"]) === 0) return null;
		if (Number(row["enabled"]) !== 1 || Number(row["schema_version"]) !== 1 || !Number.isSafeInteger(Number(row["revision"])) || Number(row["revision"]) < 1 || !/^[a-f0-9]{64}$/.test(String(row["review_sha256"]))) return unavailable();
		return { revision: Number(row["revision"]), reviewSha256: String(row["review_sha256"]) };
	} catch (error) { if (error instanceof OperatorRuntimeError) throw error; return unavailable(); }
}
/** Must run in the SAME transaction which writes the WhatsApp assignment/message. */
export async function lockRuntimeAdmission(tx: RuntimeTx, instance: string, actorIds: number[]): Promise<{enabled: boolean; policy: CentralRuntimePolicy | null; states: Map<number, CentralOperatorState>}> {
	instance=canonicalRuntimeInstance(instance);
	const policy = await readRuntimePolicy(tx, instance), states = new Map<number, CentralOperatorState>();
	if (!policy) return { enabled: false, policy, states };
	if (actorIds.length > 200 || actorIds.some(id => !validActor(id))) return unavailable();
	try {
		const pilot = instance === "odim" ? readOperatorFeaturePolicy() : null;
		for (const id of [...new Set(actorIds)].sort((a,b) => a-b)) {
			if (pilot && (!pilot.features.operator || !pilot.allowedOperatorIds.includes(id))) {
				states.set(id, { operatorId: id, ignored: true, state: "available", version: 0, unavailableSince: null,
					activeCallId: null, pendingScheduleId: null, pendingCallId: null, pendingOperationId: null, pauseId: null,
					reasonId: null, reasonName: null, reasonSnapshot: null });
				continue;
			}
			await tx.$executeRawUnsafe("INSERT INTO operator_runtime_state(instance,operator_id) VALUES(?,?) ON DUPLICATE KEY UPDATE operator_id=VALUES(operator_id)", instance, id);
			const rows = await tx.$queryRawUnsafe<RuntimeRow[]>("SELECT * FROM operator_runtime_state WHERE instance=? AND operator_id=? FOR UPDATE", instance, id);
			if (!rows[0]) return unavailable();
			states.set(id, stateFromRow(rows[0]));
		}
		return { enabled: true, policy, states };
	} catch (error) { if (error instanceof OperatorRuntimeError) throw error; return unavailable(); }
}
