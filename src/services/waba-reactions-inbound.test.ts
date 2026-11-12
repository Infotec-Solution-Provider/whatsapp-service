import assert from "node:assert/strict";

async function main() {
	const saved = new Map<string, NodeModule | undefined>();
	const stub = (path: string, exports: unknown) => {
		const id = require.resolve(path); saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	const replace = (path: string, value: unknown) => stub(path, { __esModule: true, default: value });
	const received: unknown[][] = [], queries: any[] = [], statuses: unknown[][] = [], refreshed: unknown[][] = [];
	let recognized = true;
	let allowNormal = false, normalInserted = 0;
	let channels: any[] = [{ id: 13, instance: "odim", phone: "5511888888888" }];
	try {
		stub("@in.pulse-crm/utils", { sanitizeErrorMessage: String });
		replace("../utils/processing-logger", class { processName = "waba"; log() {} success() {} failed() {} });
		replace("./prisma.service", { $transaction: async (run: (db: unknown) => Promise<unknown>) => run({}), wppMessage: { findFirst: async () => null }, wppClient: {
			findMany: async (query: unknown) => { queries.push(query); return channels; },
			findFirstOrThrow: async () => { if (!allowNormal) throw Error("reaction cannot use unscoped client lookup"); return { id: 13, instance: "odim" }; },
		} });
		for (const path of ["./chats.service", "./files.service"]) {
			replace(path, new Proxy({}, { get() { throw Error(`Reaction must not create/distribute a message: ${path}`); } }));
		}
		replace("../parsers/waba-message.parser", { parse: async (_id: number, _recipient: string, _instance: string, message: any) => {
			if (message.type === "reaction") throw Error("reaction reached normal parser");
			return { wabaId: message.id };
		} });
		replace("./messages.service", { insertMessage: async (message: any) => { normalInserted++; return message; } });
		replace("./messages-distribution.service", { processMessage: async () => ({ contactId: null }) });
		replace("./message-reactions.service", { receiveWaba: async (...args: unknown[]) => { received.push(args); }, refreshWabaTarget: async (...args: unknown[]) => { refreshed.push(args); } });
		stub("./waba-reaction-receipts.service", { WabaReactionReceiptsService: class { async applyStatus(...args: unknown[]) {
			statuses.push(args); return recognized ? { clientId: 13, targetMessageId: "wamid.target", reactionChanged: true } : null;
		} } });
		const moduleId = require.resolve("./waba.service"); saved.set(moduleId, require.cache[moduleId]); delete require.cache[moduleId];
		const service = (require("./waba.service") as typeof import("./waba.service")).default;
		const raw = { type: "reaction", id: "wamid.event", from: "5511999999999", timestamp: "1794487020", reaction: { message_id: "wamid.target", emoji: "👍" } };
		const payload = (message: unknown, metadata: unknown = { phone_number_id: "phone-id", display_phone_number: "5511888888888" }) => ({ object: "whatsapp_business_account", entry: [{ id: "account-id", changes: [{ field: "messages", value: { metadata, messages: [message] } }] }] });
		await service.handleWebhookEntry("odim", payload(raw));
		await service.handleWebhookEntry("odim", payload(raw));
		await service.handleWebhookEntry("odim", payload({ ...raw, reaction: { message_id: "wamid.target" } }));
		assert.equal(received.length, 3);
		assert.deepEqual(queries[0], { where: { instance: "odim", type: "WABA", isActive: true, WABAPhoneId: "phone-id", WABAAccountId: "account-id" }, take: 2 });
		assert.equal(received[0]![1], raw);
		const batch = payload(raw);
		batch.entry[0]!.changes[0]!.value.messages.push({ ...raw, id: "wamid.second" });
		batch.entry[0]!.changes.push({ field: "messages", value: { metadata: { phone_number_id: "phone-id", display_phone_number: "5511888888888" }, messages: [{ ...raw, id: "wamid.third" }] } });
		await service.handleWebhookEntry("odim", batch);
		assert.equal(received.length, 6, "second message and second change must each be handled");
		allowNormal = true;
		const mixed: any = payload(raw);
		mixed.entry[0].changes[0].value.messages.unshift({ id: "wamid.text", from: raw.from, timestamp: raw.timestamp, type: "image", image: { id: "media" } });
		await service.handleWebhookEntry("odim", mixed);
		assert.equal(normalInserted, 1, "ordinary items retain their normal insertion path");
		assert.equal(received.length, 7, "a reaction after an ordinary message is not lost or inserted as a bubble");
		allowNormal = false;
		channels = [];
		await assert.rejects(service.handleWebhookEntry("odim", payload(raw)), /CHANNEL_MISMATCH/);
		channels = [{ id: 13 }, { id: 14 }];
		await assert.rejects(service.handleWebhookEntry("odim", payload(raw)), /CHANNEL_MISMATCH/);
		await assert.rejects(service.handleWebhookEntry("odim", payload(raw, {})), /CHANNEL_REQUIRED/);
		assert.equal(received.length, 7);
		const statusPayload: any = payload(raw);
		delete statusPayload.entry[0].changes[0].value.messages;
		statusPayload.entry[0].changes[0].value.statuses = [{ id: "wamid.out", status: "failed", recipient_id: raw.from, timestamp: raw.timestamp, biz_opaque_callback_data: "inpulse:reaction:operation" }];
		assert.equal((await service.handleWebhookEntry("odim", statusPayload)).ignored, true);
		assert.deepEqual(statuses[0]![2], { wabaAccountId: "account-id", phoneNumberId: "phone-id" });
		assert.deepEqual(refreshed[0], ["odim", 13, "wamid.target"]);
		delete statusPayload.entry[0].changes[0].value.metadata;
		await assert.rejects(service.handleWebhookEntry("odim", statusPayload), /CHANNEL_REQUIRED/);
		assert.equal(statuses.length, 1, "missing channel cannot acknowledge a marked receipt");
		statusPayload.entry[0].changes[0].value.metadata = { phone_number_id: "phone-id" };
		recognized = false;
		await assert.rejects(service.handleWebhookEntry("odim", statusPayload), /RECEIPT_NOT_FOUND/);
		console.log("waba-reactions-inbound: exact tenant/account/phone channel, duplicates and removals bypass normal message insertion/distribution");
	} finally { for (const [id, cached] of saved) { if (cached) require.cache[id] = cached; else delete require.cache[id]; } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
