import type { PrismaClient, WppMessage } from "@prisma/client";
import type CreateMessageDto from "../dtos/create-message.dto";
import type { WABASystemMessageData } from "../types/whatsapp-api.types";

/** System notices are audit records, never customer activity or identity updates. */
export class WabaSystemEventsService {
	constructor(
		private readonly db: Pick<PrismaClient, "wppClient" | "wppContact" | "wppMessage">,
		private readonly insert: (data: CreateMessageDto) => Promise<WppMessage>
	) {}

	public async record(instance: string, data: WABASystemMessageData, phoneNumberId?: string, accountId?: string) {
		if (!phoneNumberId || !accountId) throw new Error("WABA_SYSTEM_CHANNEL_REQUIRED");
		const channels = await this.db.wppClient.findMany({
			where: { instance, type: "WABA", isActive: true, WABAPhoneId: phoneNumberId, WABAAccountId: accountId }, take: 2
		});
		if (channels.length !== 1) throw new Error("WABA_SYSTEM_CHANNEL_MISMATCH");
		const clientId = channels[0]!.id;
		const sender = typeof data.from === "string" ? data.from : "";
		if (typeof data.id !== "string" || !data.id.trim()) throw new Error("WABA_SYSTEM_ID_REQUIRED");
		const timestamp = typeof data.timestamp === "string" && /^\d{1,11}$/.test(data.timestamp)
			? Number(data.timestamp) * 1000 : NaN;
		if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) {
			throw new Error("WABA_SYSTEM_TIMESTAMP_INVALID");
		}
		const previous = async () => {
			const row = await this.db.wppMessage.findUnique({ where: { wabaId: data.id } });
			if (row && (row.instance !== instance || row.clientId !== clientId || row.type !== "thirdparty:meta"
				|| row.timestamp !== String(timestamp)
				|| (row.from === "thirdparty:meta" ? row.to !== (sender || "system") : row.from !== sender))) {
				throw new Error("WABA_SYSTEM_IDENTITY_MISMATCH");
			}
			return row;
		};
		const existing = await previous();
		// Includes notices saved by the old parser: never redistribute them on replay.
		if (existing) return { messageId: existing.id, duplicate: true, contactResolution: "unchanged" };
		const contacts = sender ? await this.db.wppContact.findMany({
			where: { instance, isDeleted: false, OR: [{ phone: sender }, { whatsappId: sender }] }, take: 2
		}) : [];
		const contactId = contacts.length === 1 ? contacts[0]!.id : null;
		const contactResolution = contacts.length > 1 ? "ambiguous" : contactId ? "exact" : "not-found";
		try {
			const row = await this.insert({
				instance, clientId, wabaId: data.id, type: "thirdparty:meta", from: "thirdparty:meta",
				to: sender || "system", body: typeof data.system?.body === "string" && data.system.body
					? data.system.body : "Notificação técnica do WhatsApp.",
				timestamp: String(timestamp), sentAt: new Date(timestamp), status: "READ", contactId, chatId: null
			});
			return { messageId: row.id, duplicate: false, contactResolution };
		} catch (error) {
			// Unique provider ID also protects concurrent workers and interrupted retries.
			if ((error as { code?: string } | null)?.code !== "P2002") throw error;
			const row = await previous();
			if (!row) throw error;
			return { messageId: row.id, duplicate: true, contactResolution };
		}
	}
}
