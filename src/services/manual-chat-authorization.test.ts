import assert from "node:assert/strict";
import { BadRequestError, ConflictError, InternalServerError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import type { SendTemplateData } from "./whatsapp.service";

type Row = Record<string, any>;
const key = "start_chats_only_for_loyal_operator";
const session: SessionData = { instance: "tenant-a", userId: 12, sectorId: 3, name: "Operator", role: "OPERATOR" };
const template: SendTemplateData = { template: { id: "hello", name: "hello", source: "waba", language: "pt_BR",
	category: "UTILITY", status: "APPROVED", text: "fixture", raw: {} }, templateVariables: {
		saudação_tempo: "fixture", cliente_cnpj: "fixture", cliente_razao: "fixture", contato_primeiro_nome: "fixture",
		contato_nome_completo: "fixture", atendente_nome: "fixture", atendente_nome_exibição: "fixture"
	}, components: [] };

function world() {
	return {
		contact: { id: 42, instance: "tenant-a", customerId: 81, phone: "5511999990000", whatsappId: null, isDeleted: false } as Row,
		parameters: [{ instance: "tenant-a", scope: "INSTANCE", key, value: "true" }] as Row[],
		loyalties: [{ CODIGO: 1, CLIENTE: 81, OPERADOR: 12 }] as Row[],
		chats: [] as Row[],
		crmError: null as Error | null,
		flagError: null as Error | null,
		clientInstance: "tenant-a",
		effects: [] as string[],
		crmReads: [] as Array<{ instance: string; query: string; values: unknown[] }>,
		flagReads: [] as Row[],
		targets: [{ CODIGO: 55 }] as Row[],
		transferChecks: [] as Row[],
		beforeTransferUpdate: null as (() => void) | null,
		replay: null as Row | null
	};
}
type World = ReturnType<typeof world>;
type Services = {
	chats: typeof import("./chats.service").default;
	whatsapp: typeof import("./whatsapp.service").default;
	operator: typeof import("./operator-send.service").default;
	authorization: typeof import("./manual-chat-authorization.service").default;
	controller: typeof import("../controllers/whatsapp.controller").default;
	messagesController: typeof import("../controllers/messages.controller").default;
};

async function withWorld(f: World, run: (s: Services) => Promise<void>) {
	const previous = new Map<string, NodeModule | undefined>();
	const replace = (path: string, exports: unknown) => {
		const resolved = require.resolve(path);
		if (!previous.has(resolved)) previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
	};
	const stub = (path: string, value: unknown) => replace(path, { __esModule: true, default: value });
	const fresh = (path: string) => {
		const resolved = require.resolve(path);
		if (!previous.has(resolved)) previous.set(resolved, require.cache[resolved]);
		delete require.cache[resolved];
		return require(path).default;
	};
	const matches = (row: Row, where: Row) => Object.entries(where).every(([field, value]) => row[field] === value);
	class SilentProcess { log() {} debug() {} success() {} failed() {} }
	const oldLog = console.log, oldError = console.error;
	try {
		console.log = console.error = () => undefined;
		replace("dotenv/config", {});
		replace("@in.pulse-crm/utils", { Logger: { log() {}, info() {}, debug() {}, error() {}, warn() {} },
			sanitizeErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) });
		stub("../utils/processing-logger", SilentProcess);
		stub("./prisma.service", {
			parameter: { findMany: async ({ where }: Row) => {
				f.flagReads.push(where);
				if (f.flagError) throw f.flagError;
				return f.parameters.filter((p) => matches(p, where));
			} },
			wppContact: { findFirst: async ({ where }: Row) => matches(f.contact, where) ? f.contact : null },
			wppClient: { findFirst: async ({ where }: Row) => matches({ id: 7, instance: f.clientInstance, isActive: true }, where)
				? { id: 7, instance: f.clientInstance, isActive: true, type: "WABA" } : null },
			wppChat: {
				findFirst: async ({ where }: Row) => f.chats.find((c) => matches(c, where)) ?? null,
				findUnique: async ({ where }: Row) => f.chats.find((c) => matches(c, where)) ?? null,
				update: async ({ where, data }: Row) => {
					const current = f.chats.find((c) => matches(c, where))!;
					f.effects.push("update-chat"); Object.assign(current, data); return { ...current };
				},
				updateMany: async ({ where, data }: Row) => {
					f.transferChecks.push(where);
					f.beforeTransferUpdate?.();
					const current = f.chats.find((c) => matches(c, where));
					if (!current) return { count: 0 };
					f.effects.push("update-chat"); Object.assign(current, data); return { count: 1 };
				},
				create: async ({ data }: Row) => {
					f.effects.push("create-chat");
					const chat = { id: 100, ...data, isFinished: false, contact: f.contact };
					f.chats.push(chat);
					return chat;
				}
			},
			wppSector: { findUnique: async () => ({ id: 3, defaultClientId: 7 }) }
		});
		stub("./instances.service", { executeQuery: async (instance: string, query: string, values: unknown[]) => {
			if (query === "SELECT CODIGO FROM operadores WHERE CODIGO = ? LIMIT 1") {
				assert.equal(instance, session.instance);
				if (f.crmError) throw f.crmError;
				return f.targets.filter((target) => Number(target["CODIGO"]) === values[0]);
			}
			if (/^SELECT \* FROM campanhas_clientes/.test(query)) {
				f.crmReads.push({ instance, query, values });
				if (f.crmError) throw f.crmError;
				assert.match(query, /ORDER BY CODIGO DESC LIMIT 1/);
				assert.doesNotMatch(query, /FIDELIZA|CONCLUIDO/);
				return f.loyalties.filter((l) => l["CLIENTE"] === values[0]).sort((a, b) => b["CODIGO"] - a["CODIGO"]).slice(0, 1);
			}
			f.effects.push("local-sync");
			return [];
		} });
		stub("./users.service", () => ({ setAuth() {}, getUserById: async () => ({ NOME: "Operator" }) }));
		stub("./messages-distribution.service", {
			addSystemMessage: async () => { f.effects.push("system-message"); },
			notifyChatStarted: async () => { f.effects.push("notify-chat"); },
			notifyMessage: async () => { f.effects.push("notify-message"); }
		});
		stub("./messages.service", {
			insertMessage: async (data: Row) => { f.effects.push("persist-message"); return { id: 200, ...data }; },
			updateMessage: async () => { f.effects.push("update-message"); }
		});
		stub("./operator-outbound.service", {
			lookup: async () => f.replay,
			enqueue: async ({ message }: Row) => { f.effects.push("enqueue"); return { message: { id: 200, ...message }, job: {}, created: true }; }
		});
		for (const path of ["./files.service", "./ready-messages.service"])
			stub(path, new Proxy({}, { get() { f.effects.push("external-prepare"); throw new Error(`Unexpected external access: ${path}`); } }));
		stub("./socket.service", { emit: async () => { f.effects.push("socket"); } });
		stub("./transfer-history.service", { recordTransfer: async () => { f.effects.push("transfer-history"); } });
		for (const path of ["./internal-chats.service", "./chat-user-preferences.service",
			"./public-report-fields.service", "../bots/exatron-satisfaction.bot", "./message-reactions.service"])
			stub(path, {});
		stub("./message-presentation.service", { fromStored: (message: Row) => message });
		for (const provider of ["gupshup", "remote", "waba", "wwebjs"])
			stub(`../whatsapp-client/${provider}-whatsapp-client`, class {});
		stub("../middlewares/is-authenticated.middleware", (_req: unknown, _res: unknown, next: () => void) => next());
		stub("../middlewares/multer.middleware", { single: () => (_req: unknown, _res: unknown, next: () => void) => next() });
		for (const middleware of ["only-local.middleware", "public-bi-rate-limit.middleware", "public-bi-auth.middleware"])
			stub(`../middlewares/${middleware}`, (_req: unknown, _res: unknown, next: () => void) => next());
		fresh("./parameters.service");
		fresh("./contacts.service");
		const authorization = fresh("./manual-chat-authorization.service");
		const whatsapp = fresh("./whatsapp.service");
		whatsapp.getProfilePictureUrl = async () => { f.effects.push("photo"); return null; };
		whatsapp.getClient = () => ({ id: 7, instance: f.clientInstance, _phone: "5511000000000",
			sendTemplate: async () => { f.effects.push("provider-template"); return { type: "chat", status: "SENT" }; },
			sendMessage: async () => { f.effects.push("provider-message"); return { type: "chat", status: "SENT" }; }
		});
		const chats = fresh("./chats.service"), operator = fresh("./operator-send.service");
		const controller = fresh("../controllers/whatsapp.controller");
		const messagesController = fresh("../controllers/messages.controller");
		await run({ chats, whatsapp, operator, authorization, controller, messagesController });
	} finally {
		console.log = oldLog;
		console.error = oldError;
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached; else delete require.cache[path];
		}
	}
}

const cases: Array<[string, (f: World, s: Services) => Promise<void>]> = [];
const test = (name: string, run: (f: World, s: Services) => Promise<void>) => cases.push([name, run]);
const deniedOwner = (f: World) => { f.loyalties = [{ CODIGO: 2, CLIENTE: 81, OPERADOR: 99 }]; };
const assertNoEffects = (f: World) => assert.deepEqual(f.effects, [], "denial must precede photo, writes, file preparation, notification and provider calls");
const chat = (overrides: Row = {}) => ({ id: 100, instance: "tenant-a", contactId: 42, userId: 12, isFinished: false, ...overrides });
const start = (s: Services, actor = session) => s.chats.startChatByContactId(actor, "fixture-token", 42, template);
const send = (s: Services, actor = session, chatId?: number) => s.whatsapp.sendTemplate(actor, 7, "5511999990000", template, chatId as number, 42);

test("other loyal operator is denied before all manual start effects, including its initial template", async (f, s) => {
	deniedOwner(f); await assert.rejects(start(s), UnauthorizedError); assertNoEffects(f);
});
test("greatest campaign CODIGO wins even if an older campaign belongs to the actor", async (f, s) => {
	f.loyalties.push({ CODIGO: 9, CLIENTE: 81, OPERADOR: 99 }); await assert.rejects(start(s), UnauthorizedError); assertNoEffects(f);
	assert.equal(f.crmReads.length, 1); assert.equal(f.crmReads[0]!.instance, session.instance); assert.deepEqual(f.crmReads[0]!.values, [81]);
});
test("loyal owner can start and send initial official template", async (f, s) => {
	await start(s); assert.ok(f.effects.includes("create-chat")); assert.ok(f.effects.includes("provider-template"));
});
for (const owner of [0, -1, -2, null]) test(`nonpositive/unassigned loyal operator ${owner} permits manual start`, async (f, s) => {
	f.loyalties[0]!["OPERADOR"] = owner; await start(s); assert.ok(f.effects.includes("create-chat"));
});
test("no loyalty row permits manual start", async (f, s) => { f.loyalties = []; await start(s); assert.ok(f.effects.includes("create-chat")); });
test("unlinked contact permits without querying CRM", async (f, s) => { f.contact["customerId"] = null; await start(s); assert.equal(f.crmReads.length, 0); });
test("real ADMIN bypasses loyalty and does not depend on CRM", async (f, s) => {
	deniedOwner(f); f.crmError = new Error("CRM unavailable"); await start(s, { ...session, role: "ADMIN" }); assert.equal(f.crmReads.length, 0);
});
test("start_chats_as_admin does not grant an operator a loyalty exception", async (f, s) => {
	deniedOwner(f); f.parameters.push({ instance: "tenant-a", scope: "INSTANCE", key: "start_chats_as_admin", value: "true" });
	await assert.rejects(start(s), UnauthorizedError); assertNoEffects(f);
});
test("CRM failure fails closed before manual start effects", async (f, s) => {
	f.crmError = new Error("CRM unavailable"); await assert.rejects(start(s), /CRM unavailable/); assertNoEffects(f);
});
test("parameter lookup failure fails closed", async (f, s) => {
	f.flagError = new Error("Parameters unavailable"); await assert.rejects(start(s), /Parameters unavailable/); assertNoEffects(f);
});
for (const value of ["false", "invalid", undefined]) test(`disabled/missing flag ${value} preserves legacy start without CRM`, async (f, s) => {
	deniedOwner(f); f.parameters = value === undefined ? [] : [{ instance: "tenant-a", scope: "INSTANCE", key, value }];
	f.crmError = new Error("Must not query CRM"); await start(s); assert.equal(f.crmReads.length, 0); assert.ok(f.effects.includes("provider-template"));
});
test("USER and SECTOR false cannot disable the instance flag", async (f, s) => {
	deniedOwner(f); f.parameters.push({ instance: "tenant-a", scope: "USER", userId: 12, key, value: "false" },
		{ scope: "SECTOR", sectorId: 3, key, value: "false" });
	await assert.rejects(start(s), UnauthorizedError); assertNoEffects(f); assert.ok(f.flagReads.every((r) => r["scope"] === "INSTANCE"));
});
test("USER-only true and another tenant's flag do not enable the instance policy", async (f, s) => {
	deniedOwner(f); f.parameters = [{ instance: "tenant-a", scope: "USER", userId: 12, key, value: "true" },
		{ instance: "tenant-b", scope: "INSTANCE", key, value: "true" }]; await start(s); assert.equal(f.crmReads.length, 0);
});
test("foreign tenant contact is rejected before any CRM lookup or start effect", async (f, s) => {
	f.contact["instance"] = "tenant-b"; await assert.rejects(start(s), NotFoundError); assertNoEffects(f); assert.equal(f.crmReads.length, 0);
});
test("deleted contact is denied before creating a partial official chat", async (f, s) => {
	f.contact["isDeleted"] = true; await assert.rejects(start(s), NotFoundError); assertNoEffects(f); assert.equal(f.crmReads.length, 0);
});
test("numeric-string loyal owner is normalized", async (f, s) => {
	f.loyalties[0]!["OPERADOR"] = "12"; await start(s); assert.ok(f.effects.includes("provider-template"));
});
for (const owner of [undefined, "invalid", "", 1.5, NaN]) test(`invalid loyal operator fails closed: ${owner}`, async (f, s) => {
	f.loyalties[0]!["OPERADOR"] = owner; await assert.rejects(start(s), InternalServerError); assertNoEffects(f);
});
test("start_chats_as_admin still permits the loyal actor and attributes chat to supervision", async (f, s) => {
	f.parameters.push({ instance: "tenant-a", scope: "INSTANCE", key: "start_chats_as_admin", value: "true" });
	await start(s); assert.equal(f.chats[0]!["userId"], -1); assert.ok(f.effects.includes("provider-template"));
});
test("direct template without a chat cannot bypass the loyal owner", async (f, s) => {
	deniedOwner(f); await assert.rejects(send(s), UnauthorizedError); assertNoEffects(f);
});
test("active chat transferred to the actor permits template despite former CRM loyalty", async (f, s) => {
	deniedOwner(f); f.chats.push(chat()); f.crmError = new Error("No CRM required for an authorized transferred chat");
	await send(s, session, 100); assert.ok(f.effects.includes("provider-template")); assert.equal(f.crmReads.length, 0);
});
for (const overrides of [{ userId: 99 }, { instance: "tenant-b" }, { contactId: 999 }, { isFinished: true }])
	test(`supplied foreign/finished/unowned chat cannot be a loyalty fallback ${JSON.stringify(overrides)}`, async (f, s) => {
		f.chats.push(chat(overrides)); await assert.rejects(send(s, session, 100)); assertNoEffects(f);
	});
for (const to of ["5511999990000@g.us", "junk5511999990000", "5511999990000@lid", "5511999990000@evil.example"])
	test(`altered destination is refused: ${to}`, async (f, s) => {
		f.chats.push(chat()); await assert.rejects(s.whatsapp.sendTemplate(session, 7, to, template, 100, 42), BadRequestError); assertNoEffects(f);
	});
test("formatted UI phone and recognized phone JID remain compatible", async (f, s) => {
	f.chats.push(chat()); for (const to of ["+55 (11) 99999-0000", "5511999990000@c.us", "5511999990000@s.whatsapp.net"])
		await s.authorization.assertCanSend(session, 7, 42, 100, to);
	assertNoEffects(f);
});
test("known LID accepts its explicit ID and legacy sender alias, not a group alias", async (f, s) => {
	f.contact["whatsappId"] = "123456789@lid"; f.contact["phone"] = null; f.chats.push(chat());
	for (const to of ["123456789@lid", "123456789"]) await s.authorization.assertCanSend(session, 7, 42, 100, to);
	await assert.rejects(s.authorization.assertCanSend(session, 7, 42, 100, "123456789@g.us"), BadRequestError); assertNoEffects(f);
	await assert.rejects(s.authorization.assertCanSend(session, 7, 42, 100, "123456789@c.us"), BadRequestError); assertNoEffects(f);
});
test("foreign channel is rejected before provider effects", async (f, s) => {
	f.clientInstance = "tenant-b"; await assert.rejects(send(s), BadRequestError); assertNoEffects(f);
});
test("legacy normal send cannot bypass the loyal owner without a chat", async (f, s) => {
	deniedOwner(f); await assert.rejects(s.whatsapp.sendMessage(session, 7, "5511999990000", { contactId: 42, text: "fixture" }), UnauthorizedError); assertNoEffects(f);
});
test("durable normal send cannot persist or prepare files when loyalty denies", async (f, s) => {
	deniedOwner(f); await assert.rejects(s.operator.submit(session, 7, "5511999990000", { contactId: 42, text: "fixture", fileId: 3 }, "fixture-key"), UnauthorizedError); assertNoEffects(f);
});
test("durable send in a legitimately transferred chat keeps working", async (f, s) => {
	deniedOwner(f); f.chats.push(chat()); await s.operator.submit(session, 7, "5511999990000", { contactId: 42, chatId: 100, text: "fixture" }, "fixture-key");
	assert.ok(f.effects.includes("enqueue")); assert.equal(f.crmReads.length, 0);
});
test("idempotent replay returns recorded attempt before the policy or CRM is consulted", async (f, s) => {
	const requestModule: typeof import("../utils/operator-send-request") = require("../utils/operator-send-request");
	const data = { contactId: 42, text: "fixture" };
	const hash = requestModule.hashOperatorSendRequest(requestModule.normalizeOperatorSendRequest(7, "5511999990000", data));
	f.replay = { message: { id: 200 }, job: { payloadHash: hash, clientId: 7 } }; f.flagError = new Error("No flag lookup allowed");
	const result = await s.operator.submit(session, 7, "5511999990000", data, "fixture-key");
	assert.equal(result.created, false); assert.equal(f.flagReads.length, 0); assertNoEffects(f);
});
test("direct template controller preserves HTTP 403", async (f, s) => {
	deniedOwner(f); let status = 0;
	const response = { status(code: number) { status = code; return this; }, send() {}, json() {} };
	await (s.controller as any).sendTemplate({ session, params: { clientId: "7" }, body: { to: "5511999990000", contactId: 42, data: template } }, response);
	assert.equal(status, 403); assertNoEffects(f);
});
test("normal message controller preserves HTTP 403", async (f, s) => {
	deniedOwner(f); let status = 0;
	const response = { locals: {}, status(code: number) { status = code; return this; }, send() {}, json() {} };
	await (s.messagesController as any).sendMessage({ session, params: { clientId: "7" }, headers: {}, body: { to: "5511999990000", contactId: 42, text: "fixture" } }, response);
	assert.equal(status, 403); assertNoEffects(f);
});
test("operator cannot claim another operator's chat through transfer and then send", async (f, s) => {
	f.chats.push(chat({ userId: 99 }));
	await assert.rejects(s.chats.transferAttendance("fixture-token", session, 100, 12), UnauthorizedError);
	await assert.rejects(send(s, session, 100), UnauthorizedError); assertNoEffects(f);
});
for (const overrides of [{ instance: "tenant-b" }, { isFinished: true }]) test(`transfer rejects foreign/finished origin ${JSON.stringify(overrides)}`, async (f, s) => {
	f.chats.push(chat(overrides)); await assert.rejects(s.chats.transferAttendance("fixture-token", session, 100, 55), NotFoundError); assertNoEffects(f);
});
test("own chat transfer validates target and conditionally updates the original owner", async (f, s) => {
	f.chats.push(chat()); await s.chats.transferAttendance("fixture-token", session, 100, 55);
	assert.equal(f.chats[0]!["userId"], 55); assert.ok(f.effects.includes("transfer-history"));
	assert.deepEqual(f.transferChecks, [{ id: 100, instance: "tenant-a", isFinished: false, userId: 12 }]);
});
test("ADMIN may transfer another operator's active chat", async (f, s) => {
	f.chats.push(chat({ userId: 99 })); await s.chats.transferAttendance("fixture-token", { ...session, role: "ADMIN" }, 100, 55);
	assert.equal(f.chats[0]!["userId"], 55);
});
for (const target of [0, -1, 1.5, 999]) test(`transfer rejects invalid/missing target ${target}`, async (f, s) => {
	f.chats.push(chat()); await assert.rejects(s.chats.transferAttendance("fixture-token", session, 100, target), BadRequestError); assertNoEffects(f);
});
test("transfer fails closed on CRM destination lookup error", async (f, s) => {
	f.chats.push(chat()); f.crmError = new Error("CRM unavailable");
	await assert.rejects(s.chats.transferAttendance("fixture-token", session, 100, 55), /CRM unavailable/); assertNoEffects(f);
});
test("transfer compare-and-swap rejects an owner changed concurrently", async (f, s) => {
	f.chats.push(chat()); f.beforeTransferUpdate = () => { f.chats[0]!["userId"] = 99; };
	await assert.rejects(s.chats.transferAttendance("fixture-token", session, 100, 55), ConflictError);
	assert.equal(f.chats[0]!["userId"], 99); assertNoEffects(f);
});
test("disabled flag preserves the existing transfer path without CRM target lookup", async (f, s) => {
	f.parameters = []; f.chats.push(chat()); f.crmError = new Error("No CRM expected");
	await s.chats.transferAttendance("fixture-token", session, 100, 55); assert.equal(f.transferChecks.length, 0); assert.ok(f.effects.includes("update-chat"));
});

async function run() {
	for (const [name, execute] of cases) {
		try { const f = world(); await withWorld(f, (s) => execute(f, s)); }
		catch (error) { throw new Error(`manual-chat-authorization: ${name}`, { cause: error }); }
	}
	console.log(`manual-chat-authorization: ${cases.length} cases passed (real start/template/manual-send paths, instance flag, latest loyalty, transferred chats, destination integrity and zero denied effects)`);
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
