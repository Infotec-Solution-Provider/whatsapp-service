import { SessionData, SocketEventType, SocketServerChatRoom } from "@in.pulse-crm/sdk";
import { WppMessage } from "@prisma/client";
import { NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import { Mentions } from "../types/whatsapp-instance.types";
import whatsappService from "./whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";

interface FetchMessagesFilter {
	minDate: string;
	maxDate: string;
	userId?: number | null;
}

interface EditMessageOptions {
	messageId: number;
	text: string;
	mentions?: Mentions;
}

class MessagesService {
	public async insertMessage(data: CreateMessageDto) {
		return await prismaService.wppMessage.create({ data });
	}

	public async updateMessage(id: number, data: Partial<WppMessage>) {
		return await prismaService.wppMessage.update({
			where: { id },
			data,
			include: {
				WppChat: true
			}
		});
	}

	public async markContactMessagesAsRead(instance: string, contactId: number) {
		await prismaService.wppMessage.updateMany({
			where: {
				OR: [
					{
						to: {
							startsWith: "me:"
						}
					},
					{
						to: "system"
					}
				],
				contactId
			},
			data: {
				status: "READ"
			}
		});

		const chat = await prismaService.wppChat.findFirst({
			where: {
				instance,
				contactId,
				isFinished: false
			}
		});

		if (chat) {
			const room: SocketServerChatRoom = `${instance}:chat:${chat.id}`;
			socketService.emit(SocketEventType.WppContactMessagesRead, room, {
				contactId
			});
		}
	}

	public async getMessageById(session: SessionData, id: number) {
		const message = await prismaService.wppMessage.findUnique({
			where: { id }
		});

		if (!message) {
			throw new NotFoundError("Message not found!");
		}

		if (message.instance !== session.instance) {
			throw new UnauthorizedError("This message does not belong to your instance!");
		}

		return message;
	}

	public async fetchMessages(session: SessionData, filters: FetchMessagesFilter) {
		const messages = await prismaService.wppMessage.findMany({
			where: {
				instance: session.instance,
				sentAt: {
					gte: new Date(filters.minDate),
					lte: new Date(filters.maxDate)
				},
				...(filters.userId ? { userId: Number(filters.userId) } : {})
			},
			include: {
				WppContact: true
			}
		});

		return messages;
	}

	public async editMessage({ options, session }: { options: EditMessageOptions; session: SessionData }) {
		const process = new ProcessingLogger(
			session.instance,
			"message-edit",
			`${options.messageId}_${Date.now()}`,
			options
		);

		try {
			process.log("Procurando mensagem no banco de dados...");
			const originalMessage = await prismaService.wppMessage.findUniqueOrThrow({
				where: { id: options.messageId },
				include: { WppChat: true }
			});
			process.log("Mensagem encontrada:", originalMessage);
			if (!originalMessage.wwebjsId) {
				throw new Error("Original message does not have a wwebjsId.");
			}
			await whatsappService.editMessage({
				options: {
					messageId: originalMessage.wwebjsId,
					text: options.text,
					mentions: options.mentions || null
				}, session, logger: process
			});
			process.log("Mensagem editada com sucesso.");

			const updatedMsg = await this.updateMessage(originalMessage.id, {
				body: options.text,
				isEdited: true
			});
			process.log("Mensagem atualizada no banco de dados.", updatedMsg);

			if (updatedMsg.WppChat) {
				const room: SocketServerChatRoom = `${session.instance}:chat:${updatedMsg.WppChat.id}`;
				socketService.emit(SocketEventType.WppMessageEdit, room, {
					messageId: updatedMsg.id,
					contactId: updatedMsg.contactId || 0,
					newText: updatedMsg.body
				});
				process.log("Notificação via socket enviada.", room);
			} else {
				process.log("A mensagem não pertence a um chat, pulando notificação via socket.");
			}
		} catch (err) {
			process.log("Erro ao editar a mensagem.", (err as Error).message);
			throw new Error("Failed to edit message: " + (err as Error).message);
		}
	}
}

export default new MessagesService();
