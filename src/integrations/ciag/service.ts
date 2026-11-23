import { WabaDeliveryError } from "../../utils/waba-send";
import { createHash, randomUUID } from "crypto";
import { CiagIntegration, CiagOutbound, Prisma, WppContact, WppMessage, WppMessageStatus } from "@prisma/client";
import axios from "axios";
import prisma from "../../services/prisma.service";
import whatsapp from "../../services/whatsapp.service";
import contactsService from "../../services/contacts.service";
import chatsService from "../../services/chats.service";
import messagesService from "../../services/messages.service";
import distribution from "../../services/messages-distribution.service";
import files from "../../services/files.service";
import { FileDirType } from "../../sdk-local";
import WABAWhatsappClient from "../../whatsapp-client/waba-whatsapp-client";
import { TemplateMessage } from "../../adapters/template.adapter";
import ProcessingLogger from "../../utils/processing-logger";
import WhatsappAudioConverter from "../../utils/whatsapp-audio-converter";
import { check, digest, openWindow, phone, string, validateMedia } from "./policy";
import type {
	DeliveryStatus,
	WhatsAppContact,
	WhatsAppContent,
	WhatsAppMedia,
	WhatsAppMessage,
	WhatsAppMessagePage,
	WhatsAppTemplate
} from "./types";

type SendInput = {
	externalId: string;
	phone: string;
	content: WhatsAppContent;
	actor: { id: string; name: string };
	broadcast: boolean;
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const enabled = () => process.env["CIAG_INTEGRATION_ENABLED"] === "true";
function dataOf(item: CiagOutbound): SendInput {
	return item.data as unknown as SendInput;
}
function delivery(status: WppMessageStatus): DeliveryStatus {
	return status === "READ"
		? "read"
		: status === "RECEIVED"
			? "delivered"
			: status === "SENT"
				? "sent"
				: status === "ERROR"
					? "failed"
					: "sending";
}
export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

class CiagService {
	private work: Promise<void> | undefined;
	private timer: NodeJS.Timeout | undefined;
	private stopped = false;
	async authenticate(authorization: string | undefined) {
		check(enabled(), "Integração CIAG desabilitada.", 503);
		check(
			authorization?.startsWith("Bearer ") && authorization.length <= 300,
			"Chave de integração inválida.",
			401
		);
		const scope = await prisma.ciagIntegration.findUnique({ where: { keyHash: keyHash(authorization!.slice(7)) } });
		check(scope?.active, "Chave de integração inválida.", 401);
		await this.connection(scope);
		return scope;
	}
	async connection(scope: CiagIntegration) {
		const client = await prisma.wppClient.findFirst({
			where: {
				id: scope.clientId,
				instance: scope.instance,
				type: "WABA",
				isActive: true,
				sectors: { some: { id: scope.sectorId, instance: scope.instance } }
			}
		});
		check(client, "Conexão WABA do CIAG indisponível.", 503);
		return client;
	}
	async status(scope: CiagIntegration, test = false) {
		const connection = await this.connection(scope),
			provider = whatsapp.getClient(scope.clientId);
		const connected = provider instanceof WABAWhatsappClient;
		if (test) {
			check(connected, "Conexão WABA não iniciada.", 503);
			await provider.verifyConnection();
		}
		return { configured: true, enabled: true, connected, phone: connection.phone ?? "", instance: scope.instance };
	}
	async contact(scope: CiagIntegration, rawPhone: unknown, name?: unknown) {
		const p = phone(rawPhone);
		let contact = await prisma.wppContact.findFirst({
			where: { instance: scope.instance, phone: p, isDeleted: false }
		});
		if (!contact && name)
			contact = await contactsService.getOrCreateContact(scope.instance, string(name, 200), p, p, true);
		check(contact && !contact.isDeleted, "Contato não encontrado.", 404);
		await prisma.wppContactSector.upsert({
			where: { contactId_sectorId: { contactId: contact.id, sectorId: scope.sectorId } },
			create: { contactId: contact.id, sectorId: scope.sectorId },
			update: {}
		});
		return contact;
	}
	async summary(scope: CiagIntegration, contact: WppContact): Promise<WhatsAppContact> {
		const p = contact.phone ?? contact.whatsappId ?? "";
		const state = await prisma.ciagContactState.findUnique({
			where: { integrationId_phone: { integrationId: scope.id, phone: p } }
		});
		const [last, unread, latest] = await Promise.all([
			prisma.wppMessage.findFirst({
				where: {
					instance: scope.instance,
					clientId: scope.clientId,
					contactId: contact.id,
					NOT: { from: { startsWith: "me:" } },
					type: { notIn: ["system", "thirdparty:meta"] }
				},
				orderBy: [{ sentAt: "desc" }, { id: "desc" }]
			}),
			prisma.wppMessage.count({
				where: {
					instance: scope.instance,
					clientId: scope.clientId,
					contactId: contact.id,
					to: { startsWith: "me:" },
					...(state?.readAt ? { sentAt: { gt: state.readAt } } : {})
				}
			}),
			prisma.wppMessage.findFirst({
				where: { instance: scope.instance, clientId: scope.clientId, contactId: contact.id },
				orderBy: [{ sentAt: "desc" }, { id: "desc" }]
			})
		]);
		return {
			id: contact.id,
			phone: p,
			name: contact.name,
			blocked: contact.isBlocked,
			consent: (state?.consent ?? "unknown") as WhatsAppContact["consent"],
			lastInboundAt: last?.sentAt.toISOString() ?? null,
			unread,
			lastMessage: latest?.body ?? ""
		};
	}
	async contacts(scope: CiagIntegration) {
		const rows = await prisma.wppContact.findMany({
			where: {
				instance: scope.instance,
				isDeleted: false,
				OR: [
					{ sectors: { some: { sectorId: scope.sectorId } } },
					{ WppMessage: { some: { clientId: scope.clientId } } }
				]
			},
			orderBy: { id: "asc" }
		});
		const items: WhatsAppContact[] = [];
		// Bounded queries avoid exhausting the shared service's connection pool.
		for (const row of rows) items.push(await this.summary(scope, row));
		return items;
	}
	async consent(scope: CiagIntegration, input: Record<string, unknown>) {
		const contact = await this.contact(scope, input["phone"]);
		check(input["status"] === "granted" || input["status"] === "revoked", "Autorização inválida.");
		const evidence = string(input["evidence"], 1000),
			actor = this.actor(input["actor"]);
		await prisma.$transaction(async (tx) => {
			await tx.ciagContactState.upsert({
				where: { integrationId_phone: { integrationId: scope.id, phone: contact.phone! } },
				create: {
					integrationId: scope.id,
					phone: contact.phone!,
					consent: input["status"] as string,
					evidence
				},
				update: { consent: input["status"] as string, evidence }
			});
			await tx.ciagAudit.create({
				data: {
					id: randomUUID(),
					integrationId: scope.id,
					actorId: actor.id,
					actorName: actor.name,
					action: "consent",
					data: json({ phone: contact.phone, status: input["status"], evidence })
				}
			});
		});
		return this.summary(scope, contact);
	}
	actor(raw: unknown) {
		check(raw && typeof raw === "object", "Autor inválido.");
		const actor = raw as Record<string, unknown>;
		return { id: string(actor["id"], 100), name: string(actor["name"], 200) };
	}
	async templates(scope: CiagIntegration, refresh = false): Promise<WhatsAppTemplate[]> {
		const client = whatsapp.getClient(scope.clientId);
		check(client instanceof WABAWhatsappClient, "Conexão WABA não iniciada.", 503);
		const raw = (await client.getCiagTemplates(refresh)) as TemplateMessage[];
		return raw.map((t) => ({
			id: t.id,
			name: t.name,
			language: t.language,
			status: t.status,
			body: t.text,
			components: t.raw.components
		}));
	}
	async allowedMedia(scope: CiagIntegration, fileId: number) {
		check(Number.isSafeInteger(fileId) && fileId > 0, "Arquivo inválido.");
		const own = await prisma.ciagMedia.findUnique({
			where: { integrationId_fileId: { integrationId: scope.id, fileId } }
		});
		const inbound = own
			? null
			: await prisma.wppMessage.findFirst({
					where: { instance: scope.instance, clientId: scope.clientId, fileId }
				});
		check(own || inbound, "Arquivo indisponível nesta integração.", 404);
		return files.fetchFileMetadata(fileId);
	}
	async content(scope: CiagIntegration, raw: unknown): Promise<WhatsAppContent> {
		check(raw && typeof raw === "object", "Mensagem inválida.");
		const c = raw as WhatsAppContent;
		if (c.kind === "text") return { kind: "text", text: string(c.text) };
		const media = async (m: WhatsAppMedia | undefined): Promise<WhatsAppMedia> => {
			check(m && Number.isSafeInteger(m.id), "Anexe um arquivo válido.");
			const file = await this.allowedMedia(scope, m.id);
			// Validate the actual bytes and metadata, never the MIME supplied by CIAG.
			validateMedia(await files.fetchFile(file.id), file.mime_type);
			const owned = await prisma.ciagMedia.findUnique({
				where: { integrationId_fileId: { integrationId: scope.id, fileId: file.id } }
			});
			return {
				id: file.id,
				name: file.name,
				mime: file.mime_type,
				size: Number(file.size),
				voice: owned?.voice ?? false
			};
		};
		if (c.kind === "media") {
			const attachment = await media(c.media);
			check(
				c.text === undefined || (typeof c.text === "string" && c.text.length <= 1024),
				"Legenda acima de 1.024 caracteres."
			);
			check(
				!attachment.mime.startsWith("audio/") || !c.text?.trim(),
				"Áudio não aceita legenda. Envie o texto em uma mensagem separada."
			);
			return { kind: "media", text: c.text ?? "", media: attachment };
		}
		check(
			c.kind === "template" &&
				c.template &&
				typeof c.template.variables === "object" &&
				c.template.variables !== null &&
				!Array.isArray(c.template.variables),
			"Modelo inválido."
		);
		const t = c.template;
		const template = (await this.templates(scope)).find(
			(r) => r.id === t.id && r.name === t.name && r.language === t.language && r.status === "APPROVED"
		);
		check(template, "Modelo não aprovado ou indisponível.");
		const variables: Record<string, string> = {};
		check(Object.keys(t.variables).length <= 100, "Variáveis em excesso.");
		for (const [key, value] of Object.entries(t.variables)) {
			check(/^[a-zA-Z0-9_.:-]{1,60}$/.test(key), "Variável inválida.");
			variables[key] = string(value, 1024);
		}
		const attachment = t.media ? await media(t.media) : undefined;
		// This provider method builds and validates text, media headers and button parameters.
		await (whatsapp.getClient(scope.clientId) as WABAWhatsappClient).buildCiagTemplate(
			template.name,
			template.language,
			variables,
			attachment?.id
		);
		return {
			kind: "template",
			template: {
				id: template.id,
				name: template.name,
				language: template.language,
				variables,
				...(attachment ? { media: attachment } : {})
			}
		};
	}
	async guard(scope: CiagIntegration, input: SendInput) {
		const contact = await this.contact(scope, input.phone);
		check(!contact.isBlocked, "Contato bloqueado.");
		const summary = await this.summary(scope, contact);
		check(summary.consent !== "revoked", "Contato descadastrado. Registre nova autorização antes de enviar.");
		if (input.broadcast || input.content.kind === "template")
			check(summary.consent === "granted", "Contato sem autorização para este envio.");
		if (input.content.kind !== "template")
			check(
				openWindow(summary.lastInboundAt ? new Date(summary.lastInboundAt) : null),
				"Janela de atendimento fechada. Utilize um modelo aprovado."
			);
		return contact;
	}
	async submit(scope: CiagIntegration, input: Record<string, unknown>) {
		const externalId = string(input["externalId"], 160);
		check(/^[a-zA-Z0-9:_-]{16,160}$/.test(externalId), "Identificador externo inválido.");
		const incoming = {
			externalId,
			phone: phone(input["phone"]),
			content: input["content"],
			actor: this.actor(input["actor"]),
			broadcast: input["broadcast"] === true
		};
		const requestHash = digest(incoming);
		const old = await prisma.ciagOutbound.findUnique({
			where: { integrationId_externalId: { integrationId: scope.id, externalId } }
		});
		if (old) {
			check(old.requestHash === requestHash, "Identificador já utilizado com outro conteúdo.", 409);
			return this.present(old);
		}
		const normalized: SendInput = { ...incoming, content: await this.content(scope, incoming.content) };
		await this.guard(scope, normalized);
		let created: CiagOutbound;
		try {
			created = await prisma.ciagOutbound.upsert({
				where: { integrationId_externalId: { integrationId: scope.id, externalId } },
				create: {
					id: randomUUID(),
					integrationId: scope.id,
					externalId,
					requestHash,
					phone: normalized.phone,
					data: json(normalized)
				},
				update: {}
			});
		} catch (error) {
			if ((error as { code?: string }).code !== "P2002") throw error;
			created = await prisma.ciagOutbound.findUniqueOrThrow({
				where: { integrationId_externalId: { integrationId: scope.id, externalId } }
			});
		}
		check(created.requestHash === requestHash, "Identificador já utilizado com outro conteúdo.", 409);
		return this.present(created);
	}
	async present(item: CiagOutbound): Promise<WhatsAppMessage> {
		const input = dataOf(item),
			stored = item.messageId ? await prisma.wppMessage.findUnique({ where: { id: item.messageId } }) : null;
		return {
			id: stored?.id ?? 0,
			externalId: item.externalId,
			phone: item.phone,
			direction: "out",
			text: stored?.body ?? input.content.text ?? "",
			sentAt: stored?.sentAt.toISOString() ?? item.createdAt.toISOString(),
			status: stored?.wabaId ? delivery(stored.status) : (item.state as DeliveryStatus),
			actor: input.actor,
			...(stored?.fileId
				? {
						media: {
							id: stored.fileId,
							name: stored.fileName ?? "arquivo",
							mime: stored.fileType ?? "application/octet-stream",
							size: Number(stored.fileSize)
						}
					}
				: {}),
			...(item.error ? { error: item.error } : {})
		};
	}
	async result(scope: CiagIntegration, externalId: unknown) {
		const item = await prisma.ciagOutbound.findUnique({
			where: { integrationId_externalId: { integrationId: scope.id, externalId: string(externalId, 160) } }
		});
		return item ? this.present(item) : null;
	}
	async cancel(scope: CiagIntegration, externalId: unknown) {
		const external = string(externalId, 160);
		await prisma.ciagOutbound.updateMany({
			where: { integrationId: scope.id, externalId: external, state: "queued" },
			data: { state: "cancelled", leaseUntil: null }
		});
		return this.result(scope, external);
	}
	async messages(scope: CiagIntegration, rawPhone: unknown, before?: unknown): Promise<WhatsAppMessagePage> {
		const p = phone(rawPhone),
			beforeId = before ? Number(before) : undefined;
		check(!beforeId || (Number.isSafeInteger(beforeId) && beforeId > 0), "Página inválida.");
		const contact = await prisma.wppContact.findFirst({
			where: { instance: scope.instance, phone: p, isDeleted: false }
		});
		if (!contact) return { items: [], beforeId: null };
		const rows = await prisma.wppMessage.findMany({
			where: {
				instance: scope.instance,
				clientId: scope.clientId,
				contactId: contact.id,
				...(beforeId ? { id: { lt: beforeId } } : {})
			},
			orderBy: { id: "desc" },
			take: 51
		});
		const page = rows.slice(0, 50).reverse();
		const outbound = await prisma.ciagOutbound.findMany({
			where: { integrationId: scope.id, messageId: { in: page.map((m) => m.id) } }
		});
		const items = page.map((m): WhatsAppMessage => {
			const out = outbound.find((o) => o.messageId === m.id);
			return {
				id: m.id,
				phone: p,
				direction: m.type === "system" ? "system" : m.from.startsWith("me:") ? "out" : "in",
				text: m.body,
				sentAt: m.sentAt.toISOString(),
				status: out && !m.wabaId ? (out.state as DeliveryStatus) : delivery(m.status),
				...(out ? { actor: dataOf(out).actor, externalId: out.externalId } : {}),
				...(m.fileId
					? {
							media: {
								id: m.fileId,
								name: m.fileName ?? "arquivo",
								mime: m.fileType ?? "application/octet-stream",
								size: Number(m.fileSize)
							}
						}
					: {})
			};
		});
		return { items, beforeId: rows.length > 50 ? (page[0]?.id ?? null) : null };
	}
	async read(scope: CiagIntegration, rawPhone: unknown) {
		const p = phone(rawPhone),
			now = new Date();
		await this.contact(scope, p);
		await prisma.ciagContactState.upsert({
			where: { integrationId_phone: { integrationId: scope.id, phone: p } },
			create: { integrationId: scope.id, phone: p, readAt: now },
			update: { readAt: now }
		});
	}
	async upload(
		scope: CiagIntegration,
		raw: { buffer: Buffer; mimetype: string; originalname: string },
		voice: boolean
	) {
		let buffer = raw.buffer,
			mime = raw.mimetype,
			name = raw.originalname.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 255);
		if (voice) {
			check(buffer.length <= 16 * 1024 * 1024, "Gravação acima de 16 MB.", 413);
			const converted = await WhatsappAudioConverter.convertToVoice(buffer, mime);
			buffer = converted.buffer;
			mime = converted.mimeType;
			name = "gravacao.ogg";
		}
		validateMedia(buffer, mime);
		const file = await files.uploadFile({
			instance: scope.instance,
			dirType: FileDirType.MODELS,
			fileName: name,
			mimeType: mime,
			buffer,
			contentHash: createHash("sha256").update(buffer).digest("hex")
		});
		await prisma.ciagMedia.create({ data: { integrationId: scope.id, fileId: file.id, voice } });
		return { id: file.id, name: file.name, mime: file.mime_type, size: Number(file.size), voice };
	}
	async download(scope: CiagIntegration, fileId: number) {
		const file = await this.allowedMedia(scope, fileId);
		return { file, data: await files.fetchFile(file.id) };
	}
	async withContactLock<T>(integrationId: string, number: string, task: () => Promise<T>): Promise<T> {
		const where = { integrationId_phone: { integrationId, phone: number } },
			owner = randomUUID();
		await prisma.ciagContactLock
			.upsert({ where, create: { integrationId, phone: number, owner, expiresAt: new Date(0) }, update: {} })
			.catch((e: { code?: string }) => {
				if (e.code !== "P2002") throw e;
			});
		const locked = await prisma.ciagContactLock.updateMany({
			where: { integrationId, phone: number, expiresAt: { lt: new Date() } },
			data: { owner, expiresAt: new Date(Date.now() + 300_000) }
		});
		check(locked.count, "Contato em processamento. Tente novamente.", 409);
		try {
			return await task();
		} finally {
			await prisma.ciagContactLock.updateMany({
				where: { integrationId, phone: number, owner },
				data: { expiresAt: new Date(0) }
			});
		}
	}
	async receiveInbound(scope: CiagIntegration, message: WppMessage) {
		const p = phone(message.from);
		return this.withContactLock(scope.id, p, async () => {
			const contact = await this.contact(scope, p, p);
			const { chat } = await chatsService.ensureActiveChatForAgent({
				instance: scope.instance,
				contactId: contact.id,
				sectorId: scope.sectorId,
				userId: null,
				agentId: null
			});
			const normalized = message.body
				.normalize("NFD")
				.replace(/[\u0300-\u036f]/g, "")
				.trim()
				.toLowerCase();
			if (/^(sair|parar|stop|cancelar mensagens|nao quero receber mensagens)[.!]?$/.test(normalized)) {
				await prisma.ciagContactState.upsert({
					where: { integrationId_phone: { integrationId: scope.id, phone: p } },
					create: {
						integrationId: scope.id,
						phone: p,
						consent: "revoked",
						evidence: `WhatsApp recebido: ${message.wabaId ?? message.id}`
					},
					update: { consent: "revoked", evidence: `WhatsApp recebido: ${message.wabaId ?? message.id}` }
				});
			}
			const processed = await messagesService.updateMessage(message.id, {
				contactId: contact.id,
				chatId: chat.id
			});
			await distribution
				.notifyMessage(
					new ProcessingLogger(scope.instance, "ciag-inbound", String(message.id), null),
					processed
				)
				.catch(() => {
					console.error("CIAG notification unavailable");
				});
			return processed;
		});
	}
	startWorker() {
		if (!enabled() || this.timer) return;
		this.stopped = false;
		this.timer = setInterval(() => {
			this.work ??= this.process()
				.catch(() => {
					console.error("CIAG outbound worker failed");
				})
				.finally(() => {
					this.work = undefined;
				});
		}, 500);
		this.timer.unref();
	}
	async stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.work;
	}
	private async process() {
		// Once the provider call began, expired leases are uncertain and never resent.
		await prisma.ciagOutbound.updateMany({
			where: { state: "sending", leaseUntil: { lt: new Date() } },
			data: {
				state: "unknown",
				error: "Envio interrompido. Confira a entrega antes de enviar novamente.",
				leaseUntil: null
			}
		});
		const due = await prisma.ciagOutbound.findFirst({
			where: {
				state: "queued",
				nextAt: { lte: new Date() },
				OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]
			},
			orderBy: { createdAt: "asc" }
		});
		if (!due || this.stopped) return;
		const claim = await prisma.ciagOutbound.updateMany({
			where: { id: due.id, state: "queued", OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
			data: { leaseUntil: new Date(Date.now() + 300_000) }
		});
		if (!claim.count) return;
		let providerStarted = false;
		let release: (() => Promise<void>) | undefined;
		try {
			const scope = await prisma.ciagIntegration.findUnique({ where: { id: due.integrationId } });
			check(scope?.active, "Integração desativada.");
			await this.connection(scope);
			const input = dataOf(due);
			const lockOwner = randomUUID();
			await prisma.ciagContactLock
				.upsert({
					where: { integrationId_phone: { integrationId: scope.id, phone: input.phone } },
					create: { integrationId: scope.id, phone: input.phone, owner: lockOwner, expiresAt: new Date(0) },
					update: {}
				})
				.catch((e: { code?: string }) => {
					if (e.code !== "P2002") throw e;
				});
			const locked = await prisma.ciagContactLock.updateMany({
				where: { integrationId: scope.id, phone: input.phone, expiresAt: { lt: new Date() } },
				data: { owner: lockOwner, expiresAt: new Date(Date.now() + 300_000) }
			});
			check(locked.count, "Contato em processamento. Tente novamente.", 409);
			release = async () => {
				await prisma.ciagContactLock.updateMany({
					where: { integrationId: scope.id, phone: input.phone, owner: lockOwner },
					data: { expiresAt: new Date(0) }
				});
			};
			const content = await this.content(scope, input.content),
				contact = await this.guard(scope, input);
			const client = whatsapp.getClient(scope.clientId);
			check(client instanceof WABAWhatsappClient, "Conexão WABA indisponível.", 503);
			const { chat } = await chatsService.ensureActiveChatForAgent({
				instance: scope.instance,
				contactId: contact.id,
				sectorId: scope.sectorId,
				userId: null,
				agentId: null
			});
			const base = {
				instance: scope.instance,
				from: `me:${client._phone}`,
				to: input.phone,
				body: content.text ?? "",
				type: content.kind === "template" ? "template" : (content.media?.mime.split("/")[0] ?? "text"),
				timestamp: String(Date.now()),
				sentAt: new Date(),
				status: WppMessageStatus.PENDING,
				clientId: scope.clientId,
				chatId: chat.id,
				contactId: contact.id,
				...(content.media
					? {
							fileId: content.media.id,
							fileName: content.media.name,
							fileType: content.media.mime,
							fileSize: String(content.media.size)
						}
					: {})
			};
			const pending = due.messageId
				? await prisma.wppMessage.findUniqueOrThrow({ where: { id: due.messageId } })
				: await prisma.$transaction(async (tx) => {
						const pending = await tx.wppMessage.create({ data: base });
						await tx.ciagOutbound.update({ where: { id: due.id }, data: { messageId: pending.id } });
						return pending;
					});
			// Cancel and claim compete on the same row before the irrevocable network boundary.
			const started = await prisma.ciagOutbound.updateMany({
				where: { id: due.id, state: "queued" },
				data: {
					state: "sending",
					attempts: { increment: 1 },
					messageId: pending.id,
					leaseUntil: new Date(Date.now() + 300_000)
				}
			});
			if (!started.count) return;
			providerStarted = true;
			let sent;
			if (content.kind === "template" && content.template)
				sent = await client.sendCiagTemplate(
					input.phone,
					content.template.name,
					content.template.language,
					content.template.variables,
					chat.id,
					contact.id,
					content.template.media?.id
				);
			else if (content.media) {
				const metadata = await this.allowedMedia(scope, content.media.id);
				sent = await client.sendMessage({
					to: input.phone,
					text: content.text ?? "",
					fileId: metadata.id,
					file: metadata,
					localFileUrl: files.getFileDownloadUrl(metadata.id),
					publicFileUrl: "",
					sendAsAudio: content.media.voice === true
				});
			} else sent = await client.sendMessage({ to: input.phone, text: content.text! });
			await messagesService.updateMessage(pending.id, {
				wabaId: sent.wabaId ?? null,
				body: sent.body,
				type: sent.type,
				timestamp: sent.timestamp,
				sentAt: sent.sentAt,
				fileId: sent.fileId ?? content.media?.id ?? null,
				fileName: sent.fileName ?? content.media?.name ?? null,
				fileType: sent.fileType ?? content.media?.mime ?? null,
				fileSize: sent.fileSize ?? (content.media ? String(content.media.size) : null),
				chatId: chat.id,
				contactId: contact.id,
				status: WppMessageStatus.SENT
			});
			await prisma.$transaction(async (tx) => {
				await tx.ciagOutbound.update({
					where: { id: due.id },
					data: { state: "sent", messageId: pending.id, error: null, leaseUntil: null }
				});
				await tx.ciagAudit.create({
					data: {
						id: randomUUID(),
						integrationId: scope.id,
						actorId: input.actor.id,
						actorName: input.actor.name,
						action: "sent",
						data: json({ externalId: input.externalId, messageId: pending.id })
					}
				});
			});
		} catch (error) {
			const definiteRejection =
				error instanceof WabaDeliveryError
					? error.deliveryStatus === "FAILED"
					: axios.isAxiosError(error) && Boolean(error.response?.data?.error);
			const busy = !providerStarted && (error as { status?: number }).status === 409;
			const transient =
				!providerStarted &&
				((error as { status?: number }).status === 503 || axios.isAxiosError(error)) &&
				due.attempts < 5;
			const throttled =
				definiteRejection &&
				(error instanceof WabaDeliveryError
					? error.details.httpStatus === 429
					: axios.isAxiosError(error) && error.response?.status === 429) &&
				due.attempts < 5;
			const state =
				busy || transient || throttled
					? "queued"
					: providerStarted && !definiteRejection
						? "unknown"
						: "failed";
			const message =
				state === "unknown"
					? "Resultado incerto. Confira a entrega antes de enviar novamente."
					: axios.isAxiosError(error)
						? "A Meta recusou o envio. Confira o modelo, a conexão e os limites."
						: error instanceof Error
							? error.message
							: "Falha no envio.";
			await prisma.ciagOutbound.update({
				where: { id: due.id },
				data: {
					state,
					error: message.slice(0, 1000),
					nextAt: new Date(Date.now() + (busy ? 1000 : 30_000 * (due.attempts + 1))),
					attempts: { increment: !providerStarted && !busy ? 1 : 0 },
					leaseUntil: null
				}
			});
		} finally {
			await release?.();
		}
	}
}
export default new CiagService();
