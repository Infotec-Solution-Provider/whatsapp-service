export class FlowSimulationError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export interface FlowScenario {
	isOnlyAdmin?: boolean;
	customerStatus?: "found" | "not_found" | "ambiguous" | "unavailable";
	customerId?: number;
	loyaltyUserId?: number | null;
	onlineUserIds?: number[];
	pausedUserIds?: number[];
	openChats?: Record<string, number>;
	querySamples?: Record<string, Record<string, unknown>[]>;
}

export interface SimulationInput { contactId: number; channelId?: number; messageBody?: string; scenario?: FlowScenario }

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const idKey = (key: string) => isId(Number(key)) && String(Number(key)) === key;
const ids = (value: unknown) => Array.isArray(value) && value.length <= 250 && value.every(isId) && new Set(value).size === value.length;
const flags = ["isOnlyAdmin", "customerStatus", "customerId", "loyaltyUserId", "onlineUserIds", "pausedUserIds", "openChats", "querySamples"];

export function validateSimulationInput(input: unknown): asserts input is SimulationInput {
	const fail = (field: string): never => { throw new FlowSimulationError(400, "INVALID_SIMULATION_INPUT", `Campo inválido no cenário: ${field}.`); };
	if (!isRecord(input) || !isId(input["contactId"])) return fail("contato");
	if (input["channelId"] !== undefined && !isId(input["channelId"])) fail("canal");
	if (input["messageBody"] !== undefined && (typeof input["messageBody"] !== "string" || input["messageBody"].length > 8192)) fail("mensagem");
	const s = input["scenario"];
	if (s === undefined) return;
	if (!isRecord(s) || Object.keys(s).some(key => !flags.includes(key))) return fail("cenário");
	if (s["isOnlyAdmin"] !== undefined && typeof s["isOnlyAdmin"] !== "boolean") fail("somente administração");
	if (s["customerStatus"] !== undefined && !["found", "not_found", "ambiguous", "unavailable"].includes(String(s["customerStatus"]))) fail("situação do cliente");
	if (s["customerId"] !== undefined && (!isId(s["customerId"]) || (s["customerStatus"] !== undefined && s["customerStatus"] !== "found"))) fail("cliente");
	if (s["loyaltyUserId"] !== undefined && s["loyaltyUserId"] !== null && !isId(s["loyaltyUserId"])) fail("operador de fidelização");
	if (s["onlineUserIds"] !== undefined && !ids(s["onlineUserIds"])) fail("operadores online");
	if (s["pausedUserIds"] !== undefined && !ids(s["pausedUserIds"])) fail("operadores em pausa");
	const chats = s["openChats"];
	if (chats !== undefined && (!isRecord(chats) || Object.keys(chats).length > 250 || Object.entries(chats).some(([id, n]) => !idKey(id) || !Number.isSafeInteger(n) || Number(n) < 0))) fail("carga de atendimentos");
	const samples = s["querySamples"];
	if (samples !== undefined && (!isRecord(samples) || Object.keys(samples).length > 200 || Object.entries(samples).some(([id, rows]) =>
		!idKey(id) || !Array.isArray(rows) || rows.length > 200 || !rows.every(isRecord)))) fail("linhas de exemplo");
}
