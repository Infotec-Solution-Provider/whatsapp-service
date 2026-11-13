import assert from "node:assert/strict";

async function main() {
	const saved = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown, raw = false) => {
		const id = require.resolve(path); saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: raw ? value : { __esModule: true, default: value } } as NodeModule;
	};
	const rows = new Map<string, any>(), names: Array<string | null> = [];
	let inserts = 0, distributions = 0, parses = 0, active = 0, maxActive = 0, fail = false;
	try {
		stub("@in.pulse-crm/utils", { sanitizeErrorMessage: (error: any) => error?.message ?? String(error) }, true);
		stub("../utils/processing-logger", class { processName = "waba"; log() {} success() {} failed() {} });
		stub("./chats.service", {});
		stub("./prisma.service", {
			wppClient: { findFirstOrThrow: async () => ({ id: 13, instance: "odim" }) },
			wppMessage: { findFirst: async ({ where }: any) => rows.get(where.wabaId) ?? null }
		});
		stub("./functional-health-probe-registry.service", { handleOfficialInbound: async () => ({ handled: false }) });
		stub("../parsers/waba-message.parser", { parse: async (clientId: number, _recipient: string, instance: string, message: any) => {
			parses++; return { instance, clientId, wabaId: message.id, from: message.from, timestamp: "1794487020000", chatId: null, contactId: null };
		} });
		stub("./messages.service", { insertMessage: async (message: any) => {
			assert(!rows.has(message.wabaId), "a repeated webhook cannot insert again");
			const row = { ...message, id: ++inserts }; rows.set(row.wabaId, row); return row;
		} });
		stub("./messages-distribution.service", { processMessage: async (_instance: string, _clientId: number, message: any, name: string | null) => {
			distributions++; active++; maxActive = Math.max(maxActive, active); names.push(name);
			try {
				await new Promise(resolve => setImmediate(resolve));
				if (fail) { fail = false; throw Error("Assignment temporarily unavailable"); }
				message.chatId = 700; return { ...message, contactId: null };
			} finally { active--; }
		} });
		stub("./message-reactions.service", {});
		stub("./waba-reaction-receipts.service", { WabaReactionReceiptsService: class {} }, true);
		const id = require.resolve("./waba.service"); saved.set(id, require.cache[id]); delete require.cache[id];
		const service = (require("./waba.service") as typeof import("./waba.service")).default;
		const sender = "5511987654321";
		const payload = (eventId: string, waId = sender) => ({ object: "whatsapp_business_account", entry: [{ id: "fixture-account", changes: [{ field: "messages", value: {
			metadata: { display_phone_number: "5511888888888", phone_number_id: "fixture-channel" },
			contacts: [{ wa_id: "5511000000000", profile: { name: "Outro perfil" } }, { wa_id: waId, profile: { name: "  Perfil correto  " } }],
			messages: [{ id: eventId, from: sender, timestamp: "1794487020", type: "text", text: { body: "fixture" } }]
		} }] }] });

		await Promise.all([service.handleWebhookEntry("odim", payload("wamid.concurrent")), service.handleWebhookEntry("odim", payload("wamid.concurrent"))]);
		assert.equal(inserts, 1); assert.equal(distributions, 1); assert.equal(parses, 1);
		assert.deepEqual(names, ["Perfil correto"]);
		assert.equal((await service.handleWebhookEntry("odim", payload("wamid.concurrent"))).ignored, true);
		assert.equal(parses, 1, "a completed duplicate skips parsing and media work");

		fail = true;
		await assert.rejects(service.handleWebhookEntry("odim", payload("wamid.retry")), /Assignment temporarily unavailable/);
		const savedId = rows.get("wamid.retry").id;
		assert.equal(rows.get("wamid.retry").chatId, null);
		await service.handleWebhookEntry("odim", payload("wamid.retry"));
		assert.equal(rows.get("wamid.retry").id, savedId); assert.equal(rows.get("wamid.retry").chatId, 700);
		assert.equal(inserts, 2, "retry reuses the original saved message"); assert.equal(parses, 2);

		await Promise.all([service.handleWebhookEntry("odim", payload("wamid.next-a")), service.handleWebhookEntry("odim", payload("wamid.next-b"))]);
		assert.equal(inserts, 4); assert.equal(maxActive, 1, "distinct messages from the same peer are queued, not coalesced or distributed concurrently");
		await service.handleWebhookEntry("odim", payload("wamid.no-profile", "5511666666666"));
		assert.equal(names.at(-1), null);

		rows.set("wamid.foreign", { id: 99, instance: "foreign", clientId: 13, from: sender, chatId: null });
		const before = distributions;
		await assert.rejects(service.handleWebhookEntry("odim", payload("wamid.foreign")), /IDENTITY_MISMATCH/);
		assert.equal(distributions, before);
		rows.set("wamid.wrong-peer", { id: 100, instance: "odim", clientId: 13, from: "5511777777777", chatId: null });
		await assert.rejects(service.handleWebhookEntry("odim", payload("wamid.wrong-peer")), /IDENTITY_MISMATCH/);
		assert.equal((service as any).inboundPeers.size, 0, "failed and completed peer queues are released");
		console.log("waba-inbound-recovery: PASS duplicate/concurrent delivery, saved-message retry, peer serialization, profile matching and identity guards");
	} finally { for (const [id, value] of saved) { if (value) require.cache[id] = value; else delete require.cache[id]; } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
