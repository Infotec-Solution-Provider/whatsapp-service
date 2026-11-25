export type TriageNodeType = "message" | "menu" | "question" | "condition" | "hours" | "handoff";

export interface TriageNode {
	id: string;
	type: TriageNodeType;
	title: string;
	text?: string;
	next?: string;
	options?: { label: string; next: string }[];
	answerKey?: string;
	equals?: string;
	yes?: string;
	no?: string;
	sectorId?: number;
}

export interface TriageSchedule {
	timezone: string;
	/** Sunday = 0, Saturday = 6. Ranges include start and exclude end. */
	days: { day: number; start: string; end: string }[];
}

export interface TriageDefinition {
	entry: string;
	nodes: TriageNode[];
	fallbackSectorId: number | null;
	timeoutMinutes: number;
	maxInvalid: number;
	schedule: TriageSchedule;
}

export interface TriageIssue {
	nodeId: string | null;
	field: string;
	message: string;
}

const nodeTypes = new Set<TriageNodeType>(["message", "menu", "question", "condition", "hours", "handoff"]);
const reservedKeys = new Set(["__proto__", "constructor", "prototype"]);
const key = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) && !reservedKeys.has(value);
const bounded = (value: unknown, min: number, max: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const filled = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeAnswer(value: string): string {
	return value.trim().toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}

const humanRequests = new Set(["atendente", "atendimento humano", "atendente humano", "falar com atendente",
	"falar com um atendente", "falar com uma pessoa", "falar com humano", "falar com um humano"]);
export function requestsHuman(value: string): boolean {
	return humanRequests.has(normalizeAnswer(value).replace(/[.!?]+$/g, "").trim());
}

function minutes(value: unknown, end = false): number | null {
	if (end && value === "24:00") return 1440;
	if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
	return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function localClock(timezone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function inTriageHours(schedule: TriageSchedule, now: Date): boolean {
	const parts = localClock(schedule.timezone).formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
	const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday") ?? "");
	const clock = Number(part("hour")) * 60 + Number(part("minute"));
	return schedule.days.some((range) => {
		const start = minutes(range.start);
		const end = minutes(range.end, true);
		if (start === null || end === null || start === end) return false;
		if (end > start) return day === range.day && clock >= start && clock < end;
		return (day === range.day && clock >= start) || (day === (range.day + 1) % 7 && clock < end);
	});
}

function targets(node: TriageNode): string[] {
	switch (node.type) {
		case "message":
		case "question": return [node.next!];
		case "menu": return node.options!.map((option) => option.next);
		case "condition":
		case "hours": return [node.yes!, node.no!];
		case "handoff": return [];
	}
}

function checkGraph(definition: TriageDefinition, issue: (id: string | null, field: string, message: string) => void): void {
	const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
	const edges = new Map(definition.nodes.map((node) => [node.id, targets(node)]));
	function reachable(stopAt?: (node: TriageNode) => boolean): Set<string> {
		const seen = new Set<string>();
		const pending = [definition.entry];
		while (pending.length) {
			const id = pending.pop()!;
			if (seen.has(id)) continue;
			seen.add(id);
			if (!stopAt?.(nodes.get(id)!)) pending.push(...edges.get(id)!);
		}
		return seen;
	}
	const reachableNodes = reachable();
	for (const node of nodes.values()) {
		if (!reachableNodes.has(node.id)) issue(node.id, "id", "Esta etapa não pode ser alcançada a partir do início.");
	}
	const waiting = (node: TriageNode) => node.type === "menu" || node.type === "question";
	const finished = new Set<string>();
	const active = new Set<string>();
	function detectLoop(id: string): void {
		if (finished.has(id) || waiting(nodes.get(id)!)) return;
		if (active.has(id)) {
			issue(id, "next", "O fluxo volta a esta etapa sem aguardar uma resposta.");
			return;
		}
		active.add(id);
		for (const target of edges.get(id)!) detectLoop(target);
		active.delete(id);
		finished.add(id);
	}
	for (const id of reachableNodes) detectLoop(id);
	// Traverse backwards from every configured destination to identify dead branches.
	const canFinish = new Set(definition.nodes.filter((node) => node.type === "handoff").map((node) => node.id));
	const predecessors = new Map<string, string[]>();
	for (const [id, links] of edges) {
		for (const dest of links) {
			const list = predecessors.get(dest) ?? [];
			list.push(id);
			predecessors.set(dest, list);
		}
	}
	const queue = [...canFinish];
	while (queue.length) {
		for (const id of predecessors.get(queue.pop()!) ?? []) {
			if (!canFinish.has(id)) { canFinish.add(id); queue.push(id); }
		}
	}
	for (const node of nodes.values()) {
		if (!canFinish.has(node.id)) issue(node.id, "next", "Este caminho precisa levar a um encaminhamento.");
		if (node.type === "condition" && reachableNodes.has(node.id)) {
			const withoutAnswer = reachable((source) => waiting(source) && (source.answerKey || source.id) === node.answerKey);
			if (withoutAnswer.has(node.id)) issue(node.id, "answerKey", "Todos os caminhos até esta condição precisam coletar a resposta escolhida.");
		}
	}
}

// All deserialized fields are examined before narrowing to TriageDefinition for graph validation.
export function validateTriageDefinition(value: unknown, sectorIds: readonly number[]): TriageIssue[] {
	const issues: TriageIssue[] = [];
	const issue = (nodeId: string | null, field: string, message: string) => { issues.push({ nodeId, field, message }); };
	if (!object(value)) return [{ nodeId: null, field: "definition", message: "Informe um fluxo para validar." }];
	const sectors = new Set(sectorIds);
	const sector = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && sectors.has(id);
	if (!sector(value["fallbackSectorId"])) issue(null, "fallbackSectorId", "Escolha um setor disponível para a contingência.");
	if (!bounded(value["maxInvalid"], 1, 10)) issue(null, "maxInvalid", "Escolha de 1 a 10 tentativas.");
	if (!bounded(value["timeoutMinutes"], 1, 43200)) issue(null, "timeoutMinutes", "A espera deve ser de 1 minuto a 30 dias.");
	const raw = value["nodes"];
	if (!Array.isArray(raw) || !raw.length || raw.length > 100) {
		issue(null, "nodes", "O fluxo deve ter de 1 a 100 etapas.");
		return issues;
	}
	const schedule = value["schedule"];
	if (!object(schedule)) {
		issue(null, "schedule", "Informe o fuso e os horários de atendimento.");
	} else {
		try {
			if (!filled(schedule["timezone"], 128)) throw new Error();
			localClock(schedule["timezone"]);
		} catch { issue(null, "schedule.timezone", "Escolha um fuso horário válido."); }
		const days = schedule["days"];
		if (!Array.isArray(days) || days.length > 100 || (!days.length && raw.some((n) => n?.type === "hours"))) {
			issue(null, "schedule.days", "Informe os intervalos de atendimento usados pela etapa de horário.");
		} else {
			days.forEach((range, index) => {
				if (!object(range) || !bounded(range["day"], 0, 6) || minutes(range["start"]) === null ||
					minutes(range["end"], true) === null || range["start"] === range["end"]) {
					issue(null, "schedule.days", `Confira o dia e os horários do intervalo ${index + 1}.`);
				}
			});
		}
	}
	const ids = new Set<string>();
	const answerKeys = new Set<string>();
	for (const node of raw) {
		if (object(node) && key(node["id"])) {
			if (ids.has(node["id"])) issue(node["id"], "id", "Cada etapa precisa ter um identificador exclusivo.");
			ids.add(node["id"]);
		}
	}
	if (!key(value["entry"]) || !ids.has(value["entry"])) issue(null, "entry", "Selecione uma etapa inicial existente.");
	for (const node of raw) {
		if (!object(node) || !key(node["id"])) { issue(null, "id", "Uma etapa tem um identificador inválido."); continue; }
		const id = node["id"];
		const t = node["type"];
		if (typeof t !== "string" || !nodeTypes.has(t as TriageNodeType)) { issue(id, "type", "Escolha um tipo de etapa disponível."); continue; }
		const target = (dest: unknown, field: string) => {
			if (!key(dest) || !ids.has(dest)) issue(id, field, "Escolha uma etapa de destino existente.");
		};
		if (!filled(node["title"], 120)) issue(id, "title", "Dê à etapa um nome de até 120 caracteres.");
		if (["message", "menu", "question"].includes(t) && !filled(node["text"], 2000)) issue(id, "text", "Escreva a mensagem em até 2.000 caracteres.");
		if (t === "question" || t === "menu") {
			const answerKey = node["answerKey"] || id;
			if (!key(answerKey)) issue(id, "answerKey", "Informe uma chave de resposta válida.");
			else if (answerKeys.has(answerKey)) issue(id, "answerKey", "Cada resposta precisa de uma chave exclusiva.");
			else answerKeys.add(answerKey);
		}
		if (t === "message" || t === "question") target(node["next"], "next");
		if (t === "menu") {
			const options = node["options"];
			if (!Array.isArray(options) || !bounded(options.length, 2, 10)) { issue(id, "options", "Adicione de 2 a 10 opções."); continue; }
			const labels = new Set<string>();
			options.forEach((option, index) => {
				if (!object(option)) { issue(id, "options", "Confira as opções do menu."); return; }
				if (!filled(option["label"], 100)) issue(id, "options", "Dê a cada opção um rótulo de até 100 caracteres.");
				else {
					const label = normalizeAnswer(option["label"]);
					if (labels.has(label)) issue(id, "options", "Use rótulos diferentes para as opções.");
					if (/^\d+$/.test(label) && label !== String(index + 1)) issue(id, "options", "Um rótulo numérico deve corresponder ao número da opção.");
					if (requestsHuman(label)) issue(id, "options", "Esse rótulo está reservado para solicitar o atendimento humano de contingência.");
					labels.add(label);
				}
				target(option["next"], "options");
			});
		}
		if (t === "condition" || t === "hours") { target(node["yes"], "yes"); target(node["no"], "no"); }
		if (t === "condition") {
			if (!key(node["answerKey"])) issue(id, "answerKey", "Escolha a resposta que a condição deve verificar.");
			if (!filled(node["equals"], 1000)) issue(id, "equals", "Informe o valor de comparação.");
		}
		if (t === "handoff") {
			if (!sector(node["sectorId"])) issue(id, "sectorId", "Escolha um setor de destino disponível.");
			if (node["text"] !== undefined && (typeof node["text"] !== "string" || node["text"].length > 2000)) {
				issue(id, "text", "A mensagem de encaminhamento deve ter até 2.000 caracteres.");
			}
		}
	}
	if (!issues.length) checkGraph(value as unknown as TriageDefinition, issue);
	return issues;
}

export function createTriageTemplate(sectors: { sales?: number; support?: number; fallback?: number } = {}): TriageDefinition {
	const handoff = (id: string, title: string, sectorId?: number): TriageNode =>
		({ id, type: "handoff", title, ...(sectorId ? { sectorId } : {}) });
	return {
		entry: "inicio",
		nodes: [
			{ id: "inicio", type: "message", title: "Boas-vindas", text: "Olá! Vamos encaminhar o seu atendimento.", next: "area" },
			{ id: "area", type: "menu", title: "Área escolhida", text: "Com qual área você deseja falar?",
				options: [{ label: "Vendas", next: "vendas" }, { label: "Suporte", next: "suporte" }] },
			handoff("vendas", "Encaminhar para Vendas", sectors.sales),
			handoff("suporte", "Encaminhar para Suporte", sectors.support)
		],
		fallbackSectorId: sectors.fallback ?? null,
		timeoutMinutes: 30,
		maxInvalid: 3,
		schedule: { timezone: "America/Sao_Paulo", days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "18:00" })) }
	};
}
