import { SocketEventType, SocketServerAdminRoom, SocketServerChatRoom } from "@in.pulse-crm/sdk";
import { TemplateMessage } from "../adapters/template.adapter";
import CreateMessageDto from "../dtos/create-message.dto";
import internalChatsService from "../services/internal-chats.service";
import messageQueueService from "../services/message-queue.service";
import messagesService from "../services/messages.service";
import prismaService from "../services/prisma.service";
import MessageDto from "../types/remote-client.types";
import { EditMessageOptions, SendMessageOptions, SendTemplateOptions } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappClient from "./whatsapp-client";
import socketService from "../services/socket.service";
import { WppMessageStatus } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import axios from "axios";

class RemoteWhatsappClient implements WhatsappClient {
	constructor(
		public readonly id: number,
		public readonly instance: string,
		public readonly name: string,
		public _phone: string,
		private readonly clientUrl: string
	) { }

	public async handleQr(qr: string) {
		const client = await prismaService.wppClient.findUnique({
			where: {
				id: this.id
			},
			include: {
				sectors: true
			}
		});

		if (client) {
			prismaService.wppClient.update({
				data: {
					phone: null
				},
				where: {
					id: this.id
				}
			});
			client.sectors.forEach((sector) => {
				const room: SocketServerAdminRoom = `${this.instance}:${sector.id}:admin`;

				socketService.emit(SocketEventType.WwebjsQr, room, {
					qr,
					phone: this.name
				});
			});
		}
	}

	get phone(): string {
		return this._phone;
	}

	public async handleAuthSuccess(phoneNumber: string) {
		const client = await prismaService.wppClient.update({
			data: {
				phone: phoneNumber
			},
			where: {
				id: this.id
			},
			select: {
				sectors: true
			}
		});

		this._phone = phoneNumber;

		if (client) {
			client.sectors.forEach((sector) => {
				const room: SocketServerAdminRoom = `${this.instance}:${sector.id}:admin`;

				socketService.emit(SocketEventType.WwebjsAuth, room, {
					phone: this.name,
					success: true
				});
			});
		}
	}

	public async handleMessageReceived(message: MessageDto) {
		const id = message.wwebjsIdStanza || message.wwebjsId || Date.now().toString();
		const process = new ProcessingLogger(this.instance, "rc-message-receive", id, message);

		try {
			process.log("Handling message received");

			if (message.isGroup && message.groupId) {
				process.log("Message is from a group, processing in internalChatsService");
				const savedMsg = await internalChatsService.receiveMessage(
					message.groupId,
					message,
					message.contactName
				);
				process.log("Message received handled successfully");
				process.success(savedMsg);
			} else {
				const savedMsg = await messagesService.insertMessage(message);

				// Enfileira a mensagem para processamento
				await messageQueueService.enqueue({
					instance: this.instance,
					clientId: this.id,
					messageId: savedMsg.id,
					contactPhone: savedMsg.from,
					contactName: message.contactName
				});

				process.log("Message enqueued successfully");
				process.success(savedMsg);
			}
		} catch (err: any) {
			process.log(`Failed to handle message received: ${err?.message}`);
			process.failed(err);
		}
	}

	public async handleMessageStatus(messageId: string, status: string) {
		try {
			const message = await prismaService.wppMessage.update({
				where: {
					wwebjsIdStanza: messageId
				},
				data: {
					status: status as WppMessageStatus
				}
			});

			if (message.chatId === null) {
				return;
			}

			const chatRoom: SocketServerChatRoom = `${message.instance}:chat:${message.chatId}`;
			socketService.emit(SocketEventType.WppMessageStatus, chatRoom, {
				messageId: message.id,
				contactId: message.contactId!,
				status: status as WppMessageStatus
			});
		} catch (err) {
			console.log("Não foi possível atualizar a mensagem de id: " + messageId);
		}
	}

	public async getProfilePictureUrl(phone: string): Promise<string | null> {
		Logger.debug(`Can't get profile picture url from Remote Whatsapp Client for phone ${phone}`);
		return null;
	}

	public async isValidWhatsapp(phone: string): Promise<boolean> {
		Logger.debug(`Can't validate whatsapp number from Remote Whatsapp Client for phone ${phone}`);
		return false;
	}

	public async sendMessage(props: SendMessageOptions): Promise<CreateMessageDto> {
		const id = `send-msg-${Date.now()}`;
		const process = new ProcessingLogger(this.instance, "rc-send-message", id, props);

		try {
			process.log("Sending message via wwebjs-api");

			if ("fileUrl" in props && props.fileUrl) {
				props.fileUrl = props.fileUrl.replace("http://localhost:8003", "https://inpulse.infotecrs.inf.br")
			}

			const response = await axios.post<CreateMessageDto>(`${this.clientUrl}/api/send-message`, props);

			if (!response.data) {
				throw new Error("No response from send-message endpoint");
			}

			process.log("Message sent successfully from wwebjs-api");

			process.success(response.data);
			return response.data;
		} catch (err: any) {
			process.log(`Failed to send message: ${err?.message}`);
			process.failed(err);
			throw err;
		}
	}

	public async editMessage(props: EditMessageOptions): Promise<void> {
		const id = `edit-msg-${Date.now()}`;
		const process = new ProcessingLogger(this.instance, "rc-edit-message", id, props);

		try {
			process.log("Editing message via wwebjs-api");

			const response = await axios.post(`${this.clientUrl}/api/edit-message`, props);

			if (!response.data) {
				throw new Error("No response from edit-message endpoint");
			}

			process.log("Message edited successfully from wwebjs-api");

			// Update message status in database
			await prismaService.wppMessage.update({
				where: {
					wwebjsIdStanza: props.messageId
				},
				data: {
					body: props.text || response.data.body,
					status: "SENT" as WppMessageStatus
				}
			});

			process.success("Message edited successfully");
		} catch (err: any) {
			process.log(`Failed to edit message: ${err?.message}`);
			process.failed(err);
			throw err;
		}
	}

	public getTemplates(): Promise<TemplateMessage[]> {
		throw new Error("Method not implemented.");
	}

	public sendTemplate(props: SendTemplateOptions, chatId: number, contactId: number): Promise<CreateMessageDto> {
		Logger.debug("RemoteWhatsappClient.sendTemplate not implemented", { props, chatId, contactId });
		throw new Error("Method not implemented.");
	}
	
	public forwardMessage(to: string, messageId: string, isGroup: boolean): Promise<void> {
		Logger.debug("RemoteWhatsappClient.forwardMessage not implemented", { to, messageId, isGroup });
		throw new Error("Method not implemented.");
	}
}

export default RemoteWhatsappClient;
