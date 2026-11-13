import assert from "node:assert/strict";
import type { WppChat, WppContact, WppMessage } from "@prisma/client";
import { buildOdimInboundFlow } from "../message-flow/configurations/odim-inbound";

/** Real ingress/distribution/flow/identity/assignment code; only infrastructure is replaced. */
async function main() {
	const saved = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown, plain = false) => {
		const id = require.resolve(path); saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: plain ? value : { __esModule: true, default: value } } as NodeModule;
	};
	const contacts = new Map<number, WppContact>(), chats = new Map<number, WppChat>(), messages = new Map<number, WppMessage>();
	const configuration = buildOdimInboundFlow({ instance: "odim", sectorId: 138, clientId: 13, assigneeId: 510, fallbackUserId: 9 });
	let mode: "new" | "found" | "ambiguous" | "unavailable" = "new";
	let primaryActive = true, failAttach = false, lookups = 0, contactLinks = 0, reactions = 0;
	const decisions: string[] = [];
	const clone = <T>(value: T): T => structuredClone(value);
	const matchContact = (row: WppContact, where: any): boolean => {
		if (where.instance !== undefined && row.instance !== where.instance || where.id !== undefined && row.id !== where.id) return false;
		if (where.OR) return where.OR.some((part: any) => matchContact(row, part));
		for (const key of ["whatsappId", "phone", "customerId", "name", "isDeleted"]) {
			if (!(key in where)) continue;
			const expected = where[key], actual = (row as any)[key];
			if (expected && typeof expected === "object" && expected.in) { if (!expected.in.includes(actual)) return false; }
			else if (actual !== expected) return false;
		}
		return true;
	};
	const db = {
		wppContact: {
			findFirst: async ({ where }: any) => clone([...contacts.values()].find(row => matchContact(row, where)) ?? null),
			findUnique: async ({ where }: any) => clone(contacts.get(where.id) ?? null),
			create: async ({ data }: any) => {
				const row = { id: contacts.size + 1, customerId: null, isDeleted: false, isOnlyAdmin: false, isBlocked: false, conversationExpiration: null, createdAt: new Date(), ...data } as WppContact;
				contacts.set(row.id, row); return clone(row);
			},
			updateMany: async ({ where, data }: any) => {
				const row = [...contacts.values()].find(item => matchContact(item, where));
				if (!row) return { count: 0 };
				if (data.customerId !== undefined) contactLinks++;
				Object.assign(row, data); return { count: 1 };
			},
			update: async ({ where, data }: any) => { const row = contacts.get(where.id)!; Object.assign(row, data); return clone(row); }
		},
		wppClient: {
			findFirstOrThrow: async () => ({ id: 13, instance: "odim", sectors: [{ id: 138, instance: "odim" }] }),
			findUnique: async () => ({ id: 13, instance: "odim", sectors: [{ id: 138, instance: "odim" }] }),
			findMany: async () => [{ id: 13, instance: "odim" }]
		},
		wppSector: { findFirst: async ({ where }: any) => where.instance === "odim" && where.id === 138 ? { id: 138 } : null },
		wppMessage: { findFirst: async ({ where }: any) => clone([...messages.values()].find(row => row.wabaId === where.wabaId) ?? null) },
		wppMessageFlow: { findUnique: async () => ({ WppMessageFlowStep: configuration.steps }) },
		wppChat: {
			create: async ({ data }: any) => { const row = { id: chats.size + 1, botId: null, agentId: null, isFinished: false, walletId: null, ...data } as WppChat; chats.set(row.id, row); return clone(row); },
			findUnique: async ({ where }: any) => clone(chats.get(where.id) ?? null),
			groupBy: async () => [{ userId: 529, _count: { id: 0 } }]
		},
		automaticResponseRule: { findMany: async () => [] }
	};
	try {
		stub("@in.pulse-crm/utils", { ...require("@in.pulse-crm/utils"), sanitizeErrorMessage: (error: any) => error?.message ?? String(error), Logger: { error() {}, info() {}, debug() {}, warn() {} } }, true);
		stub("../utils/processing-logger", class {
			processName = "fixture";
			log(_message: string, data?: any) { if (typeof data?.reason === "string") decisions.push(data.reason); }
			debug() {} success() {} failed() {}
		});
		stub("./prisma.service", db);
		stub("./parameters.service", {});
		stub("./instances.service", { executeQuery: async (_instance: string, sql: string, _params: unknown[], options?: { timeoutMs?: number }) => {
			if (sql.includes("SELECT DISTINCT candidate.customer_id")) {
				assert.equal(options?.timeoutMs, 3000); lookups++;
				if (mode === "unavailable") throw Error("Fixture CRM unavailable");
				return mode === "found" ? [{ customer_id: 42 }] : mode === "ambiguous" ? [{ customer_id: 42 }, { customer_id: 43 }] : [];
			}
			if (sql.includes("WHERE CODIGO IN")) {
				assert.equal(options?.timeoutMs, 3000);
				return [{ CODIGO: 510, SETOR: 138, ATIVO: primaryActive ? "SIM" : "NAO", NIVEL: "AMBOS" }, { CODIGO: 9, SETOR: 138, ATIVO: "SIM", NIVEL: "ADMIN" }];
			}
			if (sql.includes("campanhas_clientes")) return [{ OPERADOR: 529 }];
			if (sql.includes("FROM operadores")) return [{ CODIGO: 529, SETOR: 138, ATIVO: "SIM", NIVEL: "ATIVO" }];
			if (sql.includes("INSERT INTO wpp_contacts")) return [];
			throw Error("Unexpected fixture CRM query");
		} });
		stub("./auth.service", { getOnlineSessions: async () => [{ data: { userId: 529, sectorId: 138 } }] });
		stub("./chats.service", {
			getChatForContact: async (_clientId: number, contact: WppContact) => clone([...chats.values()].find(chat => chat.contactId === contact.id && !chat.isFinished) ?? null),
			syncChatToLocal: async () => {}
		});
		stub("./messages.service", {
			insertMessage: async (data: any) => { const row = { id: messages.size + 1, chatId: null, contactId: null, wabaId: null, ...data } as WppMessage; messages.set(row.id, row); return clone(row); },
			updateMessage: async (id: number, data: any) => { if (failAttach) { failAttach = false; throw Error("Fixture attach interrupted"); } const row = messages.get(id)!; Object.assign(row, data); return clone(row); }
		});
		stub("./message-queue.service", { setProcessHandler() {} });
		stub("./message-presentation.service", { hydrate: async (_instance: string, rows: WppMessage[]) => rows });
		stub("./message-mentions.service", {});
		stub("./socket.service", { emit: async () => {} });
		stub("./transfer-history.service", {});
		stub("./whatsapp.service", { getProfilePictureUrl: async () => null });
		stub("../bots/bots-registry", new Map());
		// Production has a separate sharing adapter; homolog implements sharing in its generic reader.
		try { require.resolve("./odim-supervision-sharing.service"); stub("./odim-supervision-sharing.service", { odimSupervisionObservers: async () => [] }, true); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error; }
		stub("./functional-health-probe-registry.service", { handleOfficialInbound: async () => ({ handled: false }) });
		stub("./message-reactions.service", { receiveWaba: async () => { reactions++; } });
		stub("./waba-reaction-receipts.service", { WabaReactionReceiptsService: class {} }, true);
		const axios = require("axios");
		const originalPost = axios.default.post;
		axios.default.post = async (url: string) => { assert.ok(url.endsWith("/api/ai/agents/process-message"), "no provider/send HTTP is permitted"); return { data: {} }; };
		try {
			(require("../message-flow/register-steps") as typeof import("../message-flow/register-steps")).registerAllSteps();
			const waba = (require("./waba.service") as typeof import("./waba.service")).default;
			const peer = (index: number) => `551198765${String(index).padStart(4, "0")}`;
			const webhook = (id: string, index: number, reaction = false) => ({ object: "whatsapp_business_account", entry: [{ id: "qa-account", changes: [{ field: "messages", value: {
				metadata: { display_phone_number: "5511888888888", phone_number_id: "qa-channel" }, contacts: [{ wa_id: peer(index), profile: { name: `Perfil ${index}` } }],
				messages: [{ id, from: peer(index), timestamp: String(Math.floor(Date.now() / 1000)), type: reaction ? "reaction" : "text", ...(reaction ? { reaction: { message_id: "wamid.new", emoji: "👍" } } : { text: { body: "Synthetic QA only" } }) }]
			} }] }] });
			const inbound = (id: string) => [...messages.values()].find(row => row.wabaId === id)!;
			const assigned = (id: string) => chats.get(inbound(id).chatId!)!;
			await waba.handleWebhookEntry("odim", webhook("wamid.new", 1));
			assert.equal(assigned("wamid.new").userId, 510, "new contacts follow configured triage despite lower-load user529");
			assert.equal(contacts.get(assigned("wamid.new").contactId!)!.name, "Perfil 1");
			assert.ok(decisions.includes("customer_not_found"));
			const beforeDuplicate = { contacts: contacts.size, chats: chats.size, messages: messages.size, lookups };
			assert.equal((await waba.handleWebhookEntry("odim", webhook("wamid.new", 1))).ignored, true);
			assert.deepEqual({ contacts: contacts.size, chats: chats.size, messages: messages.size, lookups }, beforeDuplicate);
			mode = "found";
			await waba.handleWebhookEntry("odim", webhook("wamid.known", 2));
			assert.equal(contacts.get(assigned("wamid.known").contactId!)!.customerId, 42);
			assert.equal(assigned("wamid.known").userId, 529, "real QUERY binds before the real loyalty step executes");
			assert.equal(contactLinks, 1);
			mode = "ambiguous"; await waba.handleWebhookEntry("odim", webhook("wamid.ambiguous", 3));
			assert.equal(assigned("wamid.ambiguous").userId, 510); assert.ok(decisions.includes("customer_lookup_ambiguous"));
			mode = "unavailable"; await waba.handleWebhookEntry("odim", webhook("wamid.unavailable", 4));
			assert.equal(assigned("wamid.unavailable").userId, 510); assert.ok(decisions.includes("customer_lookup_unavailable"));
			primaryActive = false; mode = "new";
			await waba.handleWebhookEntry("odim", webhook("wamid.fallback", 5));
			assert.equal(assigned("wamid.fallback").userId, 9, "real ASSIGN validates the destination and visible admin fallback");
			primaryActive = true;
			const open = assigned("wamid.new"); open.userId = 529;
			const beforeOpenLookup = lookups;
			await waba.handleWebhookEntry("odim", webhook("wamid.open", 1));
			assert.equal(assigned("wamid.open").id, open.id); assert.equal(assigned("wamid.open").userId, 529);
			assert.equal(lookups, beforeOpenLookup, "open attendance bypasses the creation flow and CRM lookup");
			const beforeParallel = chats.size;
			await Promise.all([waba.handleWebhookEntry("odim", webhook("wamid.parallel-a", 6)), waba.handleWebhookEntry("odim", webhook("wamid.parallel-b", 6))]);
			assert.equal(chats.size, beforeParallel + 1); assert.equal(assigned("wamid.parallel-a").id, assigned("wamid.parallel-b").id);
			failAttach = true;
			const beforeRetryChats = chats.size;
			await assert.rejects(waba.handleWebhookEntry("odim", webhook("wamid.retry", 7)), /Fixture attach interrupted/);
			assert.equal(inbound("wamid.retry").chatId, null);
			const persistedId = inbound("wamid.retry").id;
			await waba.handleWebhookEntry("odim", webhook("wamid.retry", 7));
			assert.equal(inbound("wamid.retry").id, persistedId); assert.ok(inbound("wamid.retry").chatId);
			assert.equal(chats.size, beforeRetryChats + 1, "retry reuses the chat created before attachment failed");
			const beforeReaction = { contacts: contacts.size, chats: chats.size, messages: messages.size, lookups };
			await waba.handleWebhookEntry("odim", webhook("wamid.reaction", 1, true));
			assert.equal(reactions, 1); assert.deepEqual({ contacts: contacts.size, chats: chats.size, messages: messages.size, lookups }, beforeReaction);
			console.log("odim-inbound-full-flow: PASS real WABA -> distribution -> QUERY/CAS -> router -> ASSIGN/loyalty; open, concurrent, retry and reaction paths");
		} finally { axios.default.post = originalPost; }
	} finally { for (const [id, value] of saved) { if (value) require.cache[id] = value; else delete require.cache[id]; } }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
