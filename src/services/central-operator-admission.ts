import { canonicalRuntimeInstance, centralPolicyRequiresProfile, lockRuntimeAdmission, type RuntimeTx } from "../operator-runtime/core";
import { isCentralRuntimeConfigured } from "../operator-runtime/config";
import { pauseSendTargetMatches } from "../utils/operator-pause-peer";

export type PauseAdmissionTransaction = RuntimeTx;
export interface ChatAssignmentAdmission {
	instance: string;
	recipientId?: number | null | undefined;
	/** Human initiating a new attendance, even when its destination is shared. */
	initiatorId?: number;
	chatId?: number;
}
export interface HumanSendAdmission {
	instance: string;
	actorId: number;
	chatId?: number | null;
	contactId?: number | null;
	to?: unknown;
}
type Row = Record<string, unknown>;
export const PAUSE_ADMISSION_CODES = ["OPERATOR_PAUSED", "OPERATOR_AVAILABILITY_UNAVAILABLE"] as const;
export class OperatorPauseAdmissionError extends Error {
	readonly outcome = "NOT_COMMITTED";
	readonly status: number;
	constructor(readonly code: typeof PAUSE_ADMISSION_CODES[number]) {
		super(code === "OPERATOR_PAUSED"
			? "Operador em pausa. Retome a operação na barra superior para iniciar um novo atendimento."
			: "Não foi possível conferir a disponibilidade do operador. Tente novamente em instantes.");
		this.status = code === "OPERATOR_PAUSED" ? 409 : 503;
	}
}
export function pauseAdmissionFailure(error: unknown): OperatorPauseAdmissionError | null {
	const seen = new Set<unknown>();
	let current = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const code = (current as Row)["code"];
		if (PAUSE_ADMISSION_CODES.includes(code as typeof PAUSE_ADMISSION_CODES[number])) return current as OperatorPauseAdmissionError;
		current = (current as Row)["cause"];
	}
	return null;
}
const unavailable = () => new OperatorPauseAdmissionError("OPERATOR_AVAILABILITY_UNAVAILABLE");
const humanId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Unlisted legacy tenants retain their existing nested writes. Configured writers lock in their transaction. */
export async function centralAdmissionRequired(tx: RuntimeTx, instance: string): Promise<boolean> {
	instance = canonicalRuntimeInstance(instance);
	if (!isCentralRuntimeConfigured(instance)) {
		if (await centralPolicyRequiresProfile(tx, instance)) throw unavailable();
		return false;
	}
	return true;
}
const configuredLock: typeof lockRuntimeAdmission = async (tx, instance, ids) => {
	instance = canonicalRuntimeInstance(instance);
	if (!await centralAdmissionRequired(tx, instance)) return { enabled: false, policy: null, states: new Map() };
	return lockRuntimeAdmission(tx, instance, ids);
};
function recipientId(value: unknown): number | null {
	if (value == null) return null;
	const id = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
	if (typeof id !== "number" || !Number.isSafeInteger(id)) throw unavailable();
	return id;
}

/** Central availability and central attendance writes share one MySQL transaction. */
export class CentralOperatorAdmission {
	constructor(private readonly lock = configuredLock) {}
	async assert(tx: RuntimeTx, input: ChatAssignmentAdmission): Promise<void> {
		try {
			const scope = { ...input, instance: canonicalRuntimeInstance(input.instance) };
			if (scope.initiatorId !== undefined && !humanId(scope.initiatorId)) throw unavailable();
			const target = recipientId(scope.recipientId);
			const ids = [...new Set([target, scope.initiatorId].filter(humanId))].sort((a, b) => a - b);
			const admission = await this.lock(tx, scope.instance, ids);
			if (!admission.enabled) return;
			// Policy -> sorted operators -> chat is also the pause/assignment lock order.
			let previousId: number | null = null;
			let wasOpen = false;
			if (scope.chatId !== undefined) {
				const previous = (await tx.$queryRawUnsafe<Row[]>("SELECT user_id,is_finished,is_schedule,started_at FROM chats WHERE id=? AND instance=? FOR UPDATE", scope.chatId, scope.instance))[0];
				if (!previous) throw unavailable();
				previousId = previous["user_id"] == null ? null : Number(previous["user_id"]);
				wasOpen = Number(previous["is_finished"]) === 0 && Number(previous["is_schedule"]) === 0 && previous["started_at"] != null;
			}
			const required = new Set<number>();
			if (humanId(scope.initiatorId)) required.add(scope.initiatorId);
			if (humanId(target) && (!wasOpen || previousId !== target)) required.add(target);
			for (const id of required) {
				const candidate = admission.states.get(id);
				if (!candidate) throw unavailable();
				if (candidate.state === "pending" || candidate.state === "paused") throw new OperatorPauseAdmissionError("OPERATOR_PAUSED");
				if (candidate.state !== "available") throw unavailable();
			}
		} catch (error) { throw pauseAdmissionFailure(error) ?? unavailable(); }
	}

	/** Legacy providers run after this transaction; durable sends use their enqueue transaction. */
	async assertSend(tx: RuntimeTx, input: HumanSendAdmission): Promise<void> {
		if (!humanId(input.actorId)) return;
		try {
			const scope = { ...input, instance: canonicalRuntimeInstance(input.instance) };
			const admission = await this.lock(tx, scope.instance, [scope.actorId]);
			if (!admission.enabled) return;
			const state = admission.states.get(scope.actorId);
			if (!state) throw unavailable();
			if (state.state === "available") return;
			if (state.state !== "pending" && state.state !== "paused") throw unavailable();
			let chats: Row[] = [];
			if (humanId(scope.chatId)) {
				chats = await tx.$queryRawUnsafe<Row[]>("SELECT ch.id,ch.user_id,ch.is_finished,ch.is_schedule,ch.started_at,c.id AS peer_contact_id,c.phone AS peer_phone,c.whatsapp_id AS peer_whatsapp_id FROM chats ch INNER JOIN contacts c ON c.id=ch.contact_id WHERE ch.id=? AND ch.instance=? AND c.instance=? FOR UPDATE", scope.chatId, scope.instance, scope.instance);
			} else if (humanId(scope.contactId)) {
				chats = await tx.$queryRawUnsafe<Row[]>("SELECT ch.id,ch.user_id,ch.is_finished,ch.is_schedule,ch.started_at,c.id AS peer_contact_id,c.phone AS peer_phone,c.whatsapp_id AS peer_whatsapp_id FROM chats ch INNER JOIN contacts c ON c.id=ch.contact_id WHERE ch.instance=? AND c.instance=? AND ch.contact_id=? AND ch.is_finished=0 AND ch.is_schedule=0 AND ch.started_at IS NOT NULL ORDER BY ch.id LIMIT 2 FOR UPDATE", scope.instance, scope.instance, scope.contactId);
			}
			const chat = chats.length === 1 ? chats[0] : undefined;
			const open = chat && Number(chat["is_finished"]) === 0 && Number(chat["is_schedule"]) === 0 && chat["started_at"] != null;
			if (!chat || (humanId(scope.contactId) && Number(chat["peer_contact_id"]) !== scope.contactId) ||
				!pauseSendTargetMatches(scope.to, chat["peer_phone"], chat["peer_whatsapp_id"])) throw new OperatorPauseAdmissionError("OPERATOR_PAUSED");
			if (open && Number(chat["user_id"]) === scope.actorId) return;
			const millis = (value: unknown): number => value instanceof Date ? value.getTime() : value == null ? NaN
				: Date.parse(String(value).replace(" ", "T") + (/Z$|[+-]\d\d:\d\d$/.test(String(value)) ? "" : "Z"));
			const cutoff = millis(state.unavailableSince), started = millis(chat?.["started_at"]);
			if (open && Number.isFinite(cutoff) && Number.isFinite(started) && started < cutoff) return;
			throw new OperatorPauseAdmissionError("OPERATOR_PAUSED");
		} catch (error) { throw pauseAdmissionFailure(error) ?? unavailable(); }
	}

	/** Advisory only. Every writer repeats eligibility with the same state locks. */
	async eligible(tx: RuntimeTx, rawInstance: string, ids: number[]): Promise<Set<number>> {
		try {
			const instance = canonicalRuntimeInstance(rawInstance);
			const unique = [...new Set(ids.filter(humanId))].sort((a, b) => a - b), allowed = new Set<number>();
			for (let offset = 0; offset < unique.length; offset += 200) {
				const batch = unique.slice(offset, offset + 200), admission = await this.lock(tx, instance, batch);
				if (!admission.enabled) return new Set(unique);
				for (const id of batch) if (admission.states.get(id)?.state === "available") allowed.add(id);
			}
			return allowed;
		} catch (error) { throw pauseAdmissionFailure(error) ?? unavailable(); }
	}
}
export const operatorPauseAdmission = new CentralOperatorAdmission();
