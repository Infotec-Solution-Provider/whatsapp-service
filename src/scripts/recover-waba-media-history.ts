import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Prisma, PrismaClient, WppMessage, WppMessageStatus } from "@prisma/client";
import type CreateMessageDto from "../dtos/create-message.dto";
import type InstancesClient from "../sdk-local/instance.client";
import type { Message } from "../types/whatsapp-api.types";
import { safeEncode } from "../utils/safe-encode";
import { checkWabaRecoveryDatabase, getMediaWebhook, parsePlan, readWabaCandidate, RecoveryError, Target } from "./waba-media-recovery-plan";

type HistoryReads = Pick<Prisma.TransactionClient, "$queryRaw" | "wppClient" | "wppContact" | "wppChat" | "wppMessage">;
type HistoryDatabase = HistoryReads & Pick<PrismaClient, "$transaction">;
type Crm = Pick<InstancesClient, "executeQuery">;
type Download = (clientId: number, recipient: string, instance: string, source: Message) => Promise<CreateMessageDto>;

const legacyClock = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium", hourCycle: "h23"
});

async function inspect(db: HistoryReads, target: Target, lock: boolean) {
	const row = await readWabaCandidate(db, target, lock);
	const webhook = row && getMediaWebhook(row.payload);
	const sender = webhook?.message["from"];
	const time = webhook?.message["timestamp"];
	const phoneId = webhook?.metadata?.["phone_number_id"];
	const recipient = webhook?.metadata?.["display_phone_number"];
	if (!webhook || typeof sender !== "string" || !/^\d{5,20}$/.test(sender) ||
		typeof phoneId !== "string" || !/^\d+$/.test(phoneId) || typeof recipient !== "string" ||
		!/^\+?[\d ()-]+$/.test(recipient) || typeof time !== "string" || !/^\d{10}$/.test(time)) {
		throw new RecoveryError("Webhook sem uma mensagem de mídia com origem, canal e data válidos.");
	}
	const sentAt = new Date(Number(time) * 1000);
	const [client, alternateClient] = await db.wppClient.findMany({
		where: { instance: target.instance, isActive: true, type: "WABA", WABAPhoneId: phoneId }, select: { id: true }, take: 2
	});
	const contact = await db.wppContact.findUnique({
		where: { instance_phone: { instance: target.instance, phone: sender } }, select: { id: true, isDeleted: true }
	});
	if (!client || alternateClient || !contact || contact.isDeleted) {
		throw new RecoveryError("Canal ou contato histórico sem correspondência única e ativa.");
	}
	const [chat, alternateChat] = await db.wppChat.findMany({
		where: {
			instance: target.instance, contactId: contact.id, startedAt: { lte: sentAt },
			OR: [{ finishedAt: { gte: sentAt } }, { finishedAt: null, isFinished: false }],
			sector: { clients: { some: { id: client.id } } }
		}, select: { id: true, isFinished: true, sectorId: true, userId: true }, take: 2
	});
	if (!chat || alternateChat) throw new RecoveryError("A mensagem não tem um único atendimento histórico neste canal.");
	if (!chat.isFinished) {
		const [autoClose] = await db.$queryRaw<{ value: string }[]>(Prisma.sql`
			SELECT value FROM parameters WHERE \`key\` = 'chat_auto_finish_enabled' AND (
				(scope = 'INSTANCE' AND instance = ${target.instance})
				OR (scope = 'SECTOR' AND sectorId = ${chat.sectorId} AND (instance = ${target.instance} OR instance IS NULL))
				OR (scope = 'USER' AND instance = ${target.instance} AND userId = ${chat.userId})
			) ORDER BY FIELD(scope, 'INSTANCE', 'SECTOR', 'USER') DESC, id DESC LIMIT 1
		`);
		if (autoClose?.value === "true") throw new RecoveryError("O atendimento aberto tem encerramento automático habilitado.");
	}

	const { id: wabaId, type } = webhook;
	const match = await db.wppMessage.findUnique({ where: { wabaId } });
	if (match && (match.instance !== target.instance || match.clientId !== client.id || match.contactId !== contact.id ||
		match.chatId !== chat.id || match.from !== sender || match.to !== `me:${recipient}` || match.type !== type ||
		match.sentAt.getTime() !== sentAt.getTime() || match.timestamp !== String(sentAt.getTime()) || !match.fileId)) {
		throw new RecoveryError("O WAMID já pertence a uma mensagem sem a associação e o arquivo esperados.");
	}
	const complete = row?.status === "COMPLETED" && Boolean(match);
	if (!complete && (row?.status !== "FAILED" || !row.exhausted || !row.connectionRefused || row.updatedAt !== target.updatedAt)) {
		throw new RecoveryError("O evento mudou de versão ou já saiu da falha terminal do storage-client.");
	}
	return { source: webhook.message as unknown as Message, recipient, sender, type, sentAt, clientId: client.id,
		contactId: contact.id, chatId: chat.id, match, complete };
}

const crmTimeout = { timeoutMs: 15_000 };

async function crmHasExactMessage(crm: Crm, msg: WppMessage) {
	const rows = await crm.executeQuery<unknown[]>(msg.instance, `
		SELECT 1 FROM wpp_messages WHERE id = ? AND instance = ? AND waba_id = ? AND chat_id = ?
			AND contact_id = ? AND client_id = ? AND file_id = ? AND \`from\` = ? AND \`to\` = ? AND type = ?
			AND timestamp = ? AND sent_at = ? LIMIT 1
	`, [msg.id, msg.instance, msg.wabaId, msg.chatId, msg.contactId, msg.clientId, msg.fileId, msg.from, msg.to, msg.type,
		msg.timestamp, legacyClock.format(msg.sentAt)], crmTimeout);
	return rows.length === 1;
}

async function mirrorToCrm(crm: Crm, msg: WppMessage) {
	if (await crmHasExactMessage(crm, msg)) return;
	// A conflict stays untouched. The scoped readback decides whether the CRM copy is valid.
	await crm.executeQuery(msg.instance, `
		INSERT INTO wpp_messages (id, instance, waba_id, \`from\`, \`to\`, type, quoted_id, chat_id,
			contact_id, is_forwarded, body, timestamp, sent_at, status, file_id, file_name, file_type, file_size, client_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE id = id
	`, [msg.id, msg.instance, msg.wabaId, msg.from, msg.to, msg.type, msg.quotedId, msg.chatId, msg.contactId,
		Number(msg.isForwarded), safeEncode(msg.body) || "", msg.timestamp, legacyClock.format(msg.sentAt), msg.status,
		msg.fileId, safeEncode(msg.fileName), msg.fileType, msg.fileSize, msg.clientId], crmTimeout);
	if (!await crmHasExactMessage(crm, msg)) throw new RecoveryError("A cópia histórica não foi confirmada no CRM do tenant.");
}

const consistent = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

async function persistHistory(db: HistoryDatabase, target: Target, normalized: CreateMessageDto) {
	return db.$transaction(async (tx) => {
		const state = await inspect(tx, target, true);
		if (state.match) return state.match;
		if (normalized.instance !== target.instance || normalized.clientId !== state.clientId ||
			normalized.wabaId !== state.source.id || normalized.type !== state.type || normalized.from !== state.sender ||
			normalized.to !== `me:${state.recipient}` || normalized.sentAt.getTime() !== state.sentAt.getTime() ||
			normalized.timestamp !== String(state.sentAt.getTime()) || !normalized.fileId ||
			!Number.isSafeInteger(normalized.fileId) || normalized.fileId < 1 || !normalized.fileType || !normalized.fileSize) {
			throw new RecoveryError("O arquivo retornado não preserva a identidade da mensagem histórica.");
		}
		const quote = typeof normalized.quotedId === "number" ? await tx.wppMessage.findFirst({
			where: { id: normalized.quotedId, contactId: state.contactId, instance: target.instance }, select: { id: true }
		}) : null;
		return tx.wppMessage.create({ data: {
			instance: target.instance, wabaId: state.source.id, from: state.sender, to: normalized.to, type: state.type,
			status: WppMessageStatus.RECEIVED, sentAt: state.sentAt, timestamp: normalized.timestamp, body: normalized.body,
			quotedId: quote?.id ?? null, isForwarded: normalized.isForwarded ?? false, clientId: state.clientId,
			contactId: state.contactId, chatId: state.chatId, fileId: normalized.fileId, fileName: normalized.fileName ?? null,
			fileType: normalized.fileType, fileSize: normalized.fileSize
		} });
	}, consistent);
}

export async function recoverWabaMediaHistory(
	db: HistoryDatabase, crm: Crm, download: Download, database: string, plan: unknown, apply: boolean
) {
	const targets = parsePlan(plan);
	await checkWabaRecoveryDatabase(db, database);
	const states = [];
	for (const target of targets) {
		const state = await inspect(db, target, false);
		// Check the tenant route and table before any download or central write.
		const legacy = await crm.executeQuery<unknown[]>(target.instance,
			"SELECT id FROM wpp_messages WHERE waba_id = ? LIMIT 1", [state.source.id], crmTimeout);
		if ((!state.match && legacy.length > 0) || (state.complete && (!state.match || !await crmHasExactMessage(crm, state.match)))) {
			throw new RecoveryError("O estado do histórico do CRM exige reconciliação antes da recuperação.");
		}
		states.push({ target, state });
	}
	if (new Set(states.map(({ state }) => state.source.id)).size !== states.length) {
		throw new RecoveryError("O plano repete o mesmo WAMID em mais de um item.");
	}
	const alreadyComplete = states.filter(({ state }) => state.complete).length;
	let recovered = 0;
	if (apply) {
		for (const { target, state } of states) {
			if (state.complete) continue;
			try {
				const stored = state.match ?? await persistHistory(db, target,
					await download(state.clientId, state.recipient, target.instance, state.source));
				await mirrorToCrm(crm, stored);
				await db.$transaction(async (tx) => {
					const latest = await inspect(tx, target, true);
					if (!latest.match || latest.match.id !== stored.id || latest.match.fileId !== stored.fileId) {
						throw new RecoveryError("O registro histórico mudou durante a cópia ao CRM.");
					}
					if (latest.complete) return;
					const changed = await tx.$executeRaw(Prisma.sql`
						UPDATE waba_webhook_queue SET status = 'COMPLETED', error = NULL, ignored_reason = NULL,
							processed_at = NOW(3), updated_at = NOW(3)
						WHERE id = ${target.id} AND instance = ${target.instance} AND status = 'FAILED'
							AND updated_at = CAST(${target.updatedAt} AS DATETIME(3))
					`);
					if (changed !== 1) throw new RecoveryError("O item mudou antes da confirmação final na fila.");
				}, consistent);
				recovered++;
			} catch (error) {
				const detail = error instanceof RecoveryError ? ` ${error.message}` : "";
				throw new RecoveryError(`Recuperação interrompida após ${recovered} itens concluídos nesta execução.${detail}`);
			}
		}
	}
	return { eligible: states.length - alreadyComplete, alreadyComplete, recovered };
}

async function main() {
	const { values } = parseArgs({ options: { plan: { type: "string" }, database: { type: "string" }, apply: { type: "boolean" }, help: { type: "boolean" } } });
	if (values.help) {
		console.log("node dist/scripts/recover-waba-media-history.js --database <nome> --plan <arquivo.json> [--apply]");
		console.log('Plano JSON: [{"id":"<hash de 36 caracteres ou UUID v4>","instance":"<tenant>","updatedAt":"YYYY-MM-DD HH:mm:ss.SSS"}]');
		console.log("Sem --apply, apenas consulta. Aplicar recupera mídia no atendimento existente e confirma a cópia ao CRM.");
		return;
	}
	if (!values.plan || !values.database) throw new RecoveryError("Informe --plan e --database. Use --help para o formato.");
	const plan: unknown = JSON.parse(await readFile(values.plan, "utf8"));
	await import("dotenv/config");
	const { assertOdimChannelAllowed } = require("../utils/odim-access-only") as typeof import("../utils/odim-access-only");
	for (const { instance } of parsePlan(plan)) assertOdimChannelAllowed(instance);
	const db = new PrismaClient();
	try {
		const crm = (require("../services/instances.service") as typeof import("../services/instances.service")).default;
		const download: Download = async (...args) => {
			const parser = (require("../parsers/waba-message.parser") as typeof import("../parsers/waba-message.parser")).default;
			return parser.parse(...args);
		};
		const result = await recoverWabaMediaHistory(db, crm, download, values.database, plan, Boolean(values.apply));
		console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry-run", ...result }));
	} finally {
		await db.$disconnect();
	}
}

if (require.main === module) {
	void main().catch((error: unknown) => {
		console.error(error instanceof RecoveryError ? error.message : "Falha no comando de recuperação histórica de mídia WABA.");
		process.exitCode = 1;
	});
}
