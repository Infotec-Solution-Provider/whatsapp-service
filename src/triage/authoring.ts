import { BadRequestError, ConflictError, NotFoundError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import database from "../services/prisma.service";
import instances from "../services/instances.service";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import positiveResourceId from "../utils/positive-resource-id";
import { encodeTriageDraft } from "./draft";
import { assertTriageTables, missingBindingsTable } from "./readiness";
import { isTenantSqlTargetPrepared } from "../tenant-sql/router";
import {
	createTriageTemplate,
	simulateTriage,
	validateTriageDefinition,
	type TriageDefinition,
	type TriageSimulationEvent
} from "./engine";
import {
	authorizeChannel,
	channelSectors,
	findChannel,
	requireAdmin,
	requireFeature,
	requestBody,
	triageEnabled,
	type NamedResource,
	type TriageReader,
	type TriageWriter
} from "./access";

interface ChannelDraft {
	id: number;
	revision: number;
	name: string;
	definition: string;
	active_version_id: number | null;
	paused: number | boolean;
	edited_by: number;
	edited_at: Date;
}
interface StoredVersion {
	id: number;
	bot_id: number;
	channel_id: number;
	number: number;
	name: string;
	definition: string;
}
interface AuditEntry {
	action: string;
	versionId: number | null;
	actorId: number;
	targetUserId: number | null;
	previousVersionId: number | null;
	createdAt: Date;
}
type TransactionDatabase = TriageReader & {
	$transaction<T>(
		operation: (tx: TriageWriter) => Promise<T>,
		options?: { isolationLevel: "ReadCommitted" | "RepeatableRead" }
	): Promise<T>;
};
type CrmDirectory = Pick<typeof instances, "executeQuery">;

function templateFor(sectors: NamedResource[]) {
	const match = (pattern: RegExp) => sectors.find((s) => pattern.test(s.name))?.id;
	const sales = match(/^(vendas|comercial)$/i);
	const support = match(/^(suporte|assistência técnica)$/i);
	const fallback =
		match(/^(atendimento|recep[çc][aã]o|triagem)$/i) ?? (sectors.length === 1 ? sectors[0]?.id : undefined);
	return createTriageTemplate({
		...(sales ? { sales } : {}),
		...(support ? { support } : {}),
		...(fallback ? { fallback } : {})
	});
}
function parseStored(value: string): TriageDefinition {
	return JSON.parse(value) as TriageDefinition;
}
function revisionOf(value: unknown) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new BadRequestError("Revisão inválida.");
	return value;
}
function definitionOf(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new BadRequestError("Informe o fluxo como um objeto.");
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > 192 * 1024) throw new BadRequestError("O fluxo excede o limite de 192 KiB.");
	return json;
}
function nameOf(value: unknown) {
	if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 120)
		throw new BadRequestError("Informe um nome entre 1 e 120 caracteres.");
	return value.trim();
}
function validateClock(value: unknown): Date {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new BadRequestError("Informe uma data e hora válida com fuso no simulador.");
	}
	return new Date(value);
}
function simulationEvents(value: unknown, start: Date): TriageSimulationEvent[] {
	if (!Array.isArray(value) || value.length > 100) throw new BadRequestError("O simulador aceita até 100 entradas.");
	let timestamp = start.getTime();
	return value.map((item) => {
		const event = requestBody(item, ["type", "text", "at"]);
		const at = event["at"];
		if (at !== undefined) {
			const next = validateClock(at).getTime();
			if (next < timestamp) throw new BadRequestError("A simulação deve avançar em ordem cronológica.");
			timestamp = next;
		}
		const clock = typeof at === "string" ? { at } : {};
		if (event["type"] === "timeout" && event["text"] === undefined) return { type: "timeout", ...clock };
		if (event["type"] === "reply" && typeof event["text"] === "string" && event["text"].length <= 4096)
			return { type: "reply", text: event["text"], ...clock };
		throw new BadRequestError("Entrada inválida no simulador.");
	});
}
async function draftRow(db: TriageReader, instance: string, channelId: number, botId?: number, lock = false) {
	const [slot] = await db.$queryRawUnsafe<ChannelDraft[]>(
		"SELECT id,revision,name,definition,active_version_id,paused,edited_by,edited_at FROM triage_bots WHERE instance=? AND channel_id=? AND " +
			(botId === undefined ? "default_slot=1" : "id=?") +
			(lock ? " FOR UPDATE" : ""),
		instance,
		channelId,
		...(botId === undefined ? [] : [botId])
	);
	if (botId !== undefined && !slot) throw new NotFoundError("Bot não encontrado neste canal.");
	return slot;
}
async function versionRow(db: TriageReader, instance: string, channelId: number, botId: number, versionId: number) {
	const [version] = await db.$queryRawUnsafe<StoredVersion[]>(
		"SELECT id,channel_id,bot_id,number,name,definition FROM triage_bot_versions WHERE instance=? AND channel_id=? AND bot_id=? AND id=?",
		instance,
		channelId,
		botId,
		versionId
	);
	return version;
}
async function recordAudit(
	db: TriageWriter,
	session: SessionData,
	channelId: number,
	action: string,
	versionId: number | null,
	targetUserId: number | null = null,
	previousVersionId: number | null = null,
	botId: number | null = null
) {
	await db.$executeRawUnsafe(
		"INSERT INTO triage_audit(instance,channel_id,actor_id,action,version_id,target_user_id,previous_version_id,bot_id) VALUES(?,?,?,?,?,?,?,?)",
		session.instance,
		channelId,
		session.userId,
		action,
		versionId,
		targetUserId,
		previousVersionId,
		botId
	);
}

export class TriageAuthoring {
	constructor(
		private readonly db: TransactionDatabase = database,
		private readonly crm: CrmDirectory = instances
	) {}

	async requirePrepared(session: SessionData) {
		return withDatabaseTenant(session.instance, async () => {
			await requireFeature(this.db, session);
			await assertTriageTables(this.db, isTenantSqlTargetPrepared(this.db, session.instance));
		});
	}

	async context(session: SessionData) {
		return withDatabaseTenant(session.instance, async () => {
			await requireFeature(this.db, session);
			const isAdmin = session.role === "ADMIN";
			const grantJoin = isAdmin
				? ""
				: " JOIN triage_grants g ON g.instance=? AND g.channel_id=c.id AND g.user_id=?";
			const params = isAdmin ? [] : [session.instance, session.userId];
			const rows = await this.db.$queryRawUnsafe<
				(NamedResource & {
					phone: string | null;
					hasDraft: number | bigint;
					paused: number | null;
					activeVersionNumber: number | null;
				})[]
			>(
				"SELECT c.id,c.name,c.phone,CASE WHEN d.channel_id IS NULL THEN 0 WHEN v.id IS NULL OR BINARY d.name<>BINARY v.name OR BINARY d.definition<>BINARY v.definition THEN 1 ELSE 0 END AS hasDraft,d.paused,v.number AS activeVersionNumber FROM clients c" +
					grantJoin +
					" LEFT JOIN triage_bots d ON d.instance=? AND d.channel_id=c.id AND d.default_slot=1 LEFT JOIN triage_bot_versions v ON v.instance=d.instance AND v.bot_id=d.id AND v.id=d.active_version_id" +
					" WHERE c.instance=? AND c.is_active=1 ORDER BY c.name,c.id",
				...params,
				session.instance,
				session.instance
			);
			const channels = rows.map((row) => ({
				...row,
				hasDraft: Boolean(Number(row.hasDraft)),
				paused: row.paused == null || Boolean(row.paused)
			}));
			const sectors = await this.db.$queryRawUnsafe<NamedResource[]>(
				"SELECT DISTINCT s.id,s.name FROM clients c" +
					grantJoin +
					" JOIN _sector_clients sc ON sc.A=c.id JOIN sectors s ON sc.B=s.id AND s.instance=? WHERE c.instance=? AND c.is_active=1 AND s.receive_chats=1 ORDER BY s.name,s.id",
				...params,
				session.instance,
				session.instance
			);
			return { isAdmin, channels, sectors };
		});
	}

	private async detail(db: TriageReader, instance: string, channel: NamedResource, botId?: number) {
		const row = await draftRow(db, instance, channel.id, botId);
		const sectors = await channelSectors(db, instance, channel.id);
		const template = templateFor(sectors);
		const active =
			row?.active_version_id != null
				? await versionRow(db, instance, channel.id, row.id, row.active_version_id)
				: undefined;
		const versions = await db.$queryRawUnsafe<
			{ id: number; number: number; name: string; createdBy: number; createdAt: Date }[]
		>(
			"SELECT id,number,name,created_by AS createdBy,created_at AS createdAt FROM triage_bot_versions WHERE instance=? AND channel_id=? AND bot_id=? ORDER BY number DESC",
			instance,
			channel.id,
			row?.id ?? 0
		);
		const history = await db.$queryRawUnsafe<AuditEntry[]>(
			"SELECT action,version_id AS versionId,previous_version_id AS previousVersionId,actor_id AS actorId,target_user_id AS targetUserId,created_at AS createdAt FROM triage_audit WHERE instance=? AND channel_id=? AND (bot_id=? OR bot_id IS NULL) ORDER BY id DESC LIMIT 100",
			instance,
			channel.id,
			row?.id ?? 0
		);
		return {
			botId: row?.id ?? null,
			channelId: channel.id,
			channelName: channel.name,
			name: row?.name ?? "Triagem de atendimento",
			revision: row?.revision ?? 0,
			definition: row ? parseStored(row.definition) : template,
			activeVersionId: active?.id ?? null,
			activeName: active?.name ?? null,
			activeDefinition: active ? parseStored(active.definition) : null,
			paused: row ? Boolean(row.paused) : true,
			editedBy: row?.edited_by ?? null,
			editedAt: row?.edited_at ?? null,
			sectors,
			template,
			versions,
			history
		};
	}

	get(session: SessionData, channelId: number, botId?: number) {
		return withDatabaseTenant(session.instance, () =>
			this.db.$transaction(
				async (tx) => {
					const channel = await authorizeChannel(tx, session, channelId);
					return this.detail(tx, session.instance, channel, botId);
				},
				{ isolationLevel: "RepeatableRead" }
			)
		);
	}

	async preview(session: SessionData, channelId: number, input: unknown, simulate: boolean) {
		const body = requestBody(input, simulate ? ["definition", "events", "startTime"] : ["definition"]);
		return withDatabaseTenant(session.instance, async () => {
			await authorizeChannel(this.db, session, channelId);
			const definition = body["definition"];
			definitionOf(definition);
			const sectors = await channelSectors(this.db, session.instance, channelId);
			const issues = validateTriageDefinition(
				definition,
				sectors.map((item) => item.id)
			);
			if (!simulate) return { issues };
			const start = validateClock(body["startTime"]);
			const events = simulationEvents(body["events"], start);
			try {
				return {
					issues,
					turns: issues.length ? [] : simulateTriage(definition as TriageDefinition, events, start)
				};
			} catch (error) {
				throw new BadRequestError(error instanceof Error ? error.message : "Eventos da simulação inválidos.");
			}
		});
	}

	listBots(session: SessionData, channelId: number) {
		return withDatabaseTenant(session.instance, () =>
			this.db.$transaction(
				async (tx) => {
					await authorizeChannel(tx, session, channelId);
					const rows = await tx.$queryRawUnsafe<
						{
							id: number;
							name: string;
							revision: number;
							activeVersionId: number | null;
							paused: number;
							defaultSlot: number | null;
						}[]
					>(
						"SELECT id,name,revision,active_version_id AS activeVersionId,paused,default_slot AS defaultSlot FROM triage_bots WHERE instance=? AND channel_id=? ORDER BY name,id",
						session.instance,
						channelId
					);
					return {
						defaultBotId: rows.find((row) => row.defaultSlot === 1)?.id ?? null,
						bots: rows.map(({ defaultSlot: _slot, ...row }) => ({ ...row, paused: Boolean(row.paused) }))
					};
				},
				{ isolationLevel: "RepeatableRead" }
			)
		);
	}

	createBot(session: SessionData, channelId: number, input: unknown) {
		const name = nameOf(requestBody(input, ["name"])["name"]);
		return withDatabaseTenant(session.instance, () =>
			this.db.$transaction(
				async (tx) => {
					const channel = await authorizeChannel(tx, session, channelId, true);
					const defaultBot = await draftRow(tx, session.instance, channelId);
					const template = templateFor(await channelSectors(tx, session.instance, channelId));
					await this.checkName(tx, session.instance, channelId, name);
					const id = await this.insertBot(
						tx,
						session,
						channelId,
						name,
						encodeTriageDraft(template),
						!defaultBot
					);
					return this.detail(tx, session.instance, channel, id);
				},
				{ isolationLevel: "ReadCommitted" }
			)
		);
	}

	private async checkName(tx: TriageReader, instance: string, channelId: number, name: string, id = 0) {
		const [existing] = await tx.$queryRawUnsafe<{ id: number }[]>(
			"SELECT id FROM triage_bots WHERE instance=? AND channel_id=? AND name=? AND id<>? LIMIT 1",
			instance,
			channelId,
			name,
			id
		);
		if (existing) throw new BadRequestError("Já existe um bot com esse nome neste canal.");
	}

	private async insertBot(
		tx: TriageWriter,
		session: SessionData,
		channelId: number,
		name: string,
		definition: string,
		primary: boolean
	) {
		await tx.$executeRawUnsafe(
			"INSERT INTO triage_bots(instance,channel_id,default_slot,revision,name,definition,edited_by) VALUES(?,?,?,1,?,?,?)",
			session.instance,
			channelId,
			primary ? 1 : null,
			name,
			definition,
			session.userId
		);
		const [created] = await tx.$queryRawUnsafe<{ id: number }[]>(
			"SELECT id FROM triage_bots WHERE instance=? AND channel_id=? AND name=?",
			session.instance,
			channelId,
			name
		);
		if (!created) throw new Error("TRIAGE_BOT_CREATE_FAILED");
		return created.id;
	}

	mutate(
		session: SessionData,
		channelId: number,
		action: "save" | "publish" | "rollback" | "pause",
		input: unknown,
		botId?: number
	) {
		const fields =
			action === "save"
				? ["revision", "name", "definition"]
				: action === "rollback"
					? ["revision", "versionId"]
					: ["revision"];
		const body = requestBody(input, fields);
		const expectedRevision = revisionOf(body["revision"]);
		const instance = session.instance;
		return withDatabaseTenant(instance, () =>
			this.db.$transaction(
				async (tx) => {
					const channel = await authorizeChannel(tx, session, channelId, true);
					const draft = await draftRow(tx, instance, channelId, botId, true);
					if (expectedRevision !== (draft?.revision ?? 0))
						throw new ConflictError("Outro usuário alterou a triagem. Recarregue a versão atual.");
					if (action === "save") {
						const name = nameOf(body["name"]),
							definition = encodeTriageDraft(body["definition"]);
						await this.checkName(tx, instance, channelId, name, draft?.id);
						if (draft)
							await tx.$executeRawUnsafe(
								"UPDATE triage_bots SET revision=revision+1,name=?,definition=?,edited_by=?,edited_at=CURRENT_TIMESTAMP(3) WHERE instance=? AND channel_id=? AND id=?",
								name,
								definition,
								session.userId,
								instance,
								channelId,
								draft.id
							);
						else await this.insertBot(tx, session, channelId, name, definition, true);
					} else {
						if (!draft) throw new BadRequestError("Salve um rascunho antes desta operação.");
						let versionId = draft.active_version_id;
						if (action === "pause") {
							if (!versionId || draft.paused)
								throw new ConflictError("Não há uma triagem ativa neste canal.");
						} else {
							const sectors = await channelSectors(tx, instance, channelId);
							const selected =
								action === "rollback"
									? await versionRow(
											tx,
											instance,
											channelId,
											draft.id,
											positiveResourceId(body["versionId"])
										)
									: draft;
							if (!selected) throw new NotFoundError("Versão não encontrada neste canal.");
							const issues = validateTriageDefinition(
								parseStored(selected.definition),
								sectors.map((item) => item.id)
							);
							if (issues.length)
								throw new BadRequestError("Corrija as pendências do fluxo antes de ativá-lo.", {
									issues
								});
							if (action === "publish") {
								const [latest] = await tx.$queryRawUnsafe<{ number: number }[]>(
									"SELECT number FROM triage_bot_versions WHERE instance=? AND channel_id=? AND bot_id=? ORDER BY number DESC LIMIT 1 FOR UPDATE",
									instance,
									channelId,
									draft.id
								);
								const number = (latest?.number ?? 0) + 1;
								await tx.$executeRawUnsafe(
									"INSERT INTO triage_bot_versions(instance,channel_id,bot_id,number,name,definition,created_by) VALUES(?,?,?,?,?,?,?)",
									instance,
									channelId,
									draft.id,
									number,
									selected.name,
									selected.definition,
									session.userId
								);
								const [published] = await tx.$queryRawUnsafe<{ id: number }[]>(
									"SELECT id FROM triage_bot_versions WHERE instance=? AND channel_id=? AND bot_id=? AND number=?",
									instance,
									channelId,
									draft.id,
									number
								);
								versionId = published!.id;
							} else {
								versionId = positiveResourceId(body["versionId"]);
							}
						}
						await tx.$executeRawUnsafe(
							"UPDATE triage_bots SET revision=revision+1,active_version_id=?,paused=? WHERE instance=? AND channel_id=? AND id=?",
							versionId,
							action === "pause",
							instance,
							channelId,
							draft.id
						);
						await recordAudit(
							tx,
							session,
							channelId,
							action === "pause" ? "PAUSED" : action === "publish" ? "PUBLISHED" : "ROLLED_BACK",
							versionId,
							null,
							draft.active_version_id,
							draft.id
						);
					}
					return this.detail(tx, instance, channel, botId);
				},
				{ isolationLevel: "ReadCommitted" }
			)
		);
	}

	private grantList(db: TriageReader, instance: string, channelId: number) {
		return db.$queryRawUnsafe<NamedResource[]>(
			"SELECT user_id AS id,user_name AS name FROM triage_grants WHERE instance=? AND channel_id=? ORDER BY user_name,user_id",
			instance,
			channelId
		);
	}

	async grants(session: SessionData, channelId: number) {
		requireAdmin(session);
		return withDatabaseTenant(session.instance, async () => {
			await authorizeChannel(this.db, session, channelId);
			return { users: await this.grantList(this.db, session.instance, channelId) };
		});
	}
	private eligibleUsers(instance: string, search: string | number) {
		const numeric = typeof search === "number";
		return this.crm.executeQuery<NamedResource[]>(
			instance,
			"SELECT CODIGO AS id,NOME AS name FROM operadores WHERE ATIVO='SIM' AND NIVEL IN ('ATIVO','RECEP','AMBOS','SUPERVISOR') AND " +
				(numeric ? "CODIGO=?" : "(LOCATE(?,NOME)>0 OR CAST(CODIGO AS CHAR)=?)") +
				" ORDER BY NOME,CODIGO LIMIT 50",
			numeric ? [search] : [search, search]
		);
	}
	async operators(session: SessionData, search: unknown) {
		requireAdmin(session);
		if (typeof search !== "string" || search.length > 100) throw new BadRequestError("Busca inválida.");
		await withDatabaseTenant(session.instance, () => requireFeature(this.db, session));
		return { users: await this.eligibleUsers(session.instance, search.trim()) };
	}
	async setGrant(session: SessionData, channelId: number, userId: number, input: unknown) {
		requireAdmin(session);
		const enabled = requestBody(input, ["enabled"])["enabled"];
		if (typeof enabled !== "boolean") throw new BadRequestError("Informe se o acesso deve ser concedido.");
		return withDatabaseTenant(session.instance, async () => {
			await authorizeChannel(this.db, session, channelId);
			// The CRM HTTP request must finish before the database transaction takes the channel lock.
			const [user] = enabled ? await this.eligibleUsers(session.instance, userId) : [];
			if (enabled && !user) throw new BadRequestError("Selecione um usuário interno ativo desta empresa.");
			return this.db.$transaction(
				async (tx) => {
					await authorizeChannel(tx, session, channelId, true);
					const users = await this.grantList(tx, session.instance, channelId);
					if (users.some((item) => item.id === userId) !== enabled) {
						if (enabled)
							await tx.$executeRawUnsafe(
								"INSERT INTO triage_grants(instance,channel_id,user_id,user_name) VALUES(?,?,?,?)",
								session.instance,
								channelId,
								userId,
								user!.name
							);
						else
							await tx.$executeRawUnsafe(
								"DELETE FROM triage_grants WHERE instance=? AND channel_id=? AND user_id=?",
								session.instance,
								channelId,
								userId
							);
						await recordAudit(tx, session, channelId, enabled ? "GRANTED" : "REVOKED", null, userId);
					}
					return { users: await this.grantList(tx, session.instance, channelId) };
				},
				{ isolationLevel: "ReadCommitted" }
			);
		});
	}

	async requireChannel(session: SessionData, channelId: number, tx?: TriageReader) {
		return withDatabaseTenant(session.instance, () =>
			authorizeChannel(tx ?? this.db, session, channelId, Boolean(tx))
		);
	}

	activeForChannel(instance: string, channelId: number, tx?: TriageReader) {
		return this.findActive(instance, channelId, undefined, tx);
	}
	activeForBot(instance: string, channelId: number, botId: number, tx?: TriageReader) {
		return this.findActive(instance, channelId, botId, tx);
	}
	async hasActiveBot(instance: string, channelId: number) {
		return withDatabaseTenant(instance, async () => {
			if (!(await triageEnabled(this.db, instance))) return false;
			try {
				const [row] = await this.db.$queryRawUnsafe<{ id: number }[]>(
					"SELECT b.id FROM triage_bots b JOIN clients c ON c.instance=? AND c.id=b.channel_id WHERE b.instance=? AND b.channel_id=? AND c.is_active=1 AND b.paused=0 AND b.active_version_id IS NOT NULL LIMIT 1",
					instance,
					instance,
					channelId
				);
				return Boolean(row);
			} catch (error) {
				if (missingBindingsTable(error)) return false;
				throw error;
			}
		});
	}
	private findActive(instance: string, channelId: number, botId: number | undefined, tx?: TriageReader) {
		return withDatabaseTenant(instance, async () => {
			const db = tx ?? this.db;
			if (!(await triageEnabled(db, instance))) return null;
			if (tx && !(await findChannel(tx, instance, channelId, true))) return null;
			let slot: { id: number; active_version_id: number } | undefined;
			try {
				[slot] = await db.$queryRawUnsafe<{ id: number; active_version_id: number }[]>(
					"SELECT id,active_version_id FROM triage_bots WHERE instance=? AND channel_id=? AND paused=0 AND active_version_id IS NOT NULL AND " +
						(botId === undefined ? "default_slot=1" : "id=?") +
						(tx ? " FOR UPDATE" : ""),
					instance,
					channelId,
					...(botId === undefined ? [] : [botId])
				);
			} catch (error) {
				// Only new, unbound chats may keep using legacy routing while the tenant prepares its schema.
				if (missingBindingsTable(error)) return null;
				throw error;
			}
			if (!slot) return null;
			if (!tx && !(await findChannel(db, instance, channelId))) return null;
			const [version] = await db.$queryRawUnsafe<StoredVersion[]>(
				"SELECT id,channel_id,bot_id,number,name,definition FROM triage_bot_versions WHERE instance=? AND channel_id=? AND bot_id=? AND id=?" +
					(tx ? " FOR UPDATE" : ""),
				instance,
				channelId,
				slot.id,
				slot.active_version_id
			);
			if (!version) throw new Error("TRIAGE_ACTIVE_VERSION_MISSING");
			return this.binding(version);
		});
	}
	getRuntimeVersion(instance: string, versionId: number) {
		return withDatabaseTenant(instance, async () => {
			const [version] = await this.db.$queryRawUnsafe<StoredVersion[]>(
				"SELECT id,channel_id,bot_id,number,name,definition FROM triage_bot_versions WHERE instance=? AND id=?",
				instance,
				versionId
			);
			return version ? this.binding(version) : null;
		});
	}
	getBotRuntimeVersion(instance: string, botId: number, versionId: number, tx?: TriageReader) {
		return withDatabaseTenant(instance, async () => {
			const [row] = await (tx ?? this.db).$queryRawUnsafe<StoredVersion[]>(
				"SELECT id,channel_id,bot_id,number,name,definition FROM triage_bot_versions WHERE instance=? AND bot_id=? AND id=?",
				instance,
				botId,
				versionId
			);
			return row ? this.binding(row) : null;
		});
	}
	private binding(row: StoredVersion) {
		return {
			botId: row.bot_id,
			channelId: row.channel_id,
			versionId: row.id,
			version: row.number,
			name: row.name,
			definition: parseStored(row.definition)
		};
	}
}
export const triageAuthoring = new TriageAuthoring();
