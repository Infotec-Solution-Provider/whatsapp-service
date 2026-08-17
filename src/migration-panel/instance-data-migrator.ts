import { Prisma, WppChatPriority, WppChatType, WppMessageStatus } from "@prisma/client";
import prismaService from "../services/prisma.service";
import LegacyReader, { LegacyScanResult } from "./legacy-reader";
import MigrationStore from "./migration-store";
import {
	LegacyRow,
	MigrationInstanceConfig,
	MigrationLogEntry,
} from "./types";

type Log = (
	level: MigrationLogEntry["level"],
	message: string,
	meta?: Record<string, unknown>,
) => void;

interface MigrationMaps {
	sectors: Map<string, number>;
	contacts: Map<string, number>;
	chats: Map<string, number>;
	messages: Map<string, number>;
	readyMessages: Map<string, number>;
}

interface PendingQuote {
	targetId: number;
	reference: string;
}

const text = (row: LegacyRow, ...keys: string[]): string => {
	for (const key of keys) {
		const direct = row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
		if (direct !== undefined && direct !== null) {
			return String(direct).trim();
		}
		const found = Object.entries(row).find(([rowKey]) => rowKey.toUpperCase() === key.toUpperCase());
		if (found && found[1] !== null && found[1] !== undefined) {
			return String(found[1]).trim();
		}
	}
	return "";
};

const integer = (row: LegacyRow, ...keys: string[]): number | null => {
	const raw = text(row, ...keys);
	if (!raw) return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : null;
};

const booleanValue = (value: unknown, fallback = false): boolean => {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toUpperCase();
		if (["1", "TRUE", "SIM", "YES", "S", "ATIVO", "RECEP", "Y"].includes(normalized)) return true;
		if (["0", "FALSE", "NAO", "NÃO", "NO", "N", "INATIVO"].includes(normalized)) return false;
	}
	return fallback;
};

const booleanFrom = (row: LegacyRow, fallback: boolean, ...keys: string[]): boolean => {
	const value = keys.map((key) => row[key] ?? row[key.toUpperCase()]).find((item) => item !== undefined && item !== null);
	return booleanValue(value, fallback);
};

const sourceId = (row: LegacyRow): string => text(row, "CODIGO");

const normalizedPhone = (value: string): string => {
	const digits = value.replace(/\D/g, "");
	if (!digits) return "";
	if (digits.startsWith("55")) return digits;
	if (digits.length === 10 || digits.length === 11) return `55${digits}`;
	return digits;
};

const whatsappId = (row: LegacyRow, phone: string): string => {
	const sourceWhatsappId = text(row, "WHATSAPP_ID", "WPP_ID");
	if (sourceWhatsappId) return sourceWhatsappId;
	return phone ? `${phone}@c.us` : "";
};

const dateValue = (row: LegacyRow, ...keys: string[]): Date | null => {
	const raw = keys.map((key) => row[key] ?? row[key.toUpperCase()]).find((item) => item !== undefined && item !== null && item !== "");
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
	if (typeof raw === "number") {
		const milliseconds = raw < 10_000_000_000 ? raw * 1000 : raw;
		const result = new Date(milliseconds);
		return Number.isNaN(result.getTime()) ? null : result;
	}
	if (typeof raw === "string") {
		const result = new Date(raw);
		return Number.isNaN(result.getTime()) ? null : result;
	}
	return null;
};

const bounded = (value: string, max: number): string => value.slice(0, max);

const mapChatType = (row: LegacyRow): WppChatType => {
	const type = text(row, "ATIVO_RECEP", "TIPO").toUpperCase();
	return type.includes("RECEP") ? WppChatType.RECEPTIVE : WppChatType.ACTIVE;
};

const mapPriority = (row: LegacyRow): WppChatPriority => {
	const values = ["URGENCIA_OPERADOR", "URGENCIA_AGENDAMENTO", "URGENCIA_SUPERVISOR"]
		.map((key) => text(row, key).toUpperCase());
	if (values.some((value) => ["URGENCY", "URGENTE", "4", "5"].includes(value))) return WppChatPriority.URGENCY;
	if (values.some((value) => ["VERY_HIGH", "MUITO_ALTA", "3"].includes(value))) return WppChatPriority.VERY_HIGH;
	if (values.some((value) => ["HIGH", "ALTA", "2"].includes(value))) return WppChatPriority.HIGH;
	if (values.some((value) => ["LOW", "BAIXA", "1"].includes(value))) return WppChatPriority.LOW;
	return WppChatPriority.NORMAL;
};

const mapMessageStatus = (value: string): WppMessageStatus => {
	const status = value.toUpperCase();
	if (["PENDING", "SENT", "RECEIVED", "READ", "DOWNLOADED", "ERROR", "REVOKED"].includes(status)) {
		return status as WppMessageStatus;
	}
	if (["DELIVERED", "DELIVERED_TO_SERVER"].includes(status)) return WppMessageStatus.SENT;
	if (["PLAYED", "ACK_READ"].includes(status)) return WppMessageStatus.READ;
	if (["DELETED", "REVOKE"].includes(status)) return WppMessageStatus.REVOKED;
	return WppMessageStatus.RECEIVED;
};

class InstanceDataMigrator {
	constructor(private readonly store: MigrationStore, private readonly log: Log) {}

	public async load(config: MigrationInstanceConfig, reader: LegacyReader, runId: string, clientId: number): Promise<void> {
		const maps: MigrationMaps = {
			sectors: await this.store.getMaps(config.targetInstance, "sectors"),
			contacts: await this.store.getMaps(config.targetInstance, "contacts"),
			chats: await this.store.getMaps(config.targetInstance, "chats"),
			messages: await this.store.getMaps(config.targetInstance, "messages"),
			readyMessages: await this.store.getMaps(config.targetInstance, "readyMessages"),
		};
		const pendingQuotes: PendingQuote[] = [];

		if (config.options.importSectors) {
			await this.importSectors(config, reader, runId, maps.sectors, clientId);
		}
		if (config.options.importContacts) {
			await this.importContacts(config, reader, runId, maps.contacts, maps.sectors);
		}
		if (config.options.importChats) {
			await this.importChats(config, reader, runId, maps.chats, maps.contacts, maps.sectors);
		}
		if (config.options.importMessages) {
			await this.importMessages(config, reader, runId, maps.messages, maps.chats, maps.contacts, clientId, pendingQuotes);
			await this.resolveQuotes(pendingQuotes, maps.messages);
		}
		if (config.options.importReadyMessages) {
			await this.importReadyMessages(config, reader, runId, maps.readyMessages, maps.sectors);
		}
	}

	private async importSectors(
		config: MigrationInstanceConfig,
		reader: LegacyReader,
		runId: string,
		maps: Map<string, number>,
		clientId: number,
	): Promise<void> {
		const result = await reader.scanTable("sectors", config.options.batchSize, async (rows) => {
			for (const row of rows) {
				const id = sourceId(row);
				if (!id) continue;
				const name = bounded(text(row, "NOME") || `Setor legado ${id}`, 191);
				const existingId = maps.get(id);
				const byName = await prismaService.wppSector.findUnique({ where: { name } });
				if (byName && byName.instance !== config.targetInstance && byName.id !== existingId) {
					throw new Error(`Conflito de setor global: "${name}" já pertence à instância ${byName.instance}`);
				}
				const data: Prisma.WppSectorUncheckedCreateInput = {
					name,
					instance: config.targetInstance,
					startChats: booleanFrom(row, true, "INICIA_ATENDIMENTO", "START_CHATS"),
					receiveChats: booleanFrom(row, true, "RECEBE_MENSAGENS"),
					defaultClientId: clientId,
				};
				const sector = existingId
					? await prismaService.wppSector.update({ where: { id: existingId }, data })
					: byName
						? await prismaService.wppSector.update({ where: { id: byName.id }, data })
						: await prismaService.wppSector.create({ data });
				await prismaService.wppSector.update({
					where: { id: sector.id },
					data: { clients: { connect: { id: clientId } } },
				});
				maps.set(id, sector.id);
				await this.store.upsertMap(runId, config.targetInstance, "sectors", id, sector.id);
			}
		});
		this.assertAvailable("w_setores", result);
		this.log("info", `Setores importados: ${result.count}`, { count: result.count });
	}

	private async importContacts(
		config: MigrationInstanceConfig,
		reader: LegacyReader,
		runId: string,
		maps: Map<string, number>,
		sectorMaps: Map<string, number>,
	): Promise<void> {
		const result = await reader.scanTable("contacts", config.options.batchSize, async (rows) => {
			for (const row of rows) {
				const id = sourceId(row);
				if (!id) continue;
				const phone = bounded(normalizedPhone(text(row, "NUMERO", "PHONE")), 64);
				if (!phone) {
					this.log("warning", `Contato legado ${id} ignorado: número vazio`);
					continue;
				}
				const name = bounded(text(row, "NOME") || phone, 191);
				const waId = bounded(whatsappId(row, phone), 191);
				const customerId = integer(row, "CODIGO_CLIENTE");
				const contactData: Prisma.WppContactUncheckedCreateInput = {
					name,
					phone,
					whatsappId: waId || null,
					customerId,
					instance: config.targetInstance,
					isDeleted: false,
					isBlocked: false,
					isOnlyAdmin: false,
					avatarUrl: text(row, "AVATAR_URL") || null,
				};
				const mappedId = maps.get(id);
				const contactOr: Prisma.WppContactWhereInput[] = [{ phone }];
				if (waId) contactOr.push({ whatsappId: waId });
				const existing = mappedId
					? null
					: await prismaService.wppContact.findFirst({
						where: { instance: config.targetInstance, OR: contactOr },
					});
				const contact = mappedId
					? await prismaService.wppContact.update({ where: { id: mappedId }, data: contactData })
					: existing
						? await prismaService.wppContact.update({ where: { id: existing.id }, data: contactData })
						: await prismaService.wppContact.create({ data: contactData });
				maps.set(id, contact.id);
				await this.store.upsertMap(runId, config.targetInstance, "contacts", id, contact.id);

				const sectorSourceId = text(row, "SETOR", "CODIGO_SETOR");
				const sectorId = sectorMaps.get(sectorSourceId);
				if (sectorId) {
					await prismaService.wppContactSector.createMany({
						data: [{ contactId: contact.id, sectorId }],
						skipDuplicates: true,
					});
				}
			}
		});
		this.assertAvailable("w_clientes_numeros", result);
		this.log("info", `Contatos importados: ${result.count}`, { count: result.count });
	}

	private async importChats(
		config: MigrationInstanceConfig,
		reader: LegacyReader,
		runId: string,
		maps: Map<string, number>,
		contactMaps: Map<string, number>,
		sectorMaps: Map<string, number>,
	): Promise<void> {
		const result = await reader.scanTable("chats", config.options.batchSize, async (rows) => {
			for (const row of rows) {
				const id = sourceId(row);
				if (!id) continue;
				const sourceContactId = text(row, "CODIGO_NUMERO");
				const sourceSectorId = text(row, "SETOR", "CODIGO_SETOR");
				const startedAt = dateValue(row, "DATA_INICIO");
				const finishedAt = dateValue(row, "DATA_FIM");
				const userId = integer(row, "CODIGO_OPERADOR");
				const finished = booleanFrom(row, Boolean(finishedAt), "CONCLUIDO");
				const chatData: Prisma.WppChatUncheckedCreateInput = {
					instance: config.targetInstance,
					contactId: contactMaps.get(sourceContactId) ?? null,
					userId,
					resultId: integer(row, "RESULTADO"),
					sectorId: sectorMaps.get(sourceSectorId) ?? null,
					type: mapChatType(row),
					priority: mapPriority(row),
					avatarUrl: text(row, "AVATAR_URL") || null,
					isFinished: finished,
					startedAt,
					finishedAt,
					finishedBy: finished ? userId : null,
					isSchedule: Boolean(dateValue(row, "DATA_AGENDAMENTO")),
				};
				const mappedId = maps.get(id);
				const chat = mappedId
					? await prismaService.wppChat.update({ where: { id: mappedId }, data: chatData })
					: await prismaService.wppChat.create({ data: chatData });
				maps.set(id, chat.id);
				await this.store.upsertMap(runId, config.targetInstance, "chats", id, chat.id);
			}
		});
		this.assertAvailable("w_atendimentos", result);
		this.log("info", `Atendimentos importados: ${result.count}`, { count: result.count });
	}

	private async importMessages(
		config: MigrationInstanceConfig,
		reader: LegacyReader,
		runId: string,
		maps: Map<string, number>,
		chatMaps: Map<string, number>,
		contactMaps: Map<string, number>,
		clientId: number,
		pendingQuotes: PendingQuote[],
	): Promise<void> {
		let fileMetadataCount = 0;
		const result = await reader.scanTable("messages", config.options.batchSize, async (rows) => {
			for (const row of rows) {
				const id = sourceId(row);
				if (!id) continue;
				const mappedId = maps.get(id);
				const sourceContactId = text(row, "CODIGO_NUMERO");
				const contactId = contactMaps.get(sourceContactId) ?? null;
				const contact = contactId
					? await prismaService.wppContact.findUnique({ where: { id: contactId }, select: { phone: true, whatsappId: true } })
					: null;
				const fromMe = booleanFrom(row, false, "FROM_ME");
				const ownPhone = normalizedPhone(config.phone);
				const contactAddress = contact?.whatsappId || contact?.phone || "unknown";
				const from = bounded(text(row, "FROM") || (fromMe ? ownPhone : contactAddress) || "unknown", 191);
				const to = bounded(text(row, "TO") || (fromMe ? contactAddress : ownPhone) || "unknown", 191);
				const sentAt = dateValue(row, "DATA_HORA") ?? new Date(0);
				const externalId = bounded(text(row, "ID", "LOCAL_ID"), 191);
				if (text(row, "ARQUIVO")) fileMetadataCount += 1;
				const messageData: Prisma.WppMessageUncheckedCreateInput = {
					instance: config.targetInstance,
					from,
					to,
					type: bounded(text(row, "TIPO") || "chat", 64),
					chatId: chatMaps.get(text(row, "CODIGO_ATENDIMENTO")) ?? null,
					contactId,
					body: text(row, "MENSAGEM"),
					timestamp: text(row, "TIMESTAMP") || String(Math.floor(sentAt.getTime() / 1000)),
					sentAt,
					status: mapMessageStatus(text(row, "STATUS")),
					fileName: bounded(text(row, "ARQUIVO"), 191) || null,
					userId: integer(row, "CODIGO_OPERADOR"),
					clientId,
				};
				this.assignExternalId(messageData, config.provider, externalId);
				const existingByExternalId = mappedId ? null : await this.findByExternalId(config.provider, externalId);
				if (existingByExternalId && existingByExternalId.instance !== config.targetInstance) {
					throw new Error(`Conflito de identificador externo da mensagem legada ${id} em outra instância`);
				}
				const message = mappedId
					? await prismaService.wppMessage.update({ where: { id: mappedId }, data: messageData })
					: existingByExternalId
						? await prismaService.wppMessage.update({ where: { id: existingByExternalId.id }, data: messageData })
						: await prismaService.wppMessage.create({ data: messageData });
				maps.set(id, message.id);
				await this.store.upsertMap(runId, config.targetInstance, "messages", id, message.id, externalId ? bounded(externalId, 128) : undefined);
				const quoteReference = text(row, "ID_REFERENCIA");
				if (quoteReference) pendingQuotes.push({ targetId: message.id, reference: quoteReference });
			}
		});
		this.assertAvailable("w_mensagens", result);
		this.log("info", `Mensagens importadas: ${result.count}`, { count: result.count });
		if (fileMetadataCount > 0) {
			this.log("warning", `${fileMetadataCount} mensagens possuem metadata de arquivo; somente fileName foi preservado, os bytes não foram enviados ao files-service`);
		}
	}

	private async importReadyMessages(
		config: MigrationInstanceConfig,
		reader: LegacyReader,
		runId: string,
		maps: Map<string, number>,
		sectorMaps: Map<string, number>,
	): Promise<void> {
		const result = await reader.scanTable("readyMessages", config.options.batchSize, async (rows) => {
			for (const row of rows) {
				const id = sourceId(row);
				if (!id) continue;
				const sectorId = sectorMaps.get(text(row, "SETOR", "CODIGO_SETOR"));
				if (!sectorId) {
					this.log("warning", `Mensagem pronta ${id} ignorada: setor não mapeado`);
					continue;
				}
				const data: Prisma.ReadyMessageUncheckedCreateInput = {
					instance: config.targetInstance,
					sectorId,
					title: bounded(text(row, "TITULO") || `Mensagem ${id}`, 191),
					message: text(row, "TEXTO_MENSAGEM"),
					fileName: bounded(text(row, "ARQUIVO"), 191) || null,
				};
				const mappedId = maps.get(id);
				const readyMessage = mappedId
					? await prismaService.readyMessage.update({ where: { id: mappedId }, data })
					: await prismaService.readyMessage.create({ data });
				maps.set(id, readyMessage.id);
				await this.store.upsertMap(runId, config.targetInstance, "readyMessages", id, readyMessage.id);
			}
		});
		if (!result.available) {
			this.log("warning", `${result.error ?? "w_mensagens_prontas não disponível"}; mensagens prontas não foram importadas`);
			return;
		}
		this.log("info", `Mensagens prontas importadas: ${result.count}`, { count: result.count });
	}

	private async resolveQuotes(
		pendingQuotes: PendingQuote[],
		messageMaps: Map<string, number>,
	): Promise<void> {
		let resolved = 0;
		for (const quote of pendingQuotes) {
			const quotedId = messageMaps.get(quote.reference);
			if (!quotedId) continue;
			await prismaService.wppMessage.update({ where: { id: quote.targetId }, data: { quotedId } });
			resolved += 1;
		}
		if (pendingQuotes.length > 0) {
			this.log("info", `Referências de mensagens resolvidas: ${resolved}/${pendingQuotes.length}`);
		}
	}

	private assignExternalId(
		data: Prisma.WppMessageUncheckedCreateInput,
		provider: MigrationInstanceConfig["provider"],
		externalId: string,
	): void {
		if (!externalId) return;
		if (provider === "WABA") data.wabaId = externalId;
		else if (provider === "GUPSHUP") data.gupshupId = externalId;
		else data.wwebjsId = externalId;
	}

	private async findByExternalId(
		provider: MigrationInstanceConfig["provider"],
		externalId: string,
	): Promise<{ id: number; instance: string } | null> {
		if (!externalId) return null;
		if (provider === "WABA") {
			return prismaService.wppMessage.findUnique({ where: { wabaId: externalId }, select: { id: true, instance: true } });
		}
		if (provider === "GUPSHUP") {
			return prismaService.wppMessage.findUnique({ where: { gupshupId: externalId }, select: { id: true, instance: true } });
		}
		return prismaService.wppMessage.findUnique({ where: { wwebjsId: externalId }, select: { id: true, instance: true } });
	}

	private assertAvailable(table: string, result: LegacyScanResult): void {
		if (!result.available) {
			throw new Error(`${table} não pôde ser lida: ${result.error ?? "tabela ausente"}`);
		}
	}
}

export { normalizedPhone };
export default InstanceDataMigrator;
