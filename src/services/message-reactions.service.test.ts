import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { SessionData } from "../sdk-local";
import type { MessageReactionEvent } from "../types/remote-client.types";
import type { SendReactionOptions, SendReactionResult } from "../types/whatsapp-instance.types";
import { canonicalReactionTarget, MessageReactionError } from "../utils/message-reaction";
import type { MessageReactionsRepository } from "./message-reactions.repository";
import { MessageReactionsService, MessageReactionUpdate } from "./message-reactions.service";
import type { ApplyMessageReactionInput, MessageReactionReference, MessageReactionSnapshot } from "./message-reactions.types";

type Row = Record<string, any>;
const at = 1_788_888_000_123;
const session: SessionData = { instance: "tenant-a", userId: 7, sectorId: 2, role: "USER", name: "Operator" };

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") return (value as Row[]).some((condition) => matches(row, condition));
		if (value !== null && typeof value === "object") {
			if ("in" in value) return value.in.includes(row[key]);
			if ("some" in value) return Array.isArray(row[key]) && row[key].some((entry: Row) => matches(entry, value.some));
			return row[key] !== null && typeof row[key] === "object" && matches(row[key], value);
		}
		return row[key] === value;
	});
}

function inbound(overrides: Partial<MessageReactionEvent> = {}): MessageReactionEvent {
	return {
		type: "message-reaction", clientId: 1, targetMessageId: "MSG-A", reaction: "👍", removed: false,
		isGroup: false, groupId: null, actorId: "551199999999@c.us", fromMe: false,
		timestamp: at, reactionId: "REACTION-A", ...overrides,
	};
}

function fixture() {
	const calls: string[] = [];
	const queries: Array<{ table: string; where: Row }> = [];
	const applied: ApplyMessageReactionInput[] = [];
	const stored = new Map<string, ApplyMessageReactionInput>();
	const emitted: Array<{ room: string; data: MessageReactionUpdate }> = [];
	const sent: SendReactionOptions[] = [];
	const groupChecks: Array<{ instance: string; fallback: boolean }> = [];
	const wppMessages: Row[] = [{
		id: 7, instance: "tenant-a", clientId: 1, chatId: 10, from: "me:account", to: "551199999999",
		wwebjsId: "true_551199999999@c.us_MSG-A", wwebjsIdStanza: "MSG-A",
	}];
	const wppChats: Row[] = [{ id: 10, instance: "tenant-a", isFinished: false, sectorId: 2 }];
	const internalMessages: Row[] = [{
		id: 7, instance: "tenant-a", clientId: 1, internalChatId: 20,
		wwebjsId: "false_123456@g.us_GROUP-A", wwebjsIdStanza: "GROUP-A",
		chat: { id: 20, instance: "tenant-a", isFinished: false, wppGroupId: "123456@g.us", participants: [{ userId: 7 }] },
	}];
	const clients: Row[] = [{ id: 1, instance: "tenant-a", isActive: true, type: "REMOTE" }];
	const state = {
		groupsEnabled: true, emitFails: false, applyFails: false, hydrateFails: false, providerFails: false,
		providerAvailable: true, providerInstance: "tenant-a", unsupported: false,
		invalidReceipt: false, receipt: undefined as unknown,
	};
	const table = (name: string, rows: Row[]) => ({
		findFirst: async ({ where }: { where: Row }) => {
			calls.push(`lookup:${name}`); queries.push({ table: name, where: structuredClone(where) });
			return structuredClone(rows.find((row) => matches(row, where)) ?? null);
		},
	});
	const db = {
		wppMessage: table("wpp", wppMessages), internalMessage: table("internal", internalMessages),
		wppChat: table("chat", wppChats), wppClient: table("client", clients),
	};
	const repository = {
		apply: async (input: ApplyMessageReactionInput) => {
			calls.push("persist");
			if (state.applyFails) throw new Error("simulated reaction persistence unavailable");
			applied.push(input);
			stored.set(JSON.stringify([input.instance, input.clientId, input.targetMessageId, input.actorId]), input);
			return { applied: true, reaction: input };
		},
		hydrate: async (instance: string, references: MessageReactionReference[]) => {
			calls.push("hydrate");
			if (state.hydrateFails) throw new Error("simulated reaction snapshot unavailable");
			const snapshots = new Map<string, MessageReactionSnapshot>();
			for (const reference of references) {
				const rows = [...stored.values()].filter((row) => row.instance === instance && row.clientId === reference.clientId && reference.targetMessageIds.includes(row.targetMessageId));
				snapshots.set(`${reference.domain}:${reference.messageId}`, {
					reactions: rows.filter((row) => row.emoji !== "").map((row) => ({
						actorId: row.actorId, emoji: row.emoji, fromMe: row.fromMe, reactedAt: row.reactedAt.toISOString(),
					})),
					reactionsUpdatedAt: rows.length ? new Date(Math.max(...rows.map((row) => row.reactedAt.getTime()))).toISOString() : null,
				});
			}
			return snapshots;
		},
	};
	const service = new MessageReactionsService(
		db as unknown as PrismaClient,
		repository as unknown as MessageReactionsRepository,
		async (room, data) => {
			calls.push("emit");
			if (state.emitFails) throw new Error("simulated socket unavailable");
			emitted.push({ room, data });
		},
		async (instance, fallback) => { groupChecks.push({ instance, fallback }); return state.groupsEnabled; },
	);
	const getClient = (id: number) => !state.providerAvailable || id !== 1 ? undefined : {
		id: 1, instance: state.providerInstance,
		...(state.unsupported ? {} : { sendReaction: async (options: SendReactionOptions): Promise<SendReactionResult> => {
			calls.push("provider"); sent.push(options);
			if (state.providerFails) throw new Error("simulated lost provider response");
			if (state.invalidReceipt) return state.receipt as SendReactionResult;
			return {
				contractVersion: 1, status: "SENT", targetMessageId: canonicalReactionTarget(options.messageId),
				reaction: options.emoji, removed: options.emoji === "", fromMe: true, timestamp: at, reactionId: "REACTION-OUT",
			};
		} }),
	};
	return { service, state, calls, queries, applied, emitted, sent, groupChecks, wppMessages, wppChats, internalMessages, clients, getClient };
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);
const errorIs = (status: number, code?: string) => (error: unknown) => error instanceof MessageReactionError && error.statusCode === status && (code === undefined || error.code === code);

test("inbound persists before target lookup and survives a target not yet inserted", async () => {
	const f = fixture();
	f.wppMessages.length = 0;
	await f.service.receive({ id: 1, instance: "tenant-a" }, inbound());
	assert.deepEqual(f.calls, ["persist", "lookup:wpp"]);
	assert.equal(f.applied.length, 1);
	assert.equal(f.applied[0]!.actorId, "551199999999@s.whatsapp.net");
	assert.equal(f.emitted.length, 0);
	const hydrated = await f.service.hydrate("tenant-a", [{ id: 99, instance: "tenant-a", clientId: 1, wwebjsIdStanza: "MSG-A" }]);
	assert.equal(hydrated[0]!.reactions[0]!.emoji, "👍");
});

test("inbound rejects mismatched channel before persistence and scopes target lookup by tenant/client", async () => {
	const f = fixture();
	await assert.rejects(f.service.receive({ id: 1, instance: "tenant-a" }, inbound({ clientId: 2 })), errorIs(400));
	assert.equal(f.applied.length, 0);
	f.wppMessages[0]!["instance"] = "tenant-b";
	await f.service.receive({ id: 1, instance: "tenant-a" }, inbound());
	assert.equal(f.applied[0]!.instance, "tenant-a");
	assert.equal(f.emitted.length, 0);
	assert.equal(f.queries[0]!.where["instance"], "tenant-a");
	assert.equal(f.queries[0]!.where["clientId"], 1);
});

test("inbound WPP and INTERNAL events with equal local message IDs publish distinct domains/rooms", async () => {
	const f = fixture();
	await f.service.receive({ id: 1, instance: "tenant-a" }, inbound());
	await f.service.receive({ id: 1, instance: "tenant-a" }, inbound({ isGroup: true, groupId: "123456@g.us", targetMessageId: "GROUP-A", reaction: "❤️" }));
	assert.deepEqual(f.emitted.map(({ room, data }) => [room, data.messageType, data.messageId]), [
		["tenant-a:chat:10", "wpp", 7], ["tenant-a:internal-chat:20", "internal", 7],
	]);
	assert.equal(f.emitted[0]!.data.reactions[0]!.emoji, "👍");
	assert.equal(f.emitted[1]!.data.reactions[0]!.emoji, "❤️");
});

test("empty or removed inbound reactions persist tombstones and emit empty snapshots", async () => {
	for (const event of [inbound({ reaction: "" }), inbound({ reaction: "👍", removed: true })]) {
		const f = fixture();
		await f.service.receive({ id: 1, instance: "tenant-a" }, event);
		assert.equal(f.applied[0]!.emoji, "");
		assert.deepEqual(f.emitted[0]!.data.reactions, []);
		assert.equal(f.emitted[0]!.data.reactionsUpdatedAt, new Date(at).toISOString());
	}
});

test("group inbound obeys sync flag and group identity before looking up target", async () => {
	const disabled = fixture(); disabled.state.groupsEnabled = false;
	await disabled.service.receive({ id: 1, instance: "tenant-a" }, inbound({ isGroup: true, groupId: "123456@g.us", targetMessageId: "GROUP-A" }), false);
	assert.equal(disabled.applied.length, 0);
	assert.deepEqual(disabled.groupChecks, [{ instance: "tenant-a", fallback: false }]);
	const otherGroup = fixture();
	await otherGroup.service.receive({ id: 1, instance: "tenant-a" }, inbound({ isGroup: true, groupId: "different@g.us", targetMessageId: "GROUP-A" }));
	assert.equal(otherGroup.applied.length, 1, "event remains durable even when target group is not yet known");
	assert.equal(otherGroup.emitted.length, 0);
});

test("outgoing WPP commits only after provider receipt and sends one canonical self reaction", async () => {
	const f = fixture();
	const result = await f.service.sendWpp(session, 1, 7, "❤️", f.getClient);
	assert.equal(f.sent.length, 1);
	assert.ok(f.calls.indexOf("provider") < f.calls.indexOf("persist"));
	assert.deepEqual(f.sent[0], { to: "551199999999", messageId: "MSG-A", emoji: "❤️", isGroup: false });
	assert.equal(f.applied[0]!.actorId, "self");
	assert.equal(result.reactions[0]!.fromMe, true);
	assert.equal(result.messageType, "wpp");
});

test("outgoing empty emoji removes the current user's reaction", async () => {
	const f = fixture();
	const result = await f.service.sendWpp(session, 1, 7, "", f.getClient);
	assert.equal(f.sent[0]!.emoji, "");
	assert.equal(f.applied[0]!.emoji, "");
	assert.deepEqual(result.reactions, []);
	assert.equal(result.reactionsUpdatedAt, new Date(at).toISOString());
});

test("provider failure is uncertain, is never retried, and does not commit false success", async () => {
	const f = fixture(); f.state.providerFails = true;
	await assert.rejects(f.service.sendWpp(session, 1, 7, "👍", f.getClient), errorIs(502, "REACTION_DELIVERY_UNKNOWN"));
	assert.equal(f.sent.length, 1);
	assert.equal(f.applied.length, 0);
	assert.equal(f.emitted.length, 0);
});

test("malformed or mismatched provider receipts are rejected without persistence/retry", async () => {
	const valid = { contractVersion: 1, status: "SENT", targetMessageId: "MSG-A", reaction: "👍", removed: false, fromMe: true, timestamp: at, reactionId: "REACTION-OUT" };
	const invalid = [undefined, null, {}, { ...valid, contractVersion: 2 }, { ...valid, status: "PENDING" },
		{ ...valid, targetMessageId: "wrong-target" }, { ...valid, reaction: "❤️" }, { ...valid, fromMe: false },
		{ ...valid, removed: true }, { ...valid, timestamp: NaN }, { ...valid, timestamp: 0 }, { ...valid, reactionId: "" }];
	for (const receipt of invalid) {
		const f = fixture(); f.state.invalidReceipt = true; f.state.receipt = receipt;
		await assert.rejects(f.service.sendWpp(session, 1, 7, "👍", f.getClient), errorIs(502, "REACTION_DELIVERY_UNKNOWN"));
		assert.equal(f.sent.length, 1);
		assert.equal(f.applied.length, 0);
		assert.equal(f.emitted.length, 0);
	}
});

test("socket failure after a persisted provider success does not fail the HTTP result", async () => {
	const f = fixture(); f.state.emitFails = true;
	const result = await f.service.sendWpp(session, 1, 7, "👍", f.getClient);
	assert.equal(f.sent.length, 1);
	assert.equal(f.applied.length, 1);
	assert.equal(result.reactions[0]!.emoji, "👍");
});

test("persistence/snapshot failure after provider acceptance reports UNKNOWN without redispatch", async () => {
	for (const failure of ["applyFails", "hydrateFails"] as const) {
		const f = fixture(); f.state[failure] = true;
		await assert.rejects(f.service.sendWpp(session, 1, 7, "👍", f.getClient), errorIs(502, "REACTION_DELIVERY_UNKNOWN"));
		assert.equal(f.sent.length, 1);
		assert.equal(f.emitted.length, 0);
	}
});

test("outgoing WPP validates tenant/channel/active chat before provider dispatch", async () => {
	const foreign = fixture(); foreign.wppMessages[0]!["instance"] = "tenant-b";
	await assert.rejects(foreign.service.sendWpp(session, 1, 7, "👍", foreign.getClient), errorIs(404));
	const wrongChannel = fixture();
	await assert.rejects(wrongChannel.service.sendWpp(session, 2, 7, "👍", wrongChannel.getClient), errorIs(404));
	const finished = fixture(); finished.wppChats[0]!["isFinished"] = true;
	await assert.rejects(finished.service.sendWpp(session, 1, 7, "👍", finished.getClient), errorIs(403));
	for (const f of [foreign, wrongChannel, finished]) assert.equal(f.sent.length, 0);
});

test("internal outgoing requires group membership and enabled WhatsApp synchronization", async () => {
	const denied = fixture(); denied.internalMessages[0]!["chat"].participants = [{ userId: 99 }];
	await assert.rejects(denied.service.sendInternal(session, 7, "👍", denied.getClient), errorIs(404));
	assert.equal(denied.sent.length, 0);
	const disabled = fixture(); disabled.state.groupsEnabled = false;
	await assert.rejects(disabled.service.sendInternal(session, 7, "👍", disabled.getClient), errorIs(409));
	assert.equal(disabled.sent.length, 0);
	const allowed = fixture();
	const result = await allowed.service.sendInternal(session, 7, "👍", allowed.getClient);
	assert.equal(result.messageType, "internal");
	assert.deepEqual(allowed.sent[0], { to: "123456@g.us", messageId: "GROUP-A", emoji: "👍", isGroup: true });
	assert.equal(allowed.emitted[0]!.room, "tenant-a:internal-chat:20");
});

test("unsupported or foreign providers and pending target IDs cannot dispatch", async () => {
	const unsupported = fixture(); unsupported.state.unsupported = true;
	await assert.rejects(unsupported.service.sendWpp(session, 1, 7, "👍", unsupported.getClient), errorIs(501, "REACTION_UNSUPPORTED"));
	const foreign = fixture(); foreign.state.providerInstance = "tenant-b";
	await assert.rejects(foreign.service.sendWpp(session, 1, 7, "👍", foreign.getClient), errorIs(503));
	const wrongChannel = fixture();
	await assert.rejects(wrongChannel.service.sendWpp(session, 1, 7, "👍", (id) => ({ ...wrongChannel.getClient(id)!, id: 2 })), errorIs(503));
	const pending = fixture(); pending.wppMessages[0]!["wwebjsId"] = null; pending.wppMessages[0]!["wwebjsIdStanza"] = null;
	await assert.rejects(pending.service.sendWpp(session, 1, 7, "👍", pending.getClient), errorIs(409));
	for (const f of [unsupported, foreign, wrongChannel, pending]) assert.equal(f.sent.length, 0);
});

test("WWEBJS sends serialized target ID while persistence/hydration use canonical stanza", async () => {
	const f = fixture(); f.clients[0]!["type"] = "WWEBJS";
	await f.service.sendWpp(session, 1, 7, "👍", f.getClient);
	assert.equal(f.sent[0]!.messageId, "true_551199999999@c.us_MSG-A");
	assert.equal(f.applied[0]!.targetMessageId, "MSG-A");
});

test("hydration does not copy reactions to a foreign tenant sharing the local message ID", async () => {
	const f = fixture();
	await f.service.receive({ id: 1, instance: "tenant-a" }, inbound());
	const hydrated = await f.service.hydrate("tenant-a", [
		{ id: 7, instance: "tenant-a", clientId: 1, wwebjsIdStanza: "MSG-A" },
		{ id: 7, instance: "tenant-b", clientId: 1, wwebjsIdStanza: "MSG-A" },
	]);
	assert.equal(hydrated[0]!.reactions.length, 1);
	assert.deepEqual(hydrated[1]!.reactions, []);
	assert.equal(hydrated[1]!.reactionsUpdatedAt, null);
});

async function run(): Promise<void> {
	for (const [name, execute] of tests) { await execute(); console.log(`PASS ${name}`); }
	console.log(`${tests.length} message reaction service tests passed (isolated; no live database/provider/socket).`);
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
