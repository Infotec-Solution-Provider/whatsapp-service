import { Logger } from "@in.pulse-crm/utils";
import { Prisma } from "@prisma/client";
import type { SessionData } from "../sdk-local";
import { FileDirType } from "../sdk-local";
import type { Mentions, SendMessageOptions } from "../types/whatsapp-instance.types";
import { deliverOperatorMessage } from "../utils/operator-send-delivery";
import { resolveOperatorQuotedMessage } from "../utils/operator-quoted-message";
import { hashOperatorSendRequest, normalizeOperatorSendRequest, OperatorSendRequestError } from "../utils/operator-send-request";
import { readyMessagePipelineSource, type PipelineTriggerSource } from "../utils/pipeline-trigger-source";
import operatorOutboundService from "./operator-outbound.service";
import filesService from "./files.service";
import messagesService from "./messages.service";
import messagesDistributionService from "./messages-distribution.service";
import prismaService from "./prisma.service";
import readyMessagesService from "./ready-messages.service";
import whatsappService, { getMessageType } from "./whatsapp.service";
import { messageMentionPatch, operatorMentionEntities } from "../utils/message-mention-persistence";

interface OperatorSendPayload {
	options: SendMessageOptions;
	pipelineSource?: PipelineTriggerSource;
}

class OperatorSendService {
	configureWorker(): void {
		operatorOutboundService.setHandler({
			preflight: async (item) => {
				const client = whatsappService.getClient(item.clientId);
				return !!client && client.instance === item.instance;
			},
			deliver: async (item) => {
				const payload = item.payload as unknown as OperatorSendPayload;
				return deliverOperatorMessage(item, payload.options, whatsappService.getClient(item.clientId));
			},
			onMessage: async (message) => {
				await messagesService.syncMessageToLocal(message, true);
				await messagesDistributionService.notifyMessage(null, message);
			},
			finalize: async (tx, message, rawPayload) => {
				const { pipelineSource } = rawPayload as unknown as OperatorSendPayload;
				if (!pipelineSource) return;
				const contact = message.contactId
					? await tx.wppContact.findUnique({ where: { id: message.contactId }, select: { customerId: true } })
					: null;
				await tx.pipelineEnrollmentOutbox.upsert({
					where: { idempotencyKey: `pipeline-event:v1:${message.id}` },
					update: {},
					create: {
						idempotencyKey: `pipeline-event:v1:${message.id}`,
						instance: message.instance, messageId: message.id,
						contactId: message.contactId, customerId: contact?.customerId ?? null,
						...pipelineSource,
					},
				});
			},
		});
	}

	async lookup(session: SessionData, clientId: number, key: string) {
		const record = await operatorOutboundService.lookup({ instance: session.instance, userId: session.userId }, key);
		return record?.job.clientId === clientId ? record.message : null;
	}

	async submit(session: SessionData, clientId: number, to: unknown, data: Record<string, unknown>, key: string, file?: Express.Multer.File) {
		const request = normalizeOperatorSendRequest(clientId, to, data, file);
		const payloadHash = hashOperatorSendRequest(request);
		const scope = { instance: session.instance, userId: session.userId };
		// Replays must work even if a channel, attachment or quoted message is no
		// longer available. A key is bound to its original content and channel.
		const existing = await operatorOutboundService.lookup(scope, key);
		if (existing) {
			if (existing.job.payloadHash !== payloadHash || existing.job.clientId !== clientId) {
				throw new OperatorSendRequestError("Esta chave já pertence a outro conteúdo ou canal.", 409);
			}
			return { ...existing, created: false };
		}
		const [registeredClient, contact, chat, quoted] = await Promise.all([
			prismaService.wppClient.findFirst({ where: { id: clientId, instance: session.instance, isActive: true } }),
			prismaService.wppContact.findFirst({ where: { id: request.contactId, instance: session.instance } }),
			request.chatId ? prismaService.wppChat.findFirst({ where: { id: request.chatId, instance: session.instance } }) : null,
			request.quotedId ? prismaService.wppMessage.findFirst({ where: { id: request.quotedId, instance: session.instance } }) : null,
		]);
		const client = whatsappService.getClient(clientId);
		if (!registeredClient || !client || client.instance !== session.instance) throw new OperatorSendRequestError("Canal indisponível para envio.");
		if (!contact || (request.chatId && (!chat || chat.contactId !== request.contactId))) {
			throw new OperatorSendRequestError("Contato ou conversa inválidos nesta instância.");
		}
		const quotedProviderId = request.quotedId ? resolveOperatorQuotedMessage({
			instance: session.instance, clientId, contactId: request.contactId, clientType: registeredClient.type,
		}, quoted) : null;
		let pipelineSource: PipelineTriggerSource | undefined;
		if (request.readyMessageId) {
			await readyMessagesService.getReadyMessageForSend(session, request.readyMessageId);
			pipelineSource = readyMessagePipelineSource(request.readyMessageId);
		}
		const text = `*${session.name}*: ${request.text}`;
		const now = new Date();
		const message: Prisma.WppMessageUncheckedCreateInput = {
			instance: session.instance, userId: session.userId, clientId,
			from: `me:${client._phone}`, to: request.to, body: text, type: "chat",
			status: "PENDING", sentAt: now, timestamp: now.getTime().toString(),
			contactId: request.contactId, chatId: request.chatId, quotedId: request.quotedId,
			isForwarded: request.isForwarded,
			...messageMentionPatch({ mentionEntities: operatorMentionEntities(request.mentions) }),
		};
		let options: SendMessageOptions = { to: request.to, text };
		if (request.mentions.length) options.mentions = request.mentions as Mentions;
		if (quotedProviderId) options.quotedId = quotedProviderId;
		let fileData = request.fileId ? await filesService.fetchFileMetadata(request.fileId) : null;
		if (file && request.file) {
			fileData = await filesService.uploadFile({
				instance: session.instance, dirType: FileDirType.PUBLIC,
				fileName: file.originalname, mimeType: file.mimetype, buffer: file.buffer,
				contentHash: request.file.hash,
				...(typeof data["traceId"] === "string" ? { traceId: data["traceId"] } : {}),
			});
		}
		if (fileData) {
			options = {
				...options, fileId: fileData.id, file: fileData,
				localFileUrl: filesService.getFileDownloadUrl(fileData.id),
				publicFileUrl: filesService.getPublicFileUrl(session.instance, fileData.public_id),
				sendAsAudio: request.sendAsAudio, sendAsDocument: request.sendAsDocument,
			};
			Object.assign(message, { fileId: fileData.id, fileName: fileData.name, fileType: fileData.mime_type,
				fileSize: String(fileData.size), type: getMessageType(fileData.mime_type, request.sendAsAudio, request.sendAsDocument) });
		}
		const payload: OperatorSendPayload = { options, ...(pipelineSource ? { pipelineSource } : {}) };
		// JSON roundtrip freezes media metadata and options across remote retries.
		const result = await operatorOutboundService.enqueue({
			...scope, clientId, idempotencyKey: key, payloadHash, message,
			payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonObject,
			deliveryMode: client.submitMessageJob && client.getMessageJob ? "REMOTE" : "DIRECT",
		});
		if (result.created) {
			void messagesDistributionService.notifyMessage(null, result.message).catch((error) => {
				Logger.error("[OperatorOutbound] Pending notification failed; message remains persisted", error as Error);
			});
		}
		return result;
	}
}

export default new OperatorSendService();
