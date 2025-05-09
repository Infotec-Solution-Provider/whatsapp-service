import {
	WppChat,
	WppContact,
	WppMessage,
	WppMessageStatus,
	WppSector
} from "@prisma/client";
import MessageFlow from "../message-flow/message-flow";
import MessageFlowFactory from "../message-flow/message-flow.factory";
import prismaService from "./prisma.service";
import contactsService from "./contacts.service";
import { Formatter, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import ProcessingLogger from "../utils/processing-logger";
import socketService from "./socket.service";
import {
	SocketEventType,
	SocketServerAdminRoom,
	SocketServerChatRoom,
	SocketServerMonitorRoom,
	SocketServerUserRoom,
	SocketServerWalletRoom,
	User,
	WppMessageEventData
} from "@in.pulse-crm/sdk";
import chatsService from "./chats.service";
import messagesService from "./messages.service";
import whatsappService from "./whatsapp.service";
import chooseSectorBot from "../bots/choose-sector.bot";

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

	private async getSectors(clientId: number) {
		const sectors = await prismaService.wppSector.findMany({
			where: {
				wppInstanceId: clientId,
				receiveChats: true
			}
		});

		if (!sectors || sectors.length === 0) {
			throw new Error("Setor não encontrado para esta instância.");
		}

		return sectors;
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
			logger.log("Buscando contato para a mensagem.");
			const contact = await contactsService.getOrCreateContact(
				instance,
				Formatter.phone(msg.from),
				msg.from
			);
			logger.log("Contato encontrado!", contact);

			logger.log("Buscando chat para o contato.");
			const currChat = await chatsService.getChatForContact(
				clientId,
				contact
			);

			if (currChat) {
				logger.log(
					"Chat anterior encontrado para o contato.",
					currChat
				);
				await this.insertAndNotify(logger, currChat, msg);

				console.log("foi1");
				if (currChat.botId === 1) {
					await chooseSectorBot.processMessage(
						currChat,
						contact,
						msg
					);
				}
				return;
			}

			let newChat: WppChat | null = null;

			logger.log("Nenhum chat encontrado para o contato.");

			const sectors = await this.getSectors(clientId);
			if (sectors.length > 1) {
				logger.log(
					"Mais de um setor encontrado, iniciando o fluxo de escolha de setor."
				);
				newChat = await prismaService.wppChat.create({
					data: {
						instance,
						type: "RECEPTIVE",
						contactId: contact.id,
						sectorId: sectors[0]!.id,
						botId: 1
					}
				});
			} else {
				logger.log(
					"Um setor encontrado, iniciando o fluxo de atendimento."
				);
				const flow = await this.getFlow(instance, sectors[0]!.id);
				const data = await flow.getChatPayload(logger, contact);

				newChat = await prismaService.wppChat.create({ data });
			}

			if (!newChat) {
				throw new Error("Nenhum chat foi criado.");
			}

			if (newChat.botId === 1) {
				await chooseSectorBot.processMessage(newChat, contact, msg);
			}

			logger.log("Novo chat encontrado!", newChat);

			logger.log("Buscando foto de perfil do cliente.");
			const avatarUrl = await whatsappService.getProfilePictureUrl(
				instance,
				msg.from
			);
			if (avatarUrl) {
				await prismaService.wppChat.update({
					data: { avatarUrl },
					where: { id: newChat.id }
				});
			}

			await this.addSystemMessage(
				newChat,
				"Atendimento iniciado pelo cliente!",
				true
			);
			logger.log("Chat criado com sucesso!", newChat);

			await this.insertAndNotify(logger, newChat, msg, true);
		} catch (err) {
			console.error(err);
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
	}

	public async transferChatSector(
		sector: WppSector,
		contact: WppContact,
		chat: WppChat
	) {
		const logger = new ProcessingLogger(
			sector.instance,
			"transfer-chat-sector",
			`WppChat-${chat.id}_${Date.now()}`,
			{ sector, contact, chat }
		);

		try {
			const flow = await this.getFlow(sector.instance, sector.id);
			const data = await flow.getChatPayload(logger, contact);
			const updatedChat = await prismaService.wppChat.update({
				where: { id: chat.id },
				data: { ...data, botId: null }
			});

			await this.addSystemMessage(
				updatedChat,
				`Transferido para o setor ${sector.name}!`
			);

			await this.notifyChatStarted(logger, updatedChat);
			logger.success(updatedChat);
		} catch (err) {
			console.error(err);
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
	}
	public async transferChatOperator(
		sector: WppSector,
		operador: User,
		contact: WppContact,
		chat: WppChat
	) {
		const logger = new ProcessingLogger(
			sector.instance,
			"transfer-chat-operator",
			`WppChat-${chat.id}_${Date.now()}`,
			{ sector, contact, chat }
		);

		try {
			const flow = await this.getFlow(sector.instance, sector.id);
			 await flow.getChatPayload(logger, contact);

			const updatedChat = await prismaService.wppChat.update({
				where: { id: chat.id },
				data: {
					userId:operador.CODIGO,
					botId: null
				}
			});

			await this.addSystemMessage(
				updatedChat,
				`Transferido para o operador ${operador.NOME}!`
			);

			await this.notifyChatStarted(logger, updatedChat);
			logger.success(updatedChat);
		} catch (err) {
			console.error(err);
			logger.log(`Erro ao processar mensagem!`);
			logger.failed(err);
		}
	}
	public async notifyChatStarted(process: ProcessingLogger, chat: WppChat) {
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

			if (message.chatId === null) {
				process.log("Mensagem não possui chatId.");
				return;
			}

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

			if (!("wwebjsId" in search) && !("wabaId" in search)) {
				return;
			}

			const message = await prismaService.wppMessage.update({
				where: search,
				data: {
					status
				}
			});
			if (message.chatId === null) {
				return;
			}

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

	public async addSystemMessage(
		chat: WppChat,
		text: string,
		notify: boolean = true
	) {
		const message = await messagesService.insertMessage({
			body: text,
			from: "system",
			to: "system",
			instance: chat.instance,
			status: "RECEIVED",
			timestamp: Date.now().toString(),
			type: "chat",
			chatId: chat.id,
			contactId: chat.contactId
		});

		if (notify) {
			const chatRoom: SocketServerChatRoom = `${chat.instance}:chat:${chat.id}`;
			socketService.emit(SocketEventType.WppMessage, chatRoom, {
				message
			});
		}
	}
}

export default new MessagesDistributionService();
