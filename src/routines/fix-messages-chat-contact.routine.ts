import { Logger } from "@in.pulse-crm/utils";
import { WppChat, WppMessage } from "@prisma/client";
import prismaService from "../services/prisma.service";

interface FixOptions {
	instance?: string;
	dryRun?: boolean;
	batchSize?: number;
	limit?: number;
}

interface ResolvedFixOptions {
	instance?: string;
	dryRun: boolean;
	batchSize: number;
	limit: number;
}

interface FixStats {
	processed: number;
	fixed: number;
	skipped: number;
	failed: number;
}

type ContactMap = Map<string, number>;
type ChatByIdMap = Map<number, WppChat>;
type ChatTimelineCache = Map<string, WppChat[]>;
type MessageCandidate = Pick<WppMessage, "id" | "instance" | "from" | "to" | "sentAt" | "contactId" | "chatId">;

const MIN_SENT_AT = new Date("2026-03-01T00:00:00.000Z");

function normalizeDigits(value: string): string {
	return value.replace(/\D/g, "");
}

function extractPhoneCandidate(message: Pick<MessageCandidate, "from" | "to">): string | null {
	const isFromMe = message.from.startsWith("me:");
	const raw = isFromMe ? message.to : message.from;
	const digits = normalizeDigits(raw || "");

	if (digits.length < 10) {
		return null;
	}

	return digits;
}

function buildPhoneVariants(phone: string): string[] {
	const variants = new Set<string>();
	const digits = normalizeDigits(phone);

	if (!digits) {
		return [];
	}

	variants.add(digits);

	if (digits.startsWith("55") && digits.length === 13) {
		variants.add(digits.slice(0, 4) + digits.slice(5));
	}

	if (digits.startsWith("55") && digits.length === 12) {
		variants.add(digits.slice(0, 4) + "9" + digits.slice(4));
	}

	if (!digits.startsWith("55")) {
		variants.add(`55${digits}`);
		if (digits.length === 10) {
			variants.add(`55${digits.slice(0, 2)}9${digits.slice(2)}`);
		}
	}

	const noDdi = digits.startsWith("55") ? digits.slice(2) : digits;
	if (noDdi.length >= 10) {
		variants.add(noDdi);
	}

	return [...variants];
}

function findBestChatForDate(chats: WppChat[], sentAt: Date): WppChat | null {
	if (!chats.length) {
		return null;
	}

	const candidates = chats.filter((chat) => {
		const startedAt = chat.startedAt || new Date(0);
		const finishedAt = chat.finishedAt;

		if (startedAt > sentAt) {
			return false;
		}

		if (finishedAt && finishedAt < sentAt) {
			return false;
		}

		return true;
	});

	if (candidates.length > 0) {
		candidates.sort((a, b) => {
			const aStart = a.startedAt ? a.startedAt.getTime() : 0;
			const bStart = b.startedAt ? b.startedAt.getTime() : 0;
			return bStart - aStart;
		});
		return candidates[0] || null;
	}

	const previousChats = chats.filter((chat) => {
		const startedAt = chat.startedAt || new Date(0);
		return startedAt <= sentAt;
	});

	if (previousChats.length > 0) {
		previousChats.sort((a, b) => {
			const aStart = a.startedAt ? a.startedAt.getTime() : 0;
			const bStart = b.startedAt ? b.startedAt.getTime() : 0;
			return bStart - aStart;
		});
		return previousChats[0] || null;
	}

	const sorted = [...chats].sort((a, b) => {
		const aStart = a.startedAt ? a.startedAt.getTime() : 0;
		const bStart = b.startedAt ? b.startedAt.getTime() : 0;
		return bStart - aStart;
	});

	return sorted[0] || null;
}

async function loadContactMap(instance: string): Promise<ContactMap> {
	const contacts = await prismaService.wppContact.findMany({
		where: { instance },
		select: { id: true, phone: true }
	});

	const map: ContactMap = new Map();
	for (const contact of contacts) {
		map.set(normalizeDigits(contact.phone), contact.id);
	}
	return map;
}

async function getChatById(chatById: ChatByIdMap, chatId: number): Promise<WppChat | null> {
	const cached = chatById.get(chatId);
	if (cached) {
		return cached;
	}

	const chat = await prismaService.wppChat.findUnique({ where: { id: chatId } });
	if (chat) {
		chatById.set(chatId, chat);
	}
	return chat;
}

async function getChatTimeline(cache: ChatTimelineCache, instance: string, contactId: number): Promise<WppChat[]> {
	const cacheKey = `${instance}:${contactId}`;
	const cached = cache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const chats = await prismaService.wppChat.findMany({
		where: { instance, contactId },
		orderBy: [{ startedAt: "asc" }, { id: "asc" }]
	});

	cache.set(cacheKey, chats);
	return chats;
}

async function resolveMissingRelations(
	message: MessageCandidate,
	contactMap: ContactMap,
	chatById: ChatByIdMap,
	chatTimelineCache: ChatTimelineCache
): Promise<{ contactId: number | null; chatId: number | null }> {
	let contactId = message.contactId;
	let chatId = message.chatId;

	if (!contactId && chatId) {
		const chat = await getChatById(chatById, chatId);
		if (chat?.contactId) {
			contactId = chat.contactId;
		}
	}

	if (!contactId) {
		const phoneCandidate = extractPhoneCandidate(message);
		if (phoneCandidate) {
			const variants = buildPhoneVariants(phoneCandidate);
			for (const variant of variants) {
				const foundContactId = contactMap.get(variant);
				if (foundContactId) {
					contactId = foundContactId;
					break;
				}
			}
		}
	}

	if (!chatId && contactId) {
		const chats = await getChatTimeline(chatTimelineCache, message.instance, contactId);
		const bestChat = findBestChatForDate(chats, message.sentAt);
		chatId = bestChat?.id || null;
	}

	if (!contactId && chatId) {
		const chat = await getChatById(chatById, chatId);
		if (chat?.contactId) {
			contactId = chat.contactId;
		}
	}

	return { contactId: contactId || null, chatId: chatId || null };
}

async function fixMessagesForInstance(instance: string, options: ResolvedFixOptions): Promise<FixStats> {
	Logger.info(
		`[fix-messages-chat-contact] Iniciando instância ${instance} (dryRun=${options.dryRun}, sentAt>=${MIN_SENT_AT.toISOString()})`
	);

	const stats: FixStats = {
		processed: 0,
		fixed: 0,
		skipped: 0,
		failed: 0
	};

	const contactMap = await loadContactMap(instance);
	const chatById: ChatByIdMap = new Map();
	const chatTimelineCache: ChatTimelineCache = new Map();

	let lastId = 0;
	let remaining = options.limit;

	while (remaining > 0) {
		const take = Math.min(options.batchSize, remaining);
		const messages = await prismaService.wppMessage.findMany({
			where: {
				instance,
				id: { gt: lastId },
				sentAt: { gte: MIN_SENT_AT },
				OR: [{ chatId: null }, { contactId: null }]
			},
			select: {
				id: true,
				instance: true,
				from: true,
				to: true,
				sentAt: true,
				contactId: true,
				chatId: true
			},
			orderBy: { id: "asc" },
			take
		});

		if (!messages.length) {
			break;
		}

		for (const message of messages) {
			stats.processed++;
			lastId = message.id;
			remaining--;

			try {
				const resolved = await resolveMissingRelations(message, contactMap, chatById, chatTimelineCache);
				const shouldUpdateContact = !message.contactId && !!resolved.contactId;
				const shouldUpdateChat = !message.chatId && !!resolved.chatId;

				if (!shouldUpdateContact && !shouldUpdateChat) {
					stats.skipped++;
					continue;
				}

				if (options.dryRun) {
					Logger.info(
						`[fix-messages-chat-contact][dry-run] message=${message.id} instance=${instance} contactId:${message.contactId}=>${resolved.contactId} chatId:${message.chatId}=>${resolved.chatId}`
					);
					stats.fixed++;
					continue;
				}

				const updatePayload: Partial<WppMessage> = {};
				if (shouldUpdateContact && resolved.contactId) {
					updatePayload.contactId = resolved.contactId;
				}
				if (shouldUpdateChat && resolved.chatId) {
					updatePayload.chatId = resolved.chatId;
				}

				await prismaService.wppMessage.update({
					where: { id: message.id },
					data: updatePayload
				});

				stats.fixed++;
			} catch (err: any) {
				stats.failed++;
				Logger.error(
					`[fix-messages-chat-contact] Erro ao processar message=${message.id} instance=${instance}: ${String(err?.message || err)}`
				);
			}

			if (stats.processed % 500 === 0) {
				Logger.info(
					`[fix-messages-chat-contact] Progresso ${instance}: processadas=${stats.processed}, corrigidas=${stats.fixed}, puladas=${stats.skipped}, falhas=${stats.failed}`
				);
			}
		}
	}

	Logger.info(
		`[fix-messages-chat-contact] Instância ${instance} finalizada. Processadas=${stats.processed}, Corrigidas=${stats.fixed}, Puladas=${stats.skipped}, Falhas=${stats.failed}`
	);

	return stats;
}

export async function fixMessagesMissingChatAndContact(opts?: FixOptions) {
 	const options: ResolvedFixOptions = {
		...(opts?.instance ? { instance: opts.instance } : {}),
		dryRun: opts?.dryRun ?? true,
		batchSize: opts?.batchSize ?? 500,
		limit: opts?.limit ?? Number.MAX_SAFE_INTEGER
	};

	const instances = options.instance
		? [options.instance]
		: (
			await prismaService.wppMessage.findMany({
				where: {
					sentAt: { gte: MIN_SENT_AT },
					OR: [{ chatId: null }, { contactId: null }]
				},
				select: { instance: true },
				distinct: ["instance"]
			})
		).map((item) => item.instance);

	if (!instances.length) {
		Logger.info("[fix-messages-chat-contact] Nenhuma instância com mensagens órfãs encontrada.");
		return;
	}

	const globalStats: Record<string, FixStats> = {};

	for (const instance of instances) {
		globalStats[instance] = await fixMessagesForInstance(instance, options);
	}

	Logger.info("[fix-messages-chat-contact] Resumo final:");
	for (const [instance, stats] of Object.entries(globalStats)) {
		Logger.info(
			`- ${instance}: processadas=${stats.processed}, corrigidas=${stats.fixed}, puladas=${stats.skipped}, falhas=${stats.failed}`
		);
	}
}

async function runFromCLI() {
	const args = process.argv.slice(2);

	let instance: string | undefined;
	let dryRun = true;
	let batchSize = 500;
	let limit = Number.MAX_SAFE_INTEGER;

	for (const arg of args) {
		if (arg.startsWith("--instance=")) {
			instance = arg.split("=")[1];
		}
		if (arg === "--apply") {
			dryRun = false;
		}
		if (arg.startsWith("--batchSize=")) {
			const value = Number(arg.split("=")[1]);
			if (Number.isFinite(value) && value > 0) {
				batchSize = Math.floor(value);
			}
		}
		if (arg.startsWith("--limit=")) {
			const value = Number(arg.split("=")[1]);
			if (Number.isFinite(value) && value > 0) {
				limit = Math.floor(value);
			}
		}
	}

	Logger.info(
		`[fix-messages-chat-contact] Execução iniciada com parâmetros: instance=${instance || "ALL"}, dryRun=${dryRun}, batchSize=${batchSize}, limit=${limit}`
	);

	const cliOptions: FixOptions = {
		...(instance ? { instance } : {}),
		dryRun,
		batchSize,
		limit
	};

	await fixMessagesMissingChatAndContact(cliOptions);
}

if (require.main === module) {
	runFromCLI()
		.then(() => process.exit(0))
		.catch((err) => {
			Logger.error("[fix-messages-chat-contact] Falha fatal:", err);
			process.exit(1);
		});
}

export default fixMessagesMissingChatAndContact;
