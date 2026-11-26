import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, WppChatPriority, WppChatType, WppMessageFlowStepType } from "@prisma/client";
import { DEFAULT_MESSAGE_FLOW_STEPS, validateFlowDefinition, type FlowStepDefinition } from "../message-flow/flow-definition";
import { distributionReads } from "../message-flow/distribution-reads";
import { messageFlowCache } from "../message-flow/message-flow-cache";
import { StepRegistry } from "../message-flow/step-registry";
import { onlineOperatorSource } from "../message-flow/steps/check-user-online.step";
import { inboundFlowFingerprint } from "./inbound-flow-installation";
import database from "./prisma.service";
import { triageTriggers } from "../triage/triggers";

export interface StudioStep extends FlowStepDefinition { description?: string | null }
export interface StudioFlow { id: number; name: string; revision: number; steps: StudioStep[] }
export interface StudioActive {
	source: "default" | "legacy" | "library";
	flowId: number | null;
	revision: number | null;
	fingerprint: string;
	name: string;
	steps: StudioStep[];
}
export interface StudioLibrary { active: StudioActive; flows: StudioFlow[]; stepTypes: string[] }
export class StudioError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

type Tx = Prisma.TransactionClient;
type Live = Prisma.WppMessageFlowGetPayload<{ include: { WppMessageFlowStep: true } }>;
type Saved = Prisma.MessageFlowLibraryGetPayload<{}>;
type Publication = Prisma.MessageFlowPublicationGetPayload<{}>;
type Scope = { instance: string; sectorId: number };
const invalid = (message: string) => new StudioError(422, "FLOW_INVALID", message);
const missing = () => new StudioError(404, "FLOW_NOT_FOUND", "Fluxo ou setor não encontrado.");
const conflict = () => new StudioError(409, "FLOW_CONFLICT", "O fluxo mudou. Recarregue a biblioteca antes de continuar.");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const shortText = (value: unknown): value is string => typeof value === "string" && [...value].length <= 191;
const stepTypes = () => Object.values(WppMessageFlowStepType).filter(type => StepRegistry.has(type));
const body = (value: unknown): Record<string, unknown> => {
	if (!object(value)) throw invalid("Envie os dados do fluxo.");
	return value;
};
function nameOf(value: unknown) {
	if (!shortText(value) || !value.trim()) throw invalid("Informe um nome com até 191 caracteres.");
	return value.trim();
}
function revisionOf(value: unknown) {
	if (!positive(value)) throw invalid("Informe a revisão salva do fluxo.");
	return value;
}
function parseSteps(value: unknown): StudioStep[] {
	if (!Array.isArray(value)) throw invalid("Informe as etapas do fluxo.");
	return value.map((step, index) => {
		if (!object(step) || typeof step["type"] !== "string" || !positive(step["stepNumber"]))
			throw invalid(`Etapa ${index + 1}: informe um tipo e um número positivo.`);
		const { type, stepNumber, enabled, description, config, connections, nextStepId, fallbackStepId } = step;
		if (enabled != null && typeof enabled !== "boolean" || description != null && !shortText(description) ||
			config != null && !object(config) || connections != null && !object(connections) ||
			nextStepId != null && !positive(nextStepId) || fallbackStepId != null && !positive(fallbackStepId))
			throw invalid(`Etapa ${stepNumber}: confira a descrição, as conexões e a configuração.`);
		return { type, stepNumber, enabled: enabled ?? true, description: description ?? null,
			config: config ?? null, connections: connections ?? null, nextStepId: nextStepId ?? null, fallbackStepId: fallbackStepId ?? null };
	});
}
function savedFlow(row: Saved): StudioFlow {
	return { id: row.id, name: row.name, revision: row.revision, steps: parseSteps(row.steps) };
}
function liveSteps(flow: Live | null): StudioStep[] {
	return parseSteps(flow ? flow.WppMessageFlowStep : DEFAULT_MESSAGE_FLOW_STEPS);
}
function token(scope: Scope, flow: Live | null, publication: Publication | null) {
	const fingerprint = flow ? inboundFlowFingerprint(flow) : null;
	// Generation also detects a switch away and back to exactly the same graph.
	const expected = createHash("sha256").update(JSON.stringify([scope.instance, scope.sectorId, flow?.id ?? null,
		fingerprint, publication?.generation ?? 0])).digest("hex");
	return { fingerprint, expected };
}
function activeFlow(scope: Scope, live: Live | null, publication: Publication | null): StudioActive {
	const { fingerprint, expected } = token(scope, live, publication);
	const published = publication && fingerprint === publication.fingerprint ? publication : null;
	return { source: published ? "library" : live ? "legacy" : "default", flowId: published?.libraryId ?? null,
		revision: published?.revision ?? null, fingerprint: expected, name: live ? live.description || "Fluxo atual do setor" : "Fluxo padrão",
		steps: liveSteps(live) };
}
function sqlStep(step: StudioStep) {
	return step.type === "QUERY" && object(step.config) && Object.hasOwn(step.config, "query");
}
function sqlError(steps: StudioStep[], originals: StudioStep[]): string | null {
	const source = originals.filter(sqlStep);
	return steps.some(step => sqlStep(step) && !source.some(previous => isDeepStrictEqual(previous.config, step.config)))
		? "As consultas SQL existentes podem ser reutilizadas somente com sua configuração original neste setor." : null;
}
function definitionErrors(scope: Scope, steps: StudioStep[]): string[] {
	const errors = validateFlowDefinition(steps);
	if (new Set(steps.map(step => step.stepNumber)).size !== steps.length) errors.push("Os números das etapas devem ser únicos, incluindo as desativadas.");
	const available = new Set<string>(stepTypes());
	for (const step of steps) {
		// The engine skips disabled legacy steps even when their executor has been retired.
		if (step.enabled === false && Object.hasOwn(WppMessageFlowStepType, step.type)) continue;
		if (!available.has(step.type)) {
			errors.push(`Etapa ${step.stepNumber}: o tipo ${step.type} não pode ser publicado.`);
			continue;
		}
		try {
			const config = object(step.config) ? step.config : {};
			StepRegistry.create(step.type, { ...scope, stepNumber: step.stepNumber, config });
			if (["CONDITION", "ROUTER"].includes(step.type)) {
				const field = config["field"];
				if (typeof field !== "string" || !field.trim()) throw Error("Informe o campo usado na decisão.");
			}
			if (step.type === "ASSIGN") {
				for (const key of ["userId", "walletId"]) {
					const value = config[key];
					const expression = typeof value === "string" && /^\$\{[\w]+(?:\.[\w]+)*\}$/.test(value);
					if (value != null && !positive(value) && !(key === "userId" && value === -1) && !expression)
						throw Error("O destino deve ser um identificador ou uma expressão de campo.");
				}
				if (config["priority"] != null && !Object.hasOwn(WppChatPriority, String(config["priority"]))) throw Error("Prioridade inválida.");
				if (config["type"] != null && !Object.hasOwn(WppChatType, String(config["type"]))) throw Error("Tipo de atendimento inválido.");
				if (config["fallbackUserId"] != null && !positive(config["fallbackUserId"])) throw Error("Operador substituto inválido.");
			}
			if (config["systemMessage"] != null && typeof config["systemMessage"] !== "string") throw Error("A mensagem do sistema deve ser um texto.");
			for (const key of ["preferAdmin", "checkIsOnline", "checkIsActive", "checkIsRepresentative", "validateUser", "fallbackRequireAdmin", "single", "required"])
				if (config[key] != null && typeof config[key] !== "boolean") throw Error(`Opção ${key} inválida.`);
			if (step.type === "CONDITION") {
				const operators = ["equals", "==", "notEquals", "!=", "contains", "in", "gt", ">", "gte", ">=", "lt", "<", "lte", "<=", "exists", "notExists", "regex", "between"];
				if (!operators.includes(String(config["operator"]))) throw Error("Operador de comparação desconhecido.");
				if (config["operator"] === "regex") new RegExp(String(config["value"]));
				if ((config["operator"] === "between" || config["operator"] === "in") && !Array.isArray(config["value"])) throw Error("Informe uma lista de valores.");
				if (config["operator"] === "between" && (config["value"] as unknown[]).length !== 2) throw Error("Informe os dois limites do intervalo.");
			}
		} catch (err) { errors.push(`Etapa ${step.stepNumber}: ${err instanceof Error ? err.message : "configuração inválida"}`); }
	}
	return [...new Set(errors)];
}
const scopeOf = (instance: string, sectorId: number): Scope => {
	if (!instance || !positive(sectorId)) throw missing();
	return { instance, sectorId };
};
async function checkSector(tx: Tx, scope: Scope, lock: boolean) {
	const sector = lock
		? (await tx.$queryRawUnsafe<Array<{ id: number }>>("SELECT id FROM sectors WHERE instance=? AND id=? FOR UPDATE", scope.instance, scope.sectorId))[0]
		: await tx.wppSector.findFirst({ where: { instance: scope.instance, id: scope.sectorId }, select: { id: true } });
	if (!sector) throw missing();
}
async function readLive(tx: Tx, scope: Scope) {
	return tx.wppMessageFlow.findUnique({ where: { instance_sectorId: scope },
		include: { WppMessageFlowStep: { orderBy: { stepNumber: "asc" } } } });
}
async function lockLive(tx: Tx, scope: Scope) {
	const rows = await tx.$queryRawUnsafe<Array<{ id: number }>>(
		"SELECT id FROM message_flows WHERE instance=? AND sector_id=? FOR UPDATE", scope.instance, scope.sectorId);
	if (rows[0]) await tx.$queryRawUnsafe("SELECT id FROM message_flows_steps WHERE message_flow_id=? FOR UPDATE", rows[0].id);
}
async function library(tx: Tx, scope: Scope): Promise<StudioLibrary> {
	const live = await readLive(tx, scope);
	const publication = await tx.messageFlowPublication.findUnique({ where: { instance_sectorId: scope } });
	const rows = await tx.messageFlowLibrary.findMany({ where: scope, orderBy: { id: "asc" } });
	return { active: activeFlow(scope, live, publication), flows: rows.map(savedFlow), stepTypes: stepTypes() };
}
async function trustedSql(tx: Tx, scope: Scope, steps: StudioStep[]) {
	if (!steps.some(sqlStep)) return null;
	const { active, flows } = await library(tx, scope);
	return sqlError(steps, active.steps.concat(flows.flatMap(flow => flow.steps)));
}
async function selected(tx: Tx, scope: Scope, id: number, revision: number) {
	if (!positive(id)) throw missing();
	const row = await tx.messageFlowLibrary.findFirst({ where: { id, ...scope } });
	if (!row) throw missing();
	if (row.revision !== revision) throw conflict();
	return row;
}
const json = (value: unknown) => value as Prisma.InputJsonValue;

export class MessageFlowStudioService {
	constructor(private readonly db: typeof database = database,
		private readonly invalidate: (instance: string, sectorId: number) => void = (instance, sector) => messageFlowCache.invalidate(instance, sector),
		private readonly operators = distributionReads.operators,
		private readonly listPublishedBots = (instance: string, sector: number) => triageTriggers.catalog(instance, sector, this.db)) {}

	private async checkDestinations(scope: Scope, steps: StudioStep[]) {
		const botIds = steps.filter(step => step.enabled !== false && step.type === "START_BOT")
			.map(step => object(step.config) ? step.config["botId"] : null);
		if (botIds.length) {
			const bots = await this.listPublishedBots(scope.instance, scope.sectorId);
			if (botIds.some(id => !bots.some(bot => bot.botId === id)))
				throw invalid("Selecione um bot publicado em um canal deste setor.");
		}
		const assignments = steps.filter(step => step.enabled !== false && step.type === "ASSIGN")
			.map(step => object(step.config) ? step.config : {});
		const wallets = [...new Set(assignments.map(config => config["walletId"]).filter(positive))];
		if (wallets.length) {
			const rows = await this.db.wppWallet.findMany({ where: { instance: scope.instance, id: { in: wallets } }, select: { id: true } });
			if (rows.length !== wallets.length) throw invalid("Uma carteira de destino não pertence a esta empresa.");
		}
		const onlineOperators = steps.filter(step => step.enabled !== false && step.type === "CHECK_USER_ONLINE")
			.map(step => onlineOperatorSource(object(step.config) ? step.config : {})).filter(positive);
		const users = [...new Set([...onlineOperators, ...assignments.flatMap(config => [config["userId"], config["fallbackUserId"]]).filter(positive)])];
		if (!users.length) return;
		let rows: Awaited<ReturnType<typeof this.operators>>;
		try { rows = await this.operators(scope.instance, users); }
		catch { throw new StudioError(503, "FLOW_DIRECTORY_UNAVAILABLE", "Não foi possível conferir os operadores no CRM. Tente novamente."); }
		const byId = new Map(rows.map(row => [row.CODIGO, row]));
		for (const id of onlineOperators) {
			const operator = byId.get(id);
			if (!operator || operator.SETOR !== scope.sectorId || operator.ATIVO !== "SIM")
				throw invalid("O operador selecionado para verificar disponibilidade deve estar ativo e pertencer ao setor.");
		}
		for (const config of assignments) {
			for (const key of ["userId", "fallbackUserId"]) {
				const id = config[key];
				if (!positive(id)) continue;
				const row = byId.get(id);
				if (!row) throw invalid("Um operador de destino não pertence a esta empresa.");
				if (config["validateUser"] === true && (row.SETOR !== scope.sectorId || row.ATIVO !== "SIM" ||
					(key === "fallbackUserId" && config["fallbackRequireAdmin"] === true && row.NIVEL !== "ADMIN")))
					throw invalid("Confira o setor, a situação e o perfil dos operadores de destino.");
			}
		}
	}

	async list(instance: string, sectorId: number): Promise<StudioLibrary> {
		const scope = scopeOf(instance, sectorId);
		return this.db.$transaction(async tx => { await checkSector(tx, scope, false); return library(tx, scope); });
	}

	async validate(instance: string, sectorId: number, input: unknown) {
		const scope = scopeOf(instance, sectorId);
		return this.db.$transaction(async tx => {
			await checkSector(tx, scope, false);
			let steps: StudioStep[];
			try { steps = parseSteps(body(input)["steps"]); }
			catch (err) { if (err instanceof StudioError) return { valid: false, errors: [err.message] }; throw err; }
			const errors = definitionErrors(scope, steps);
			const error = await trustedSql(tx, scope, steps);
			if (error) errors.push(error);
			return { valid: !errors.length, errors };
		});
	}

	async create(instance: string, sectorId: number, input: unknown): Promise<StudioFlow> {
		const scope = scopeOf(instance, sectorId), draft = body(input);
		const name = nameOf(draft["name"]), steps = parseSteps(draft["steps"]);
		return this.db.$transaction(async tx => {
			await checkSector(tx, scope, true);
			const error = await trustedSql(tx, scope, steps);
			if (error) throw invalid(error);
			return savedFlow(await tx.messageFlowLibrary.create({ data: { ...scope, name, steps: json(steps) } }));
		});
	}

	async update(instance: string, sectorId: number, id: number, input: unknown): Promise<StudioFlow> {
		const scope = scopeOf(instance, sectorId), draft = body(input);
		const revision = revisionOf(draft["revision"]), name = nameOf(draft["name"]), steps = parseSteps(draft["steps"]);
		return this.db.$transaction(async tx => {
			await checkSector(tx, scope, true);
			await selected(tx, scope, id, revision);
			const error = await trustedSql(tx, scope, steps);
			if (error) throw invalid(error);
			const changed = await tx.messageFlowLibrary.updateMany({ where: { id, ...scope, revision }, data: { name, steps: json(steps), revision: revision + 1 } });
			if (changed.count !== 1) throw conflict();
			return { id, revision: revision + 1, name, steps };
		});
	}

	async duplicate(instance: string, sectorId: number, id: number, input: unknown): Promise<StudioFlow> {
		const scope = scopeOf(instance, sectorId), draft = body(input), revision = revisionOf(draft["revision"]);
		return this.db.$transaction(async tx => {
			await checkSector(tx, scope, true);
			const source = await selected(tx, scope, id, revision);
			const name = nameOf(draft["name"] ?? `Cópia de ${[...source.name].slice(0, 182).join("")}`);
			return savedFlow(await tx.messageFlowLibrary.create({ data: { ...scope, name, steps: json(source.steps) } }));
		});
	}

	async activate(instance: string, sectorId: number, id: number, input: unknown): Promise<StudioLibrary> {
		const scope = scopeOf(instance, sectorId), change = body(input), revision = revisionOf(change["revision"]);
		if (typeof change["activeFingerprint"] !== "string" || !/^[a-f0-9]{64}$/.test(change["activeFingerprint"]))
			throw invalid("Informe a versão do fluxo ativo apresentada na biblioteca.");
		const candidate = await this.db.$transaction(async tx => {
			await checkSector(tx, scope, false);
			return selected(tx, scope, id, revision);
		});
		const steps = savedFlow(candidate).steps;
		const errors = definitionErrors(scope, steps);
		if (errors.length) throw invalid(errors.join("\n"));
		await this.checkDestinations(scope, steps);
		const result = await this.db.$transaction(async tx => {
			await checkSector(tx, scope, true);
			const walletIds = [...new Set(steps.filter(step => step.enabled !== false && step.type === "ASSIGN")
				.map(step => object(step.config) ? step.config["walletId"] : undefined).filter(positive))].sort((a, b) => a - b);
			for (const walletId of walletIds) {
				const rows = await tx.$queryRawUnsafe<{ id: number }[]>("SELECT id FROM wallets WHERE id=? AND instance=? FOR UPDATE", walletId, instance);
				if (!rows.length) throw invalid("A carteira de destino deixou de existir nesta empresa.");
			}
			await lockLive(tx, scope);
			const row = await selected(tx, scope, id, revision);
			if (!isDeepStrictEqual(row.steps, candidate.steps) || row.name !== candidate.name) throw conflict();
			const before = await library(tx, scope);
			if (before.active.fingerprint !== change["activeFingerprint"]) throw conflict();
			if (before.active.flowId === id && before.active.revision === revision) return before;
			// Keep a selectable copy even if the published flow already has a newer, unpublished draft.
			const previousDraft = before.flows.find(flow => flow.id === before.active.flowId);
			if (!previousDraft || previousDraft.revision !== before.active.revision) {
				await tx.messageFlowLibrary.create({ data: { ...scope, name: before.active.name, steps: json(before.active.steps) } });
			}
			const live = await tx.wppMessageFlow.upsert({ where: { instance_sectorId: scope },
				create: { ...scope, description: row.name }, update: { description: row.name } });
			await tx.wppMessageFlowStep.deleteMany({ where: { messageFlowId: live.id } });
			await tx.wppMessageFlowStep.createMany({ data: steps.map(step => ({ messageFlowId: live.id,
				type: step.type as WppMessageFlowStepType, stepNumber: step.stepNumber, nextStepId: step.nextStepId ?? null,
				fallbackStepId: step.fallbackStepId ?? null, description: step.description ?? null, enabled: step.enabled ?? true,
				config: step.config == null ? Prisma.DbNull : json(step.config),
				connections: step.connections == null ? Prisma.DbNull : json(step.connections) })) });
			const installed = await readLive(tx, scope);
			if (!installed) throw Error("FLOW_PROJECTION_MISSING");
			const fingerprint = inboundFlowFingerprint(installed);
			const previous = await tx.messageFlowPublication.findUnique({ where: { instance_sectorId: scope } });
			const publication = { libraryId: id, revision, fingerprint, generation: (previous?.generation ?? 0) + 1 };
			await tx.messageFlowPublication.upsert({ where: { instance_sectorId: scope }, create: { ...scope, ...publication }, update: publication });
			return library(tx, scope);
		}).catch((error: unknown) => {
			if (object(error) && error["code"] === "TENANT_COMMIT_UNKNOWN") {
				this.invalidate(instance, sectorId);
				throw new StudioError(503, "FLOW_COMMIT_UNKNOWN", "A confirmação da ativação foi interrompida. Recarregue para conferir o fluxo ativo.");
			}
			throw error;
		});
		this.invalidate(instance, sectorId);
		return result;
	}
}

export default new MessageFlowStudioService();
