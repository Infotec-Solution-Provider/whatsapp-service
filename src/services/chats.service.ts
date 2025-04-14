import { WppChat, WppContact } from "@prisma/client";
import prismaService from "./prisma.service";
import { SessionData } from "@in.pulse-crm/sdk";

class ChatsService {
	public async getChatForContact(
		sectorId: number,
		contact: WppContact
	): Promise<WppChat | null> {
		return await prismaService.wppChat.findFirst({
			where: {
				instanceName: contact.instanceName,
				phone: contact.phone,
				sectorId: sectorId
			}
		});
	}

	public async getUserChats(session: SessionData) {
		const chats = await prismaService.wppChat.findMany({
			where: {
				userId: session.userId,
				wallet: {
					WppWalletUser: {
						some: {
							userId: session.userId
						}
					}
				}
			}
		});

		if (session.role === "ADMIN") {
			const adminChats = await prismaService.wppChat.findMany({
				where: {
					userId: -1,
					sectorId: session.sectorId
				}
			});

			chats.push(...adminChats);
		}

		return chats;
	}

	public async getChatById(id: number) {
		return await prismaService.wppChat.findUnique({
			where: { id }
		});
	}
}

export default new ChatsService();
