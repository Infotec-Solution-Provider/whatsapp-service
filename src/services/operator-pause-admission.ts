import { pauseSendTargetMatches } from "../utils/operator-pause-peer";
/** Admission uses the same CRM rows and transaction as the chat assignment. */
export interface PauseAdmissionTransaction {
	$queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): PromiseLike<T>;
	$executeRawUnsafe(sql: string, ...values: unknown[]): PromiseLike<number>;
}
export interface ChatAssignmentAdmission {
	instance: string;
	recipientId?: number | null | undefined;
	/** Only for a new attendance initiated by a human, including a shared destination. */
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
		if (PAUSE_ADMISSION_CODES.includes(code as typeof PAUSE_ADMISSION_CODES[number]))
			return current as OperatorPauseAdmissionError;
		current = (current as Row)["cause"];
	}
	return null;
}
const unavailable = () => new OperatorPauseAdmissionError("OPERATOR_AVAILABILITY_UNAVAILABLE");
const humanId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function recipientId(value: unknown): number | null {
	if (value == null) return null;
	const id = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
	if (typeof id !== "number" || !Number.isSafeInteger(id)) throw unavailable();
	return id;
}

export class OperatorPauseAdmission {
	// This never grants admission: it only prevents schema loss from silently disabling a reviewed gate.
	private readonly observedEnabled = new Set<string>();
	private async enabled(tx: PauseAdmissionTransaction, instance: string): Promise<boolean> {
		const columns = await tx.$queryRawUnsafe<Row[]>(
			"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telephony_runtime_policy' AND COLUMN_NAME='pause_all_channels'");
		if (!columns.length) {
			if (this.observedEnabled.has(instance)) throw unavailable();
			return false;
		}
		// Shared readers coexist; changing the policy waits for in-flight admissions to commit.
		const policies = await tx.$queryRawUnsafe<Row[]>(
			"SELECT enabled,pause_all_channels,preflight_hash FROM telephony_runtime_policy WHERE id=1 LOCK IN SHARE MODE");
		const policy = policies[0];
		if (!policy || Number(policy["pause_all_channels"]) !== 1) {
			if (!policy && this.observedEnabled.has(instance)) throw unavailable();
			return false;
		}
		this.observedEnabled.add(instance);
		if (Number(policy["enabled"]) !== 1 || !/^[a-f0-9]{64}$/i.test(String(policy["preflight_hash"] ?? ""))) throw unavailable();
		return true;
	}

	async assert(tx: PauseAdmissionTransaction, scope: ChatAssignmentAdmission, native: boolean): Promise<void> {
		if (!native) return; // Central storage cannot advertise/support global pause.
		try {
			if (!await this.enabled(tx, scope.instance)) return;
			if (scope.initiatorId !== undefined && !humanId(scope.initiatorId)) throw unavailable();
			const target = recipientId(scope.recipientId);
			const ids = [...new Set([target, scope.initiatorId].filter(humanId))].sort((a, b) => a - b);
			const states = new Map<number, { active: boolean; state: string }>();
			for (const id of ids) {
				await tx.$executeRawUnsafe("INSERT INTO telephony_operator_state (operator_id) VALUES (?) ON DUPLICATE KEY UPDATE operator_id=VALUES(operator_id)", id);
				const state = (await tx.$queryRawUnsafe<Row[]>("SELECT state,unavailable_since FROM telephony_operator_state WHERE operator_id=? FOR UPDATE", id))[0];
				const operator = (await tx.$queryRawUnsafe<Row[]>("SELECT ATIVO FROM operadores WHERE CODIGO=? FOR UPDATE", id))[0];
				if (!state) throw unavailable();
				states.set(id, { active: operator?.["ATIVO"] === "SIM", state: String(state["state"]) });
			}
			// Lock recipients in ascending order before the chat, matching all assignment writers.
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
				const candidate = states.get(id);
				if (!candidate?.active) throw unavailable();
				if (candidate.state === "pending" || candidate.state === "paused") throw new OperatorPauseAdmissionError("OPERATOR_PAUSED");
				if (candidate.state !== "available") throw unavailable();
			}
		} catch (error) {
			throw pauseAdmissionFailure(error) ?? unavailable();
		}
	}

	/** Admission finishes before provider I/O; persisted sends run this in their enqueue transaction. */
	async assertSend(tx: PauseAdmissionTransaction, scope: HumanSendAdmission, native: boolean): Promise<void> {
		if (!native || !humanId(scope.actorId)) return;
		try {
			if (!await this.enabled(tx, scope.instance)) return;
			await tx.$executeRawUnsafe("INSERT INTO telephony_operator_state (operator_id) VALUES (?) ON DUPLICATE KEY UPDATE operator_id=VALUES(operator_id)", scope.actorId);
			const state = (await tx.$queryRawUnsafe<Row[]>("SELECT state,unavailable_since FROM telephony_operator_state WHERE operator_id=? FOR UPDATE", scope.actorId))[0];
			const operator = (await tx.$queryRawUnsafe<Row[]>("SELECT ATIVO FROM operadores WHERE CODIGO=? FOR UPDATE", scope.actorId))[0];
			if (!state || operator?.["ATIVO"] !== "SIM") throw unavailable();
			if (state["state"] === "available") return;
			if (state["state"] !== "pending" && state["state"] !== "paused") throw unavailable();
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
			const cutoff = millis(state["unavailable_since"]), started = millis(chat?.["started_at"]);
			// Equality is ambiguous on second-precision legacy clocks: require an earlier open chat.
			if (open && Number.isFinite(cutoff) && Number.isFinite(started) && started < cutoff) return;
			throw new OperatorPauseAdmissionError("OPERATOR_PAUSED");
		} catch (error) { throw pauseAdmissionFailure(error) ?? unavailable(); }
	}

	/** Advisory only: the writer repeats eligibility under operator locks before commit. */
	async eligible(tx: PauseAdmissionTransaction, instance: string, ids: number[], native: boolean): Promise<Set<number>> {
		const unique = [...new Set(ids.filter(humanId))];
		if (!native) return new Set(unique);
		try {
			if (!await this.enabled(tx, instance)) return new Set(unique);
			if (!unique.length) return new Set();
			const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT o.CODIGO FROM operadores o LEFT JOIN telephony_operator_state s ON s.operator_id=o.CODIGO WHERE o.CODIGO IN (${unique.map(() => "?").join(",")}) AND o.ATIVO='SIM' AND (s.state IS NULL OR s.state='available')`, ...unique);
			return new Set(rows.map(row => Number(row["CODIGO"])));
		} catch (error) { throw pauseAdmissionFailure(error) ?? unavailable(); }
	}
}
export const operatorPauseAdmission = new OperatorPauseAdmission();
