import {
	WppChat,
	WppMessage,
	WppMessageStatus,
	WppSector
} from "@prisma/client";
import MessageFlow from "../classes/message-flow/message-flow";
import MessageFlowFactory from "../classes/message-flow/message-flow.factory";
import prismaService from "./prisma.service";
import contactsService from "./contacts.service";
import { Formatter, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import ProcessingLogger from "../classes/processing-logger";
import socketService from "./socket.service";
import {
	SocketEventType,
	SocketServerAdminRoom,
	SocketServerChatRoom,
	SocketServerMonitorRoom,
	SocketServerUserRoom,
	SocketServerWalletRoom,
	WppMessageEventData
} from "@in.pulse-crm/sdk";
import chatsService from "./chats.service";

class MessagesDistributionService {
	private flows: Map<string, MessageFlow> = new Map();

	private async getFlow(
		instance: string,
		sectorId: number
	): Promise<MessageFlow> {
		const flowKey = `${instance}:${sectorId}`;
		const flow = this.flows.get(flowKey);

		if (!flow) {
			const newFlow = await MessageFlowFactory.createMessageFlow(
				instance,
				sectorId
			);

			this.flows.set(flowKey, newFlow);
			return newFlow;
		}

		return flow;
	}

	public async processMessage(
		instance: string,
		clientId: number,
		msg: WppMessage
	) {
		const logger = new ProcessingLogger(
			instance,
			"message-distribution",
			`WppMessage-${msg.id}`,
			msg
		);

		try {
			const sectors = await prismaService.wppSector.findMany({
				where: {
					wppInstanceId: clientId
				}
			});
			let sector: WppSector | null = null;

			if (!sectors || sectors.length === 0) {
				throw new Error("Setor não encontrado para esta instância.");
			}

			if (sectors.length > 1) {
				throw new Error(
					"Múltiplos setores encontrados para esta instância."
				);
			}

			sector = sectors[0]!;

			logger.log("Buscando contato para a mensagem.");
			const contact = await contactsService.getOrCreateContact(
				instance,
				Formatter.phone(msg.from),
				msg.from
			);
			logger.log("Contato encontrado!", contact);

			logger.log("Buscando chat para o contato.");
			const currChat = await chatsService.getChatForContact(
				sector.id,
				contact
			);

			if (currChat) {
				logger.log(
					"Chat anterior encontrado para o contato.",
					currChat
				);
				await this.insertAndNotify(logger, currChat, msg);
				return;
			}

			logger.log("Nenhum chat encontrado para o contato.");
			logger.log("Obtendo fluxo de mensagens para a instância e setor.");
			const flow = await this.getFlow(instance, sector.id);
			logger.log("Fluxo recuperado.", flow);

			const newChat = await flow.getChat(logger, msg, contact);
			logger.log("Chat criado com sucesso!", newChat);

			await this.insertAndNotify(logger, newChat, msg, true);
		} catch (err) {
			console.error(err);
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
	}

	private async notifyChatStarted(process: ProcessingLogger, chat: WppChat) {
		try {
			const data = { chatId: chat.id };
			const monitorRoom: SocketServerMonitorRoom = `${chat.instance}:${chat.sectorId!}:monitor`;

			await socketService.emit(
				SocketEventType.WppChatStarted,
				monitorRoom,
				data
			);

			process.log(`Chat enviado para o socket: /${monitorRoom}/ room!`);

			if (chat.walletId) {
				const walletRoom: SocketServerWalletRoom = `${chat.instance}:wallet:${chat.walletId}`;
				await socketService.emit(
					SocketEventType.WppChatStarted,
					walletRoom,
					data
				);
				process.log(
					`Chat enviado para o socket: /${walletRoom}/ room!`
				);
			}

			if (chat.userId === -1) {
				const adminRoom: SocketServerAdminRoom = `${chat.instance}:${chat.sectorId!}:admin`;
				await socketService.emit(
					SocketEventType.WppChatStarted,
					adminRoom,
					data
				);
				process.log(`Chat enviado para o socket: /${adminRoom}/ room!`);
			}

			if (chat.userId) {
				const userRoom: SocketServerUserRoom = `${chat.instance}:user:${chat.userId}`;
				await socketService.emit(
					SocketEventType.WppChatStarted,
					userRoom,
					data
				);
				process.log(`Chat enviado para o socket: /${userRoom}/ room!`);
			}
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			process.log(`Erro ao enviar o chat para o socket: ${msg}`);
			throw err;
		}
	}

	public async notifyMessage(process: ProcessingLogger, message: WppMessage) {
		try {
			process.log("Transmitindo mensagem via socket.");
			const instance = message.instance;
			const room: SocketServerChatRoom = `${instance}:chat:${message.chatId}`;
			const data: WppMessageEventData = { message };

			await socketService.emit(SocketEventType.WppMessage, room, data);
			process.log(`Mensagem transmitida para a sala: /${room}/ room!`);
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			process.log(`Falha ao transmitir mensagem: ${msg}`);
			throw err;
		}
	}

	private async insertMessageOnChat(
		logger: ProcessingLogger,
		message: WppMessage,
		chat: WppChat
	) {
		try {
			const insertedMessage = await prismaService.wppMessage.update({
				where: {
					id: message.id
				},
				data: {
					contactId: chat.contactId,
					chatId: chat.id,
					status: "RECEIVED"
				}
			});

			logger.log("Mensagem inserida no chat.", insertedMessage);
			return insertedMessage;
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			logger.log(`Erro ao inserir a mensagem no chat: ${msg}`);
			throw err;
		}
	}

	private async insertAndNotify(
		logger: ProcessingLogger,
		chat: WppChat,
		msg: WppMessage,
		isChatNew: boolean = false
	) {
		const insertedMsg = await this.insertMessageOnChat(logger, msg, chat);
		if (isChatNew) {
			await this.notifyChatStarted(logger, chat);
		}
		await this.notifyMessage(logger, insertedMsg);
		logger.success(insertedMsg);
	}

	public async processMessageStatus(
		type: "wwebjs" | "waba",
		id: string,
		status: WppMessageStatus
	) {
		try {
			const search =
				type === "wwebjs" ? { wwebjsId: id } : { wabaId: id };

			if (!("wwebjsId" in search) || !("wabaId" in search)) {
				return;
			}

			const message = await prismaService.wppMessage.update({
				where: search,
				data: {
					status
				}
			});

			const chatRoom: SocketServerChatRoom = `${message.instance}:chat:${message.chatId}`;
			socketService.emit(SocketEventType.WppMessageStatus, chatRoom, {
				messageId: message.id,
				contactId: message.contactId!,
				status
			});
		} catch (err) {
			const msg = sanitizeErrorMessage(err);
			console.error(`Erro ao processar status da mensagem: ${msg}`);
		}
	}
}

export default new MessagesDistributionService();
