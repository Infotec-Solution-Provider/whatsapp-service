import { inTriageHours, normalizeAnswer, requestsHuman, type TriageDefinition, type TriageNode } from "./definition";

export * from "./definition";

export interface TriageState {
	nodeId: string;
	answers: Record<string, string>;
	invalidAttempts: number;
	status: "waiting" | "handed_off";
	deadline: string | null;
}
export type TriageEvent = { type: "start"; text?: string } | { type: "reply"; text: string } | { type: "timeout" };
export type TriageSimulationEvent = { type: "reply"; text: string; at?: string } | { type: "timeout"; at?: string };
export type TriageHandoffReason = "configured" | "invalid" | "timeout" | "requested";

export interface TriageTurn {
	state: TriageState;
	messages: string[];
	handoff: { sectorId: number; reason: TriageHandoffReason } | null;
	visited: string[];
}

function prompt(node: TriageNode): string {
	if (node.type !== "menu") return node.text!;
	const choices = node.options!.map((option, index) => `${index + 1}. ${option.label}`);
	return [node.text, "", ...choices].join("\n");
}

function selectOption(node: TriageNode, reply: string) {
	const answer = normalizeAnswer(reply);
	const options = node.options!;
	if (/^[1-9]\d*$/.test(answer)) return options[Number(answer) - 1];
	return options.find((option) => normalizeAnswer(option.label) === answer);
}

/** Runs one event against an immutable, validated revision. Performs no I/O. */
export function advanceTriage(definition: TriageDefinition, previous: TriageState | null, event: TriageEvent, now: Date): TriageTurn {
	if (!Number.isFinite(now.getTime())) throw new Error("Informe a data do evento.");
	const state: TriageState = previous ? { ...previous, answers: { ...previous.answers } } :
		{ nodeId: definition.entry, answers: {}, invalidAttempts: 0, status: "waiting", deadline: null };
	const turn: TriageTurn = { state, messages: [], handoff: null, visited: [] };
	const finish = (reason: TriageHandoffReason, sectorId: number | null | undefined): TriageTurn => {
		if (!sectorId) throw new Error("O destino do encaminhamento está ausente.");
		state.status = "handed_off";
		state.deadline = null;
		turn.handoff = { sectorId, reason };
		return turn;
	};
	if (previous?.status === "handed_off" || (previous && event.type === "start")) return turn;
	if (!previous && event.type !== "start") throw new Error("Inicie a conversa antes de enviar um evento.");
	const expires = () => new Date(now.getTime() + definition.timeoutMinutes * 60_000).toISOString();
	const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
	if (previous && previous.deadline && now.getTime() >= Date.parse(previous.deadline)) {
		return finish("timeout", definition.fallbackSectorId);
	}
	if (event.type === "timeout") return turn;
	if (event.text !== undefined && requestsHuman(event.text)) return finish("requested", definition.fallbackSectorId);
	if (event.type === "reply") {
		const waiting = nodes.get(state.nodeId);
		if (!waiting || (waiting.type !== "question" && waiting.type !== "menu")) throw new Error("Etapa de resposta inválida.");
		turn.visited.push(waiting.id);
		const answer = event.text.trim();
		const choice = waiting.type === "menu" ? selectOption(waiting, answer) : undefined;
		const valid = waiting.type === "menu" ? Boolean(choice) : answer.length > 0 && answer.length <= 1000;
		if (!valid) {
			if (++state.invalidAttempts >= definition.maxInvalid) return finish("invalid", definition.fallbackSectorId);
			const retry = waiting.type === "menu" ? "Responda com o número ou o nome de uma das opções." :
				"Responda com um texto de até 1.000 caracteres.";
			turn.messages.push(`${retry}\n\n${prompt(waiting)}`);
			state.deadline = expires();
			return turn;
		}
		state.answers[waiting.answerKey || waiting.id] = choice?.label ?? answer;
		state.nodeId = choice?.next ?? waiting.next!;
		state.invalidAttempts = 0;
	}
	const traversed = new Set<string>();
	while (!traversed.has(state.nodeId)) {
		traversed.add(state.nodeId);
		const node = nodes.get(state.nodeId);
		if (!node) throw new Error("A revisão contém uma ligação inválida.");
		turn.visited.push(node.id);
		switch (node.type) {
			case "message":
				turn.messages.push(prompt(node));
				state.nodeId = node.next!;
				break;
			case "menu":
			case "question":
				turn.messages.push(prompt(node));
				state.deadline = expires();
				return turn;
			case "condition": {
				const answer = state.answers[node.answerKey!];
				state.nodeId = typeof answer === "string" && normalizeAnswer(answer) === normalizeAnswer(node.equals!) ? node.yes! : node.no!;
				break;
			}
			case "hours":
				state.nodeId = inTriageHours(definition.schedule, now) ? node.yes! : node.no!;
				break;
			case "handoff":
				if (node.text?.trim()) turn.messages.push(node.text.trim());
				return finish("configured", node.sectorId);
		}
	}
	throw new Error("A revisão contém um ciclo de etapas automáticas.");
}

export function summarizeTriageAnswers(definition: TriageDefinition, state: TriageState): { label: string; value: string }[] {
	const fields = new Map(definition.nodes.filter((node) => node.type === "question" || node.type === "menu")
		.map((node) => [node.answerKey || node.id, node.title]));
	return Object.entries(state.answers).flatMap(([key, value]) => {
		const label = fields.get(key);
		return label ? [{ label, value }] : [];
	});
}

export function simulateTriage(definition: TriageDefinition, events: readonly TriageSimulationEvent[], startTime: Date): TriageTurn[] {
	if (!Array.isArray(events) || events.length > 100) throw new Error("Simule até 100 eventos por conversa.");
	let time = startTime;
	let turn = advanceTriage(definition, null, { type: "start" }, time);
	const turns = [turn];
	for (const event of events) {
		if (!event || (event.type !== "timeout" && (event.type !== "reply" || typeof event.text !== "string"))) {
			throw new Error("O evento de simulação é inválido.");
		}
		let at = time;
		if (event.at !== undefined) {
			if (typeof event.at !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(event.at)) throw new Error("Informe uma data de simulação com fuso horário.");
			at = new Date(event.at);
		} else if (event.type === "timeout" && turn.state.deadline) {
			at = new Date(turn.state.deadline);
		}
		if (!Number.isFinite(at.getTime()) || at < time) throw new Error("Os eventos da simulação devem estar em ordem cronológica.");
		time = at;
		turn = advanceTriage(definition, turn.state, event, time);
		turns.push(turn);
	}
	return turns;
}
