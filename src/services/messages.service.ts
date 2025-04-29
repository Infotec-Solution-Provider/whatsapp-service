import { WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import {
	SessionData,
	SocketEventType,
	SocketServerChatRoom
} from "@in.pulse-crm/sdk";
import { NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import socketService from "./socket.service";

class MessagesService {
	public async insertMessage(data: CreateMessageDto) {
		return await prismaService.wppMessage.create({ data });
	}

	public async updateMessage(id: number, data: Partial<WppMessage>) {
		return await prismaService.wppMessage.update({
			where: { id },
			data
		});
	}

	public async markContactMessagesAsRead(
		instance: string,
		contactId: number
	) {
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
				WppChat: {
					instance,
					contactId
				}
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
			throw new UnauthorizedError(
				"This message does not belong to your instance!"
			);
		}

		return message;
	}
}

export default new MessagesService();
