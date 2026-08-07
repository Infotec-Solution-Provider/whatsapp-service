import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import prismaService from "./prisma.service";
import normalizeInternalWhatsappSenderName from "./normalize-internal-whatsapp-sender-name";
import {
	InternalWhatsappSenderListInput,
	InternalWhatsappSenderMessagesInput
} from "../types/internal-whatsapp-sender.types";
import { SessionData } from "../sdk-local";

class InternalWhatsappSendersService {
	public async register(instance: string, senderId: string, candidateName: string | null) {
		const normalizedSenderId = senderId.trim().slice(0, 191);
		const normalizedName = normalizeInternalWhatsappSenderName(normalizedSenderId, candidateName);

		if (!normalizedSenderId) {
			throw new BadRequestError("O ID do remetente do WhatsApp é obrigatório.");
		}

		const sender = await prismaService.internalWhatsappSender.upsert({
			where: { instance_senderId: { instance, senderId: normalizedSenderId } },
			create: {
				instance,
				senderId: normalizedSenderId,
				displayName: normalizedName
			},
			update: {}
		});

		if (!sender.displayName && !sender.isManuallyNamed && normalizedName) {
			await prismaService.internalWhatsappSender.updateMany({
				where: {
					id: sender.id,
					displayName: null,
					isManuallyNamed: false
				},
				data: { displayName: normalizedName }
			});

			return { ...sender, displayName: normalizedName };
		}

		return sender;
	}

	public async listUnidentified(instance: string, input: InternalWhatsappSenderListInput) {
		const where = {
			instance,
			displayName: null,
			messages: { some: {} },
			...(input.search ? { senderId: { contains: input.search } } : {})
		};

		const [total, senders] = await prismaService.$transaction([
			prismaService.internalWhatsappSender.count({ where }),
			prismaService.internalWhatsappSender.findMany({
				where,
				orderBy: [{ messages: { _count: "desc" } }, { updatedAt: "desc" }],
				skip: (input.page - 1) * input.perPage,
				take: input.perPage,
				select: {
					senderId: true,
					createdAt: true,
					updatedAt: true,
					_count: { select: { messages: true } },
					messages: {
						orderBy: { id: "desc" },
						take: 1,
						select: {
							id: true,
							body: true,
							timestamp: true,
							type: true,
							chat: { select: { id: true, groupName: true, wppGroupId: true } }
						}
					}
				}
			})
		]);

		return {
			items: senders.map(({ _count, messages, ...sender }) => ({
				...sender,
				messageCount: _count.messages,
				lastMessage: messages[0] ?? null
			})),
			page: input.page,
			perPage: input.perPage,
			total,
			totalPages: Math.ceil(total / input.perPage)
		};
	}

	public async listNames(session: SessionData) {
		return prismaService.internalWhatsappSender.findMany({
			where: {
				instance: session.instance,
				displayName: { not: null },
				...(session.role === "ADMIN"
					? {}
					: {
							messages: {
								some: { chat: { participants: { some: { userId: session.userId } } } }
							}
						})
			},
			orderBy: { displayName: "asc" },
			select: { senderId: true, displayName: true }
		});
	}

	public async listMessages(instance: string, input: InternalWhatsappSenderMessagesInput) {
		const sender = await this.getBySenderId(instance, input.senderId);
		const messages = await prismaService.internalMessage.findMany({
			where: {
				whatsappSenderId: sender.id,
				...(input.beforeId ? { id: { lt: input.beforeId } } : {})
			},
			orderBy: { id: "desc" },
			take: input.limit + 1,
			select: {
				id: true,
				body: true,
				timestamp: true,
				type: true,
				fileName: true,
				chat: { select: { id: true, groupName: true, wppGroupId: true } }
			}
		});
		const hasMore = messages.length > input.limit;
		const pageMessages = hasMore ? messages.slice(0, input.limit) : messages;

		return {
			messages: pageMessages,
			nextCursor: hasMore ? (pageMessages[pageMessages.length - 1]?.id ?? null) : null
		};
	}

	public async assignName(instance: string, senderId: string, displayName: string, assignedBy: number) {
		const normalizedName = displayName.trim();

		if (normalizedName.length < 2 || normalizedName.length > 120) {
			throw new BadRequestError("O nome deve conter entre 2 e 120 caracteres.");
		}

		const sender = await this.getBySenderId(instance, senderId);

		return prismaService.internalWhatsappSender.update({
			where: { id: sender.id },
			data: {
				displayName: normalizedName,
				isManuallyNamed: true,
				assignedBy
			},
			select: { senderId: true, displayName: true }
		});
	}

	private async getBySenderId(instance: string, senderId: string) {
		const sender = await prismaService.internalWhatsappSender.findUnique({
			where: { instance_senderId: { instance, senderId } }
		});

		if (!sender) {
			throw new NotFoundError("Remetente do WhatsApp não encontrado.");
		}

		return sender;
	}
}

export default new InternalWhatsappSendersService();
