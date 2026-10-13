import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { collectMessageHealth, MessageHealthIssue } from "./channel-message-health";
import { ChannelMessageHealthReader } from "./channel-message-health.reader";
import { sendFailureCategory } from "../utils/send-failure-category";

const now = Date.parse("2026-10-09T12:00:00Z");
const at = (ago: number) => new Date(now - ago * 1000);
const issue = (patch: Partial<MessageHealthIssue> = {}): MessageHealthIssue => ({
	clientId: 1,
	key: "message:1",
	direction: "SEND",
	status: "FAILED",
	startedAt: at(60),
	occurredAt: at(30),
	category: "CHANNEL",
	...patch
});
const health = collectMessageHealth(
	[1, 2],
	[
		issue(),
		issue(),
		issue({ key: "message:2", category: "MESSAGE" }),
		issue({ key: "message:3", category: "UNCLASSIFIED" }),
		issue({ key: "message:4", status: "UNKNOWN" }),
		issue({ key: "old", occurredAt: at(901) }),
		issue({ key: "future", occurredAt: at(-1) }),
		issue({ key: "receive", direction: "RECEIVE" }),
		issue({ key: "receive", direction: "RECEIVE" }),
		issue({ key: "receive", direction: "RECEIVE", status: "PENDING", startedAt: at(1200) }),
		issue({ key: "send-pending", status: "PENDING", startedAt: at(400) }),
		issue({ key: "normal", status: "PENDING", startedAt: at(60) }),
		issue({ clientId: 999 })
	],
	now
).get(1)!;
assert.equal(health.sendFailed, 3);
assert.equal(health.sendTechnicalFailed, 1);
assert.equal(health.sendMessageFailed, 1);
assert.equal(health.sendUnclassifiedFailed, 1);
assert.equal(health.sendUnknown, 1);
assert.equal(health.receiveFailed, 1, "retries/stages for a single message do not inflate failure counts");
assert.equal(health.receiveDelayed, 1, "active backlog older than 15 minutes remains visible");
assert.equal(health.sendDelayed, 1);
assert.equal(health.oldestReceivePendingAt, at(1200).toISOString());
assert.equal(sendFailureCategory("Connection Closed"), "CHANNEL");
assert.equal(sendFailureCategory("Invalid recipient"), "MESSAGE");
assert.equal(sendFailureCategory("O provedor confirmou falha no envio."), "UNCLASSIFIED");

async function readerChecks() {
	const calls: { source: string; args: Record<string, any> }[] = [];
	let time = now;
	let fail = false;
	let overflow = false;
	const messages = [
		{
			id: 1,
			clientId: 1,
			status: "ERROR",
			sentAt: at(1200),
			operatorOutbound: { completedAt: at(10), error: "generic", providerOutcome: { failureCategory: "CHANNEL" } }
		},
		{ id: 2, clientId: 1, status: "UNKNOWN", sentAt: at(60), operatorOutbound: null },
		{ id: 3, clientId: 2, status: "ERROR", sentAt: at(60), operatorOutbound: null }
	];
	const queues = [
		{
			id: "q",
			clientId: 1,
			messageId: 99,
			status: "PENDING",
			retryCount: 3059,
			createdAt: at(1200),
			updatedAt: at(5)
		}
	];
	const db: Record<string, unknown> = Object.fromEntries(
		["wppMessage", "remoteInboundEventInbox", "wppMessageProcessingQueue"].map((source) => [
			source,
			{
				findMany: async (args: Record<string, any>) => {
					calls.push({ source, args });
					if (fail) throw new Error("database unavailable");
					if (source === "wppMessage")
						return overflow ? Array.from({ length: 1001 }, (_, id) => ({ ...messages[0], id })) : messages;
					return queues;
				}
			}
		])
	);
	db["$queryRaw"] = async (args: { values: unknown[]; sql: string }) => {
		calls.push({ source: "internal", args });
		if (fail) throw new Error("database unavailable");
		return [
			{
				id: "i1",
				clientId: 1n,
				internalMessageId: 7,
				status: "PENDING",
				lastRetryAt: at(10).toISOString(),
				createdAt: at(1200),
				processedAt: null,
				error: null
			},
			{
				id: "i2",
				clientId: 999,
				internalMessageId: 8,
				status: "FAILED",
				lastRetryAt: null,
				createdAt: at(1200),
				processedAt: at(5),
				error: "Connection Closed"
			}
		];
	};
	const reader = new ChannelMessageHealthReader(
		db as unknown as ConstructorParameters<typeof ChannelMessageHealthReader>[0],
		() => time
	);
	const [first, shared] = await Promise.all([reader.read("tenant-a", [1, 2]), reader.read("tenant-a", [2, 1, 1])]);
	assert.equal(first, shared);
	assert.equal(calls.length, 4, "concurrent requests for the same scope share all reads");
	assert.equal(
		first.get(1)!.sendTechnicalFailed,
		1,
		"old send created outside the window uses recent terminal outcome time"
	);
	assert.equal(first.get(1)!.sendUnknown, 1);
	assert.equal(
		first.get(1)!.receiveFailed,
		1,
		"3059 retries are one affected message, even across processing stages"
	);
	assert.equal(first.get(1)!.receiveDelayed, 1);
	assert.equal(first.get(1)!.sendDelayed, 0, "manual resend restarts the internal pending clock");
	assert.equal(first.get(2)!.sendUnclassifiedFailed, 1);
	for (const { source, args } of calls) {
		if (source === "internal") {
			assert.equal(args["values"][0], "tenant-a");
			assert.ok(args["sql"].includes("IN (?,?)"));
			assert.ok(!args["sql"].includes("tenant-a"), "tenant and client IDs are bound parameters");
			assert.equal(args["values"].at(-1), 1001);
			continue;
		}
		assert.equal(args["take"], 1001);
		if (source !== "remoteInboundEventInbox") assert.equal(args["where"].instance, "tenant-a");
		assert.deepEqual(args["where"].clientId, { in: [1, 2] });
	}
	const messageWhere = calls[0]!.args["where"];
	assert.deepEqual(
		messageWhere.AND[0].OR[0].status,
		{ in: ["ERROR", "UNKNOWN"] },
		"confirmed receipt states are excluded before reading jobs"
	);
	// Execute the actual projected query locally; adapt MySQL scalar functions to SQLite.
	const sqlite = new DatabaseSync(":memory:");
	sqlite.function("IF", (condition, value, fallback) => (condition ? value : fallback));
	sqlite.function("JSON_UNQUOTE", (value) => value);
	sqlite.exec(
		"CREATE TABLE internal_message_processing_queue (id TEXT, internal_message_id INTEGER, instance TEXT, status TEXT, error TEXT, created_at TEXT, processed_at TEXT, message_data TEXT)"
	);
	const insert = sqlite.prepare("INSERT INTO internal_message_processing_queue VALUES (?, ?, ?, ?, NULL, ?, ?, ?)");
	insert.run(
		"a",
		1,
		"tenant-a",
		"PENDING",
		at(1200).toISOString(),
		null,
		JSON.stringify({ clientId: 1, lastRetryAt: at(10).toISOString(), body: "content must not be selected" })
	);
	insert.run(
		"b",
		2,
		"tenant-a",
		"FAILED",
		at(1200).toISOString(),
		at(5).toISOString(),
		JSON.stringify({ clientId: 2 })
	);
	insert.run(
		"other-tenant",
		3,
		"tenant-b",
		"FAILED",
		at(60).toISOString(),
		at(5).toISOString(),
		JSON.stringify({ clientId: 1 })
	);
	insert.run(
		"other-channel",
		4,
		"tenant-a",
		"FAILED",
		at(60).toISOString(),
		at(5).toISOString(),
		JSON.stringify({ clientId: 999 })
	);
	insert.run("invalid-json", 5, "tenant-a", "FAILED", at(60).toISOString(), at(5).toISOString(), "invalid");
	insert.run(
		"old-failure",
		6,
		"tenant-a",
		"FAILED",
		at(1200).toISOString(),
		at(901).toISOString(),
		JSON.stringify({ clientId: 1 })
	);
	insert.run(
		"completed",
		7,
		"tenant-a",
		"COMPLETED",
		at(60).toISOString(),
		at(5).toISOString(),
		JSON.stringify({ clientId: 1 })
	);
	const query = calls.find((call) => call.source === "internal")!.args;
	const values = (query["values"] as unknown[]).map((value) => {
		if (value instanceof Date) return value.toISOString();
		if (typeof value === "string" || typeof value === "number") return value;
		throw new Error("Unexpected SQL parameter");
	});
	const projected = sqlite.prepare(query["sql"]).all(...values);
	assert.deepEqual(
		projected.map((row) => row["id"]),
		["a", "b"]
	);
	assert.equal(projected[0]!["clientId"], 1);
	assert.equal(projected[0]!["lastRetryAt"], at(10).toISOString());
	assert.ok(!("message_data" in projected[0]!), "message payload never leaves the database projection");
	sqlite.close();
	await reader.read("tenant-a", [1, 2]);
	assert.equal(calls.length, 4);
	await reader.read("tenant-b", [1, 2]);
	assert.equal(calls.length, 8, "cache never crosses tenants");
	await reader.read("tenant-a", [1]);
	assert.equal(calls.length, 12, "cache never crosses visible client scopes");
	time += 15_001;
	overflow = true;
	assert.equal((await reader.read("tenant-a", [1, 2])).get(1)!.dataStatus, "LIMITED");
	time += 15_001;
	fail = true;
	assert.equal((await reader.read("tenant-a", [1, 2])).get(1)!.dataStatus, "UNAVAILABLE");
	console.log(
		"Message health: deduplication, retrying inbox, backlog, outcome time, scoping, bounded reads and unavailable data passed"
	);
}
readerChecks().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
