import { WppMessage } from "@prisma/client";
import prismaService from "./prisma.service";

class MessagesService {
	public async insertMessage(data: WppMessage) {
		return await prismaService.wppMessage.create({ data });
	}

	public async updateMessage(id: string, data: Partial<WppMessage>) {
		return await prismaService.wppMessage.update({
			where: { id },
			data
		});
	}
}

export default new MessagesService();
