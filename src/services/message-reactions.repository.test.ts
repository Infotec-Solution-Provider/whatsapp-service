import assert from "node:assert/strict";
import { MessageReaction, Prisma, PrismaClient } from "@prisma/client";
import { ApplyMessageReactionInput, MessageReactionsRepository } from "./message-reactions.repository";

type Query = Record<string, any>;

function matches(row: MessageReaction, where: Query): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") return (value as Query[]).some((branch) => matches(row, branch));
		if (key === "instance_clientId_targetMessageId_actorId") {
			assert.deepEqual(Object.keys(value).sort(), ["actorId", "clientId", "instance", "targetMessageId"]);
			return matches(row, value);
		}
		const current = (row as unknown as Query)[key];
		if (value instanceof Date) return current instanceof Date && current.getTime() === value.getTime();
		if (value !== null && typeof value === "object") {
			return Object.entries(value).every(([operator, comparison]: [string, any]) => {
				if (operator === "lt") return current < comparison;
				if (operator === "not") return current !== comparison;
				throw new Error(`Unsupported query operator ${operator}`);
			});
		}
		return current === value;
	});
}

function fixture() {
	const rows: MessageReaction[] = [];
	let queries = 0;
	let beforeUpdate: (() => Promise<void>) | null = null;
	const find = (args: Query) => rows.find((row) => matches(row, args["where"]));
	const client = {
		messageReaction: {
			findUnique: async (args: Query) => structuredClone(find(args) ?? null),
			findUniqueOrThrow: async (args: Query) => { const row = find(args); assert.ok(row); return structuredClone(row); },
			create: async (args: Query) => {
				const data = args["data"];
				if (rows.some((row) => row.instance === data.instance && row.clientId === data.clientId && row.targetMessageId === data.targetMessageId && row.actorId === data.actorId)) {
					throw new Prisma.PrismaClientKnownRequestError("Duplicate actor/target", { code: "P2002", clientVersion: "test" });
				}
				const row: MessageReaction = { id: `reaction-${rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(data) };
				rows.push(row);
				return structuredClone(row);
			},
			updateMany: async (args: Query) => {
				if (beforeUpdate) { const hook = beforeUpdate; beforeUpdate = null; await hook(); }
				const targets = rows.filter((row) => matches(row, args["where"]));
				for (const row of targets) Object.assign(row, structuredClone(args["data"]));
				return { count: targets.length };
			},
			findMany: async (args: Query) => {
				queries++;
				return structuredClone(rows.filter((row) => matches(row, args["where"])))
					.sort((a, b) => a.reactedAt.getTime() - b.reactedAt.getTime() || a.actorId.localeCompare(b.actorId));
			},
		},
	};
	return {
		repository: new MessageReactionsRepository(client as unknown as PrismaClient), rows,
		queries: () => queries,
		beforeUpdate: (hook: () => Promise<void>) => { beforeUpdate = hook; },
	};
}

function event(overrides: Partial<ApplyMessageReactionInput> = {}): ApplyMessageReactionInput {
	return {
		instance: "tenant-a", clientId: 1, targetMessageId: "provider-message-a", actorId: "551199999999@s.whatsapp.net",
		fromMe: false, emoji: "👍", reactedAt: new Date(1_000), sourceEventId: "reaction-event-1", ...overrides,
	};
}

const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => cases.push([name, run]);

test("reaction arriving before its message persists and hydrates after reload", async () => {
	const f = fixture();
	assert.equal((await f.repository.apply(event())).applied, true);
	const snapshot = await f.repository.hydrate("tenant-a", [{ domain: "WPP", messageId: 55, clientId: 1, targetMessageIds: ["provider-message-a"] }]);
	assert.deepEqual(snapshot.get("WPP:55"), {
		reactions: [{ actorId: "551199999999@s.whatsapp.net", emoji: "👍", fromMe: false, reactedAt: new Date(1_000).toISOString() }],
		reactionsUpdatedAt: new Date(1_000).toISOString(),
	});
});

test("replacement and removal retain one actor row and ignore stale replay", async () => {
	const f = fixture();
	await f.repository.apply(event());
	await f.repository.apply(event({ emoji: "❤️", reactedAt: new Date(2_000) }));
	await f.repository.apply(event({ emoji: "", reactedAt: new Date(3_000) }));
	assert.equal((await f.repository.apply(event())).applied, false);
	assert.equal(f.rows.length, 1);
	assert.equal(f.rows[0]!.emoji, "");
	assert.equal(f.rows[0]!.reactedAt.getTime(), 3_000);
	assert.equal((await f.repository.listForTarget(event())).length, 0);
	assert.equal((await f.repository.listForTarget(event(), true)).length, 1);
});

test("equal timestamp removal wins in both arrival orders without resurrection", async () => {
	for (const firstRemoved of [false, true]) {
		const f = fixture();
		await f.repository.apply(event({ emoji: firstRemoved ? "" : "👍" }));
		await f.repository.apply(event({ emoji: firstRemoved ? "👍" : "" }));
		assert.equal(f.rows[0]!.emoji, "");
		assert.equal((await f.repository.apply(event())).applied, false);
		assert.equal((await f.repository.apply(event({ emoji: "" }))).applied, false);
	}
});

test("concurrent first events converge on the latest timestamp with one unique row", async () => {
	const f = fixture();
	await Promise.all([
		f.repository.apply(event({ emoji: "❤️", reactedAt: new Date(5_000) })),
		f.repository.apply(event({ emoji: "👍", reactedAt: new Date(2_000) })),
		f.repository.apply(event({ emoji: "", reactedAt: new Date(7_000) })),
	]);
	assert.equal(f.rows.length, 1);
	assert.equal(f.rows[0]!.emoji, "");
	assert.equal(f.rows[0]!.reactedAt.getTime(), 7_000);
});

test("a newer event between read and update cannot be overwritten by stale timestamp", async () => {
	const f = fixture();
	await f.repository.apply(event());
	f.beforeUpdate(async () => { await f.repository.apply(event({ emoji: "", reactedAt: new Date(9_000) })); });
	const older = await f.repository.apply(event({ emoji: "❤️", reactedAt: new Date(5_000) }));
	assert.equal(older.applied, false);
	assert.equal(older.reaction.emoji, "");
	assert.equal(older.reaction.reactedAt.getTime(), 9_000);
});

test("tenants and provider clients are isolated even with identical target/actor IDs", async () => {
	const f = fixture();
	await f.repository.apply(event());
	await f.repository.apply(event({ instance: "tenant-b", emoji: "❤️" }));
	await f.repository.apply(event({ clientId: 2, emoji: "😂" }));
	assert.equal(f.rows.length, 3);
	assert.equal((await f.repository.listForTarget(event()))[0]!.emoji, "👍");
	const snapshot = await f.repository.hydrate("tenant-b", [{ domain: "WPP", messageId: 1, clientId: 1, targetMessageIds: ["provider-message-a"] }]);
	assert.equal(snapshot.get("WPP:1")!.reactions[0]!.emoji, "❤️");
});

test("self canonicalization joins outgoing reaction and incoming own-device echo", async () => {
	const f = fixture();
	await f.repository.apply(event({ fromMe: true, actorId: "551188888888@s.whatsapp.net" }));
	await f.repository.apply(event({ fromMe: true, actorId: "123456789@lid", emoji: "❤️", reactedAt: new Date(2_000) }));
	assert.equal(f.rows.length, 1);
	assert.equal(f.rows[0]!.actorId, "self");
	assert.equal(f.rows[0]!.emoji, "❤️");
});

test("WPP and INTERNAL local IDs do not collide during hydration", async () => {
	const f = fixture();
	await f.repository.apply(event());
	await f.repository.apply(event({ targetMessageId: "provider-group-message", emoji: "❤️" }));
	const snapshot = await f.repository.hydrate("tenant-a", [
		{ domain: "WPP", messageId: 7, clientId: 1, targetMessageIds: ["provider-message-a"] },
		{ domain: "INTERNAL", messageId: 7, clientId: 1, targetMessageIds: ["provider-group-message"] },
		{ domain: "WPP", messageId: 8, clientId: null, targetMessageIds: [] },
	]);
	assert.equal(snapshot.get("WPP:7")!.reactions[0]!.emoji, "👍");
	assert.equal(snapshot.get("INTERNAL:7")!.reactions[0]!.emoji, "❤️");
	assert.deepEqual(snapshot.get("WPP:8"), { reactions: [], reactionsUpdatedAt: null });
});

test("provider aliases merge actors by event time and preserve removal watermark", async () => {
	const f = fixture();
	await f.repository.apply(event());
	await f.repository.apply(event({ targetMessageId: "serialized-provider-id", emoji: "", reactedAt: new Date(5_000) }));
	await f.repository.apply(event({ actorId: "second-actor", emoji: "❤️", reactedAt: new Date(2_000) }));
	const snapshot = (await f.repository.hydrate("tenant-a", [{ domain: "WPP", messageId: 1, clientId: 1, targetMessageIds: ["provider-message-a", "serialized-provider-id"] }])).get("WPP:1")!;
	assert.equal(snapshot.reactions.length, 1);
	assert.equal(snapshot.reactions[0]!.actorId, "second-actor");
	assert.equal(snapshot.reactionsUpdatedAt, new Date(5_000).toISOString());
});

test("tombstone-only snapshots expose empty reactions and the deletion timestamp", async () => {
	const f = fixture();
	await f.repository.apply(event({ emoji: "", reactedAt: new Date(0) }));
	const snapshot = (await f.repository.hydrate("tenant-a", [{ domain: "INTERNAL", messageId: 1, clientId: 1, targetMessageIds: ["provider-message-a"] }])).get("INTERNAL:1")!;
	assert.deepEqual(snapshot.reactions, []);
	assert.equal(snapshot.reactionsUpdatedAt, new Date(0).toISOString());
	assert.equal(f.rows.length, 1);
});

test("history hydration batches provider targets instead of querying per message", async () => {
	const f = fixture();
	const references = Array.from({ length: 501 }, (_, i) => ({ domain: "WPP" as const, messageId: i, clientId: 1, targetMessageIds: [`target-${i}`] }));
	const snapshots = await f.repository.hydrate("tenant-a", references);
	assert.equal(snapshots.size, 501);
	assert.equal(f.queries(), 3);
});

async function run(): Promise<void> {
	for (const [name, execute] of cases) { await execute(); console.log(`PASS ${name}`); }
	console.log(`${cases.length} message reaction repository tests passed (isolated; no live database).`);
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
