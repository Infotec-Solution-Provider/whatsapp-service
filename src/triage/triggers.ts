import type { SessionData } from "../sdk-local";
import database from "../services/prisma.service";
import { isTenantSqlTargetPrepared } from "../tenant-sql/router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { triageEnabled, type TriageReader, type TriageWriter } from "./access";

export type TriageTriggerType = "keyword" | "manual" | "transfer" | "closed";
export type TriageTriggerRule =
	| { type: "keyword"; botId: number; keywords: string[] }
	| { type: Exclude<TriageTriggerType, "keyword">; botId: number };
export interface TriageCatalogBot {
	botId: number;
	channelId: number;
	name: string;
	channelName: string;
	version: number;
	versionId: number;
}
export interface TriageTriggerInput {
	type: TriageTriggerType;
	sectorId?: number | null;
	text?: string;
	botId?: number;
}
export class TriggerError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}
type Database = TriageReader & {
	$transaction<T>(
		run: (tx: TriageWriter) => Promise<T>,
		options: { isolationLevel: "ReadCommitted" | "RepeatableRead" }
	): Promise<T>;
};
type RuleSet = { revision: number; rules: string };

function invalid(message: string): never {
	throw new TriggerError(422, "INVALID_BOT_TRIGGER", message);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Envie as regras de acionamento.");
	return value as Record<string, unknown>;
}
function exactFields(value: Record<string, unknown>, fields: string[]) {
	if (Object.keys(value).some((key) => !fields.includes(key))) invalid("A solicitação contém campos desconhecidos.");
}
function validId(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function triggerType(value: unknown): TriageTriggerType {
	if (value === "keyword" || value === "manual" || value === "transfer" || value === "closed") return value;
	return invalid("Selecione um tipo de acionamento válido.");
}
function keyword(value: string) {
	return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/gu, " ");
}
function decodeRules(value: unknown): TriageTriggerRule[] {
	if (!Array.isArray(value) || value.length > 200) invalid("O setor aceita até 200 regras.");
	const seen = new Set<string>();
	return value.map((raw) => {
		const rule = object(raw);
		const type = triggerType(rule["type"]),
			botId = rule["botId"];
		exactFields(rule, type === "keyword" ? ["type", "botId", "keywords"] : ["type", "botId"]);
		if (!validId(botId)) invalid("Selecione um bot publicado.");
		const key = botId + "/" + type;
		if (seen.has(key)) invalid("Este bot já possui uma regra deste tipo no setor.");
		seen.add(key);
		if (type !== "keyword") return { type, botId };
		const words = rule["keywords"];
		if (!Array.isArray(words) || !words.length || words.length > 30)
			invalid("Informe entre 1 e 30 palavras ou expressões.");
		const normalized = new Set<string>();
		const keywords = words.map((word) => {
			if (typeof word !== "string" || word.length > 100 || !keyword(word))
				invalid("Cada expressão precisa de 1 a 100 caracteres.");
			const term = keyword(word);
			if (normalized.has(term)) invalid("A lista contém expressões equivalentes.");
			normalized.add(term);
			return word.trim();
		});
		return { type, botId, keywords };
	});
}
function matches(rule: TriageTriggerRule, event: TriageTriggerInput): boolean {
	if (rule.type !== event.type || (event.botId != null && event.botId !== rule.botId)) return false;
	if (rule.type !== "keyword") return true;
	const incoming = keyword(event.text ?? "");
	return rule.keywords.some((word) => keyword(word) === incoming);
}
function validateConflicts(rules: TriageTriggerRule[], bots: TriageCatalogBot[]) {
	const channels = new Map(bots.map((bot) => [bot.botId, bot.channelId]));
	const owners = new Set<string>();
	for (const rule of rules) {
		const channelId = channels.get(rule.botId);
		if (channelId == null || rule.type === "manual") continue;
		const terms = rule.type === "keyword" ? rule.keywords.map(keyword) : [rule.type];
		for (const term of terms) {
			const key = JSON.stringify([channelId, rule.type, term]);
			if (owners.has(key)) {
				if (rule.type === "keyword") invalid(`A expressão “${term}” aciona dois bots no mesmo canal e setor.`);
				invalid(
					`Escolha apenas um bot para ${rule.type === "transfer" ? "a transferência" : "o encerramento"} no mesmo canal e setor.`
				);
			}
			owners.add(key);
		}
	}
}
function missingTable(error: unknown, table: string) {
	const e = error as { errno?: number; code?: string; message?: string; meta?: { code?: string; message?: string } };
	return (
		(e?.errno === 1146 || e?.code === "ER_NO_SUCH_TABLE" || e?.meta?.code === "1146") &&
		new RegExp("\\b(?:wpp_runtime_)?" + table + "\\b").test(e.meta?.message ?? e.message ?? "")
	);
}

export class TriageTriggers {
	constructor(private readonly db: Database = database) {}

	private table(instance: string) {
		return isTenantSqlTargetPrepared(this.db, instance) ? "wpp_runtime_triage_trigger_sets" : "triage_trigger_sets";
	}
	private async sector(db: TriageReader, instance: string, sectorId: number, lock: boolean) {
		const rows = await db.$queryRawUnsafe<{ id: number }[]>(
			"SELECT id FROM sectors WHERE instance=? AND id=?" + (lock ? " FOR UPDATE" : ""),
			instance,
			sectorId
		);
		if (!rows.length) throw new TriggerError(404, "SECTOR_NOT_FOUND", "Setor de atendimento não encontrado.");
	}
	private async forAdmin(db: TriageReader, session: SessionData, sectorId: number, lock = false) {
		if (session.role !== "ADMIN")
			throw new TriggerError(403, "ADMIN_REQUIRED", "A gestão de acionamentos exige um administrador.");
		if (!(await triageEnabled(db, session.instance)))
			throw new TriggerError(403, "TRIAGE_DISABLED", "A triagem está desabilitada nesta empresa.");
		await this.sector(db, session.instance, sectorId, lock);
	}
	private bots(
		db: TriageReader,
		instance: string,
		scope: { sectorId: number } | { channelId: number },
		includePaused = false
	) {
		const sectorScope = "sectorId" in scope;
		const prefix = isTenantSqlTargetPrepared(this.db, instance) ? "wpp_runtime_" : "";
		return db.$queryRawUnsafe<TriageCatalogBot[]>(
			"SELECT d.id AS botId,c.id AS channelId,c.name AS channelName,v.name,v.number AS version,v.id AS versionId " +
				"FROM clients c JOIN " +
				prefix +
				"triage_bots d ON d.channel_id=c.id AND d.instance=? " +
				"JOIN " +
				prefix +
				"triage_bot_versions v ON v.id=d.active_version_id AND v.bot_id=d.id AND v.channel_id=c.id AND v.instance=? " +
				(sectorScope
					? "JOIN _sector_clients sc ON sc.A=c.id JOIN sectors s ON s.id=sc.B AND s.instance=? AND s.receive_chats=1 "
					: "") +
				"WHERE c.instance=? AND c.is_active=1 " +
				(includePaused ? "" : "AND d.paused=0 ") +
				(sectorScope ? "AND s.id=? " : "AND c.id=? ") +
				"ORDER BY c.name,c.id,v.name,d.id",
			instance,
			instance,
			...(sectorScope ? [instance] : []),
			instance,
			sectorScope ? scope.sectorId : scope.channelId
		);
	}
	catalog(instance: string, sectorId: number, tx?: TriageReader): Promise<TriageCatalogBot[]> {
		return withDatabaseTenant(instance, async () => {
			const db = tx ?? this.db;
			if (!(await triageEnabled(db, instance))) return [];
			return this.bots(db, instance, { sectorId });
		});
	}

	private async state(db: TriageReader, instance: string, sectorId: number) {
		let rows: RuleSet[];
		try {
			rows = await db.$queryRawUnsafe<RuleSet[]>(
				"SELECT revision,rules FROM " + this.table(instance) + " WHERE instance=? AND sector_id=?",
				instance,
				sectorId
			);
		} catch (error) {
			if (missingTable(error, "triage_trigger_sets"))
				throw new TriggerError(
					503,
					"TRIGGERS_NOT_PREPARED",
					"O banco desta empresa aguarda a preparação das regras de acionamento."
				);
			throw error;
		}
		const row = rows[0];
		return { revision: row?.revision ?? 0, rules: row ? decodeRules(JSON.parse(row.rules)) : [] };
	}
	adminCatalog(session: SessionData, sectorId: number) {
		return withDatabaseTenant(session.instance, async () => {
			await this.forAdmin(this.db, session, sectorId);
			return { bots: await this.bots(this.db, session.instance, { sectorId }) };
		});
	}
	settings(session: SessionData, sectorId: number) {
		return withDatabaseTenant(session.instance, () =>
			this.db.$transaction(
				async (tx) => {
					await this.forAdmin(tx, session, sectorId);
					const state = await this.state(tx, session.instance, sectorId);
					return { ...state, bots: await this.bots(tx, session.instance, { sectorId }) };
				},
				{ isolationLevel: "RepeatableRead" }
			)
		);
	}
	replace(session: SessionData, sectorId: number, input: unknown) {
		return withDatabaseTenant(session.instance, () =>
			this.db.$transaction(
				async (tx) => {
					await this.forAdmin(tx, session, sectorId, true);
					const body = object(input);
					exactFields(body, ["revision", "rules"]);
					if (
						typeof body["revision"] !== "number" ||
						!Number.isSafeInteger(body["revision"]) ||
						body["revision"] < 0
					)
						invalid("Informe a revisão atual das regras.");
					const rules = decodeRules(body["rules"]);
					const current = await this.state(tx, session.instance, sectorId);
					if (current.revision !== body["revision"])
						throw new TriggerError(
							409,
							"TRIGGER_CONFLICT",
							"As regras mudaram. Recarregue antes de salvar."
						);
					const bots = await this.bots(tx, session.instance, { sectorId });
					let hasPausedRules = false;
					for (const rule of rules) {
						if (bots.some((bot) => bot.botId === rule.botId)) continue;
						// An unchanged paused binding may remain while another rule is edited.
						if (!current.rules.some((previous) => JSON.stringify(previous) === JSON.stringify(rule)))
							invalid("O bot precisa estar publicado e ativo em um canal deste setor.");
						hasPausedRules = true;
					}
					validateConflicts(
						rules,
						hasPausedRules ? await this.bots(tx, session.instance, { sectorId }, true) : bots
					);
					if (JSON.stringify(current.rules) === JSON.stringify(rules)) return { ...current, bots };
					await tx.$executeRawUnsafe(
						"INSERT INTO " +
							this.table(session.instance) +
							" (instance,sector_id,revision,rules,edited_by) VALUES(?,?,1,?,?) ON DUPLICATE KEY UPDATE " +
							"revision=revision+1,rules=VALUES(rules),edited_by=VALUES(edited_by),edited_at=CURRENT_TIMESTAMP(3)",
						session.instance,
						sectorId,
						JSON.stringify(rules),
						session.userId
					);
					return { revision: current.revision + 1, rules, bots };
				},
				{ isolationLevel: "ReadCommitted" }
			)
		);
	}
	simulate(session: SessionData, sectorId: number, input: unknown) {
		return withDatabaseTenant(session.instance, async () => {
			await this.forAdmin(this.db, session, sectorId);
			const body = object(input);
			exactFields(body, ["rules", "channelId", "type", "text", "botId"]);
			const rules = decodeRules(body["rules"]),
				channelId = body["channelId"];
			if (!validId(channelId)) invalid("Selecione um canal válido.");
			const type = triggerType(body["type"]),
				text = body["text"] ?? "";
			if (typeof text !== "string" || text.length > 4096) invalid("Mensagem inválida para a simulação.");
			const selected = body["botId"];
			if (type === "manual" ? !validId(selected) : selected !== undefined)
				invalid("Informe o bot escolhido ao simular um início manual.");
			const bots = await this.bots(this.db, session.instance, { sectorId });
			validateConflicts(rules, bots);
			const eligible = new Set(
				rules
					.filter((rule) => matches(rule, { type, text, ...(validId(selected) ? { botId: selected } : {}) }))
					.map((rule) => rule.botId)
			);
			const matchesInChannel = bots.filter((bot) => bot.channelId === channelId && eligible.has(bot.botId));
			const bot = matchesInChannel.length === 1 ? matchesInChannel[0]! : null;
			return { matched: bot !== null, bot };
		});
	}
	private options(instance: string, channelId: number, event: TriageTriggerInput, tx?: TriageReader) {
		return withDatabaseTenant(instance, async () => {
			const db = tx ?? this.db;
			if (event.sectorId == null && event.type !== "keyword") return [];
			if (!(await triageEnabled(db, instance))) return [];
			let candidates: { sectorId: number; rules: string }[];
			try {
				candidates = await db.$queryRawUnsafe<{ sectorId: number; rules: string }[]>(
					"SELECT r.sector_id AS sectorId,r.rules FROM " +
						this.table(instance) +
						" r " +
						"JOIN sectors s ON s.id=r.sector_id AND s.instance=? AND s.receive_chats=1 " +
						"JOIN _sector_clients sc ON sc.B=s.id WHERE r.instance=? AND sc.A=?" +
						(event.sectorId == null ? "" : " AND s.id=?"),
					instance,
					instance,
					channelId,
					...(event.sectorId == null ? [] : [event.sectorId])
				);
			} catch (error) {
				if (missingTable(error, "triage_trigger_sets")) return [];
				throw error;
			}
			const rules = candidates.flatMap((row) =>
				decodeRules(JSON.parse(row.rules))
					.filter((rule) => matches(rule, event))
					.map((rule) => ({ sectorId: row.sectorId, botId: rule.botId }))
			);
			if (!rules.length) return [];
			const bots = await this.bots(db, instance, { channelId });
			const allowed = new Map(bots.map((bot) => [bot.botId, bot]));
			return rules.flatMap((rule) => {
				const bot = allowed.get(rule.botId);
				return bot ? [{ ...bot, sectorId: rule.sectorId }] : [];
			});
		});
	}
	manualOptions(instance: string, channelId: number, sectorId: number, tx?: TriageReader) {
		return this.options(instance, channelId, { type: "manual", sectorId }, tx);
	}
	async match(instance: string, channelId: number, event: TriageTriggerInput, tx?: TriageReader) {
		if (event.type === "manual" && !validId(event.botId)) return null;
		const candidates = await this.options(instance, channelId, event, tx);
		if (candidates.length !== 1) return null;
		const { botId, versionId, sectorId } = candidates[0]!;
		return { botId, versionId, sectorId };
	}
}
export const triageTriggers = new TriageTriggers();
