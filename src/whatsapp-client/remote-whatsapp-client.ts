import { File, SocketEventType, SocketServerAdminRoom, SocketServerChatRoom } from "@in.pulse-crm/sdk";
import { TemplateMessage } from "../adapters/template.adapter";
import CreateMessageDto from "../dtos/create-message.dto";
import messageQueueService from "../services/message-queue.service";
import messagesService from "../services/messages.service";
import prismaService from "../services/prisma.service";
import contactsService from "../services/contacts.service";
import MessageDto from "../types/remote-client.types";
import { EditMessageOptions, Mentions, SendFileType, SendMessageOptions, SendTemplateOptions, WhatsappGroup } from "../types/whatsapp-instance.types";
import ProcessingLogger from "../utils/processing-logger";
import WhatsappClient from "./whatsapp-client";
import socketService from "../services/socket.service";
import { WppMessageStatus } from "@prisma/client";
import { Logger } from "@in.pulse-crm/utils";
import axios from "axios";

interface BaseSendMessageOptions {
	to: string;
	quotedId?: string | null;
	mentions?: Mentions;
	isGroup?: boolean;
}

export interface SendFileOptions extends BaseSendMessageOptions {
	text: string;
	sendAsAudio?: boolean;
	sendAsDocument?: boolean;
	fileUrl?: string;
	fileName?: string;
	fileType?: SendFileType;
	file?: File;
}

export interface SendTextOptions extends BaseSendMessageOptions {
	text: string;
}

export type RemoteSendMessageOptions = SendTextOptions | SendFileOptions;

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
				process.log("Group message ignored: internal chats are now native and no longer synced from WhatsApp groups.");
				process.success({ ignored: true, reason: "native-internal-chat" });
			} else {
				const identity = message.sender ?? null;
				const normalizedWhatsappId = identity?.lid || message.from;
				const normalizedPhone = identity?.phone || null;

				let resolvedContactId: number | null = null;
				if (!message.from.startsWith("me:")) {
					const contact = await contactsService.getOrCreateContact(
						this.instance,
						message.contactName || message.authorName || normalizedPhone || normalizedWhatsappId,
						normalizedPhone,
						normalizedWhatsappId
					);
					resolvedContactId = contact.id;
				}

				const { isGroup, groupId, authorName, contactName, sender, recipient, participant, ...cleanMessage } = message;
				const savedMsg = await messagesService.insertMessage({
					...cleanMessage,
					contactId: resolvedContactId
				});

				// Enfileira a mensagem para processamento
				await messageQueueService.enqueue({
					instance: this.instance,
					clientId: this.id,
					messageId: savedMsg.id,
					contactPhone: normalizedWhatsappId,
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
			const currentMessage = await prismaService.wppMessage.findUniqueOrThrow({
				where: {
					wwebjsIdStanza: messageId
				}
			});

			const message = await messagesService.updateMessage(currentMessage.id, {
				status: status as WppMessageStatus
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

	private getSendFileType(props: SendMessageOptions): SendFileType {
		if ("file" in props && props.file) {
			const mimeType = props.file.mime_type;
			if (mimeType.startsWith("image/") && !props.sendAsDocument) {
				return "image";
			} else if (mimeType.startsWith("video/") && !props.sendAsDocument) {
				return "video";
			} else if (mimeType.startsWith("audio/") && !props.sendAsAudio) {
				return "audio";
			} else {
				return "document";
			}
		}
		// Default to document if file is present but type is undetermined
		return "document";
	}


	public async sendMessage(props: SendMessageOptions, isGroup: boolean): Promise<CreateMessageDto> {
		const id = `send-msg-${Date.now()}`;
		const process = new ProcessingLogger(this.instance, "rc-send-message", id, props);

		try {
			process.log("Sending message via wwebjs-api");

			const options: RemoteSendMessageOptions = {
				text: props.text || "",
				to: props.to,
				quotedId: props.quotedId || null,
				isGroup,
				...(props.mentions ? { mentions: props.mentions } : {}),
				...("file" in props && props.file ? {
					file: props.file,
					fileName: props.file.name,
					fileType: this.getSendFileType(props),
					fileUrl: props.publicFileUrl,
				} : {})
			}

			console.log(`URL: ${this.clientUrl}/api/send-message`, options);
			const response = await axios.post<MessageDto>(`${this.clientUrl}/api/send-message`, options);

			if (!response.data) {
				throw new Error("No response from send-message endpoint");
			}

			const { isGroup: _ignore, groupId, authorName, ...messageData } = response.data;

			process.log("Message sent successfully from wwebjs-api");

			process.success(response.data);


			return messageData;
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

			const currentMessage = await prismaService.wppMessage.findUniqueOrThrow({
				where: {
					wwebjsIdStanza: props.messageId
				}
			});

			await messagesService.updateMessage(currentMessage.id, {
				body: props.text || response.data.body,
				status: "SENT" as WppMessageStatus
			});

			process.success("Message edited successfully");
		} catch (err: any) {
			process.log(`Failed to edit message: ${err?.message}`);
			process.failed(err);
			throw err;
		}
	}

	public async getGroups(): Promise<WhatsappGroup[]> {
		try {
			const response = await axios.get<WhatsappGroup[]>(`${this.clientUrl}/api/groups`);
			return response.data || [];
		} catch (err: any) {
			Logger.error(`RemoteWhatsappClient.getGroups failed: ${err?.message}`);
			return [];
		}
	}

	public async getTemplates(): Promise<TemplateMessage[]> {
		return [];
	}

	public async sendTemplate(props: SendTemplateOptions, chatId: number, contactId: number): Promise<CreateMessageDto> {
		Logger.debug("RemoteWhatsappClient.sendTemplate not implemented", { props, chatId, contactId });
		throw new Error("Method not implemented.");
	}

	public async forwardMessage(to: string, messageId: string, isGroup: boolean): Promise<void> {
		const process = new ProcessingLogger(this.instance, "rc-forward-message", messageId, {
			to,
			messageId,
			isGroup
		});

		try {
			process.log("Buscando mensagem original para encaminhamento");

			const originalMessage = await prismaService.wppMessage.findFirst({
				where: {
					OR: [
						{ wwebjsIdStanza: messageId },
						{ wwebjsId: messageId },
						{ wabaId: messageId },
						{ gupshupId: messageId }
					]
				}
			});

			if (!originalMessage) {
				throw new Error(`Mensagem não encontrada para forward: ${messageId}`);
			}

			try {
				process.log("Tentando encaminhamento nativo no wwebjs-api");
				await axios.post(`${this.clientUrl}/api/send-forwarded-message`, {
					to,
					sourceMessageId: messageId,
					isGroup
				});
				process.success("Mensagem encaminhada com marcador nativo");
				return;
			} catch (nativeForwardErr: any) {
				process.log(`Falha no encaminhamento nativo, aplicando fallback: ${nativeForwardErr?.message}`);
			}

			process.log("Mensagem original encontrada", {
				id: originalMessage.id,
				type: originalMessage.type,
				hasFile: !!originalMessage.fileId
			});

			const forwardedText = originalMessage.body?.trim()
				? `${originalMessage.body} (encaminhada)`
				: "(encaminhada)";

			const options: RemoteSendMessageOptions = {
				to,
				text: forwardedText,
				quotedId: null,
				isGroup,
			};

			process.log("Enviando mensagem encaminhada para o endpoint remoto", options);
			await axios.post(`${this.clientUrl}/api/send-message`, options);
			process.success("Mensagem encaminhada com fallback de envio normal");
		} catch (err: any) {
			process.log(`Failed to forward message: ${err?.message}`);
			process.failed(err);
			throw err;
		}
	}
}

export default RemoteWhatsappClient;
