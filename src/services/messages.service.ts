import { SessionData, SocketEventType, SocketServerChatRoom } from "@in.pulse-crm/sdk";
import { WppMessage } from "@prisma/client";
import { NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import CreateMessageDto from "../dtos/create-message.dto";
import prismaService from "./prisma.service";
import socketService from "./socket.service";
import { Mentions } from "../types/whatsapp-instance.types";
import whatsappService from "./whatsapp.service";
import ProcessingLogger from "../utils/processing-logger";
import instancesService from "./instances.service";
import localSyncService from "./local-sync.service";
import { safeEncode } from "../utils/safe-encode";

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
		const message = await prismaService.wppMessage.create({ data });
		await this.syncMessageToLocal(message);
		return message;
	}

	public async updateMessage(id: number, data: Partial<WppMessage>) {
		delete data.id;

		const message = await prismaService.wppMessage.update({
			where: { id },
			data: { ...data },
			include: {
				WppChat: true
			}
		});

		await this.syncMessageToLocal(message);
		return message;
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

		try {
			await instancesService.executeQuery(
				instance,
				`UPDATE wpp_messages SET status = 'READ' WHERE contact_id = ? AND (\`to\` LIKE 'me:%' OR \`to\` = 'system')`,
				[contactId]
			);
		} catch (err: any) {
			const errMsg = String(err?.message || "");
			if (errMsg.includes("wpp_messages") && errMsg.includes("doesn't exist")) {
				try {
					await localSyncService.ensureLocalTables(instance);
					await instancesService.executeQuery(
						instance,
						`UPDATE wpp_messages SET status = 'READ' WHERE contact_id = ? AND (\`to\` LIKE 'me:%' OR \`to\` = 'system')`,
						[contactId]
					);
					return;
				} catch (retryErr) {
					console.error("[markContactMessagesAsRead] Erro ao sincronizar mensagens locais após criar tabelas:", retryErr);
					return;
				}
			}

			console.error("[markContactMessagesAsRead] Erro ao sincronizar mensagens locais:", err);
		}

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
		// Garante que a data mínima comece em 00:00:00
		const minDate = new Date(filters.minDate);
		minDate.setHours(0, 0, 0, 0);

		// Garante que a data máxima termine em 23:59:59
		const maxDate = new Date(filters.maxDate);
		maxDate.setHours(23, 59, 59, 999);

		const messages = await prismaService.wppMessage.findMany({
			where: {
				instance: session.instance,
				sentAt: {
					gte: minDate,
					lte: maxDate
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
				},
				session,
				logger: process
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

	private async syncMessageToLocal(message: WppMessage) {
		const query = `
				INSERT INTO wpp_messages (
					id, instance, wwebjs_id, wwebjs_id_stanza, waba_id, gupshup_id, gupshup_request_id,
					\`from\`, \`to\`, type, quoted_id, chat_id, contact_id, is_forwarded, is_edited,
					body, timestamp, sent_at, status, file_id, file_name, file_type, file_size,
					user_id, billing_category, client_id
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					wwebjs_id = VALUES(wwebjs_id),
					wwebjs_id_stanza = VALUES(wwebjs_id_stanza),
					waba_id = VALUES(waba_id),
					gupshup_id = VALUES(gupshup_id),
					gupshup_request_id = VALUES(gupshup_request_id),
					\`from\` = VALUES(\`from\`),
					\`to\` = VALUES(\`to\`),
					type = VALUES(type),
					quoted_id = VALUES(quoted_id),
					chat_id = VALUES(chat_id),
					contact_id = VALUES(contact_id),
					is_forwarded = VALUES(is_forwarded),
					is_edited = VALUES(is_edited),
					body = VALUES(body),
					timestamp = VALUES(timestamp),
					sent_at = VALUES(sent_at),
					status = VALUES(status),
					file_id = VALUES(file_id),
					file_name = VALUES(file_name),
					file_type = VALUES(file_type),
					file_size = VALUES(file_size),
					user_id = VALUES(user_id),
					billing_category = VALUES(billing_category),
					client_id = VALUES(client_id)
			`;

		try {
			const sentAt = this.formatDateForMySQL(message.sentAt);

			await instancesService.executeQuery(message.instance, query, [
				message.id,
				message.instance,
				message.wwebjsId,
				message.wwebjsIdStanza,
				message.wabaId,
				message.gupshupId,
				message.gupshupRequestId,
				message.from,
				message.to,
				message.type,
				message.quotedId,
				message.chatId,
				message.contactId,
				message.isForwarded ? 1 : 0,
				message.isEdited ? 1 : 0,
				message.body || "",
				message.timestamp,
				sentAt,
				message.status,
				message.fileId,
				message.fileName,
				message.fileType,
				message.fileSize,
				message.userId,
				message.billingCategory,
				message.clientId
			]);

			// Atualizar wpp_last_messages se a mensagem tiver contactId
			if (message.contactId) {
				const lastMessageQuery = `
					INSERT INTO wpp_last_messages (
						instance, contact_id, chat_id, message_id, \`from\`, \`to\`, type, body,
						timestamp, sent_at, status, file_id, file_name, file_type, file_size,
						user_id, billing_category, client_id
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON DUPLICATE KEY UPDATE
						message_id = IF(VALUES(sent_at) >= sent_at, VALUES(message_id), message_id),
						chat_id = IF(VALUES(sent_at) >= sent_at, VALUES(chat_id), chat_id),
						\`from\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`from\`), \`from\`),
						\`to\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`to\`), \`to\`),
						type = IF(VALUES(sent_at) >= sent_at, VALUES(type), type),
						body = IF(VALUES(sent_at) >= sent_at, VALUES(body), body),
						timestamp = IF(VALUES(sent_at) >= sent_at, VALUES(timestamp), timestamp),
						sent_at = IF(VALUES(sent_at) >= sent_at, VALUES(sent_at), sent_at),
						status = IF(VALUES(sent_at) >= sent_at, VALUES(status), status),
						file_id = IF(VALUES(sent_at) >= sent_at, VALUES(file_id), file_id),
						file_name = IF(VALUES(sent_at) >= sent_at, VALUES(file_name), file_name),
						file_type = IF(VALUES(sent_at) >= sent_at, VALUES(file_type), file_type),
						file_size = IF(VALUES(sent_at) >= sent_at, VALUES(file_size), file_size),
						user_id = IF(VALUES(sent_at) >= sent_at, VALUES(user_id), user_id),
						billing_category = IF(VALUES(sent_at) >= sent_at, VALUES(billing_category), billing_category),
						client_id = IF(VALUES(sent_at) >= sent_at, VALUES(client_id), client_id)
				`;

				await instancesService.executeQuery(message.instance, lastMessageQuery, [
					message.instance,
					message.contactId,
					message.chatId,
					message.id,
					message.from,
					message.to,
					message.type,
					safeEncode(message.body) || "",
					message.timestamp,
					sentAt || this.formatDateForMySQL(new Date(0)),
					message.status,
					message.fileId,
					message.fileName,
					message.fileType,
					message.fileSize,
					message.userId,
					message.billingCategory,
					message.clientId
				]);
			}
		} catch (error: any) {
			const errMsg = String(error?.message || "");
			if (errMsg.includes("wpp_messages") && errMsg.includes("doesn't exist")) {
				try {
					await localSyncService.ensureLocalTables(message.instance);
					const sentAt = this.formatDateForMySQL(message.sentAt);
					await instancesService.executeQuery(message.instance, query, [
						message.id,
						message.instance,
						message.wwebjsId,
						message.wwebjsIdStanza,
						message.wabaId,
						message.gupshupId,
						message.gupshupRequestId,
						message.from,
						message.to,
						message.type,
						message.quotedId,
						message.chatId,
						message.contactId,
						message.isForwarded ? 1 : 0,
						message.isEdited ? 1 : 0,
						safeEncode(message.body) || "",
						message.timestamp,
						sentAt,
						message.status,
						message.fileId,
						message.fileName,
						message.fileType,
						message.fileSize,
						message.userId,
						message.billingCategory,
						message.clientId
					]);

					// Atualizar wpp_last_messages após retry se tiver contactId
					if (message.contactId) {
						const lastMessageQuery = `
							INSERT INTO wpp_last_messages (
								instance, contact_id, chat_id, message_id, \`from\`, \`to\`, type, body,
								timestamp, sent_at, status, file_id, file_name, file_type, file_size,
								user_id, billing_category, client_id
							)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON DUPLICATE KEY UPDATE
								message_id = IF(VALUES(sent_at) >= sent_at, VALUES(message_id), message_id),
								chat_id = IF(VALUES(sent_at) >= sent_at, VALUES(chat_id), chat_id),
								\`from\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`from\`), \`from\`),
								\`to\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`to\`), \`to\`),
								type = IF(VALUES(sent_at) >= sent_at, VALUES(type), type),
								body = IF(VALUES(sent_at) >= sent_at, VALUES(body), body),
								timestamp = IF(VALUES(sent_at) >= sent_at, VALUES(timestamp), timestamp),
								sent_at = IF(VALUES(sent_at) >= sent_at, VALUES(sent_at), sent_at),
								status = IF(VALUES(sent_at) >= sent_at, VALUES(status), status),
								file_id = IF(VALUES(sent_at) >= sent_at, VALUES(file_id), file_id),
								file_name = IF(VALUES(sent_at) >= sent_at, VALUES(file_name), file_name),
								file_type = IF(VALUES(sent_at) >= sent_at, VALUES(file_type), file_type),
								file_size = IF(VALUES(sent_at) >= sent_at, VALUES(file_size), file_size),
								user_id = IF(VALUES(sent_at) >= sent_at, VALUES(user_id), user_id),
								billing_category = IF(VALUES(sent_at) >= sent_at, VALUES(billing_category), billing_category),
								client_id = IF(VALUES(sent_at) >= sent_at, VALUES(client_id), client_id)
						`;

						await instancesService.executeQuery(message.instance, lastMessageQuery, [
							message.instance,
							message.contactId,
							message.chatId,
							message.id,
							message.from,
							message.to,
							message.type,
							safeEncode(message.body) || "",
							message.timestamp,
							sentAt || this.formatDateForMySQL(new Date(0)),
							message.status,
							message.fileId,
							message.fileName,
							message.fileType,
							message.fileSize,
							message.userId,
							message.billingCategory,
							message.clientId
						]);
					}

					return;
				} catch (retryError) {
					console.error("[syncMessageToLocal] Erro ao sincronizar mensagem após criar tabelas:", retryError);
					return;
				}
			}

			console.error("[syncMessageToLocal] Erro ao sincronizar mensagem:", error);
		}
	}

	private formatDateForMySQL(date: Date | null | undefined): string | null {
		if (!date) return null;
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const seconds = String(date.getSeconds()).padStart(2, "0");
		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	}
}

export default new MessagesService();
