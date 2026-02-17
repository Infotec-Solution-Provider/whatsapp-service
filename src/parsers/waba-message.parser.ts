import { WppMessageStatus } from "@prisma/client";
import CreateMessageDto from "../dtos/create-message.dto";
import filesService from "../services/files.service";
import prismaService from "../services/prisma.service";
import {
	Message,
	WABAContactData,
	WABAInteractiveMessageData,
	WABAMessageStatusData
} from "../types/whatsapp-api.types";
import ProcessingLogger from "../utils/processing-logger";

export default class WABAMessageParser {
	static parseStatus(data: WABAMessageStatusData): WppMessageStatus {
		switch (data.status) {
			case "sent":
				return WppMessageStatus.SENT;
			case "delivered":
				return WppMessageStatus.RECEIVED;
			case "read":
				return WppMessageStatus.READ;
			case "failed":
				return WppMessageStatus.ERROR;
			default:
				return WppMessageStatus.PENDING;
		}
	}

	static async parse(
		clientId: number,
		recipient: string,
		instance: string,
		data: Message,
		logger?: ProcessingLogger
	): Promise<CreateMessageDto> {
		try {
			const timestampMs = this.normalizeTimestamp(data.timestamp);
			const parsed: CreateMessageDto = {
				instance,
				wabaId: data.id,
				from: data.from,
				to: `me:${recipient}`,
				type: data.type,
				timestamp: String(timestampMs),
				sentAt: new Date(timestampMs),
				status: WppMessageStatus.RECEIVED,
				body: "",
				clientId
			};

			if (data.context?.id) {
				const quotedMsg = await prismaService.wppMessage.findFirst({ where: { wabaId: data.context.id } });
				if (quotedMsg) parsed.quotedId = quotedMsg.id;
			}
			if (data.context?.forwarded) parsed.isForwarded = true;
			if (data.context?.frequently_forwarded) parsed.isForwarded = true;

			let mediaId: string | undefined;

			switch (data.type) {
				case "text":
					parsed.body = data.text.body;
					break;
				case "video":
					parsed.body = data.video.caption || "";
					mediaId = data.video.id;
					break;
				case "image":
					parsed.body = data.image.caption || "";
					mediaId = data.image.id;
					break;
				case "document":
					parsed.body = data.document.caption || "";
					mediaId = data.document.id;
					break;
				case "audio":
					mediaId = data.audio.id;
					break;
				case "sticker":
					parsed.body = "[sticker]";
					mediaId = data.sticker.id;
					break;
				case "contacts": {
					parsed.type = "vcard";
					const contact = data.contacts[0];
					if (contact) parsed.body = this.formatContact(contact);
					break;
				}
				case "location": {
					const loc = data.location;
					parsed.body = `Location: ${loc.latitude},${loc.longitude}${loc.name ? " - " + loc.name : ""}`;
					break;
				}
				case "reaction": {
					throw new Error("Mensagens do tipo 'reaction' não são suportadas.");
					break;
				}
				case "interactive": {
					parsed.body = this.parseInteractiveBody(data);
					break;
				}
				default:
					throw new Error(`Tipo de mensagem não suportado: ${(data as any)?.type}`);
			}

			if (mediaId) {
				const fileData = await filesService.uploadWabaMedia(instance, mediaId);
				parsed.fileId = fileData.id;
				parsed.fileName = fileData.name;
				parsed.fileType = fileData.mime_type;
				parsed.fileSize = String(fileData.size);
			}

			return parsed;
		} catch (err: any) {
			logger?.log("Falha no parsing de mensagem WABA", {
				messageId: data?.id,
				type: data?.type,
				from: data?.from,
				error: err?.message || String(err)
			});
			throw err;
		}
	}

	private static parseInteractiveBody(data: WABAInteractiveMessageData): string {
		const interactive = data.interactive;
		if (!interactive) return "";
		switch (interactive.type) {
			case "button":
				return `Botão: ${interactive.button_reply?.title || interactive.button_reply?.id || ""}`;
			case "list":
				return `Lista: ${interactive.list_reply?.title || interactive.list_reply?.id || ""}`;
			case "product":
				return `Produto: ${interactive.product_item?.product_retailer_id}`;
			case "product_list":
				return "Lista de produtos";
			case "flow":
				return `Fluxo: ${interactive.flow_reply?.title || interactive.flow_reply?.id || ""}`;
			default:
				return "";
		}
	}

	private static normalizeTimestamp(ts: string): number {
		if (!ts) return Date.now();
		if (/^\d+$/.test(ts)) {
			if (ts.length === 10) return Number(ts) * 1000;
			if (ts.length === 13) return Number(ts);
		}
		const asDate = Date.parse(ts);
		return isNaN(asDate) ? Date.now() : asDate;
	}

	private static formatContact(contact: WABAContactData): string {
		const lines: string[] = ["--- Contato ---"];
		const nameParts = [
			contact.name.prefix,
			contact.name.first_name,
			contact.name.middle_name,
			contact.name.last_name,
			contact.name.suffix
		].filter(Boolean);
		lines.push(nameParts.join(" ") || contact.name.formatted_name);
		if (contact.phones?.length) {
			lines.push("Telefones:");
			contact.phones.forEach((p) =>
				lines.push(`• ${p.type}: ${p.phone}${p.wa_id ? " (wa:" + p.wa_id + ")" : ""}`)
			);
		}
		if (contact.emails?.length) {
			lines.push("Emails:");
			contact.emails.forEach((e) => lines.push(`• ${e.type || "email"}: ${e.email}`));
		}
		if (contact.org?.company) {
			lines.push(`Empresa: ${contact.org.company}${contact.org.title ? " - " + contact.org.title : ""}`);
		}
		lines.push("----------------");
		return lines.join("\n");
	}
}
