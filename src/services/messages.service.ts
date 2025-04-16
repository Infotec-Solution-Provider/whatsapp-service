import { WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";
import { SessionData } from "@in.pulse-crm/sdk";
import { NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";

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
