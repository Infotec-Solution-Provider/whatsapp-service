import assert from "node:assert/strict";
import test from "node:test";
import type { OperatorOutboundEnqueueInput } from "./operator-outbound.types";
import type { DatabaseClient } from "./prisma.service";
import { pauseAdmissionFailure } from "./operator-pause-admission";

const saved = new Map<string, NodeModule | undefined>();
function stub(path: string, value: unknown) {
	const id = require.resolve(path); saved.set(id, require.cache[id]);
	require.cache[id] = { id, filename: id, loaded: true, exports: value } as NodeModule;
}
stub("./prisma.service", { __esModule: true, default: {} });
stub("../tenant-sql/registry", { tenantSqlEnabled: () => true });
const Repository = require("./operator-outbound.repository").default as typeof import("./operator-outbound.repository").default;
for (const [id, previous] of saved) { if (previous) require.cache[id] = previous; else delete require.cache[id]; }

test("native enqueue admits and persists in one transaction, preserves replay and rolls back rejected new sends", async () => {
	let state = "paused", failCreate = false, transactions = 0;
	let rows: any[] = [];
	const events: string[] = [];
	const delegate = (current: any[], inTx: boolean) => ({
		findUnique: async ({ where }: any) => current.find(row => row.idempotencyKey === where.instance_userId_idempotencyKey.idempotencyKey) ?? null,
		create: async ({ data }: any) => {
			assert.equal(inTx, true, "native enqueue must not escape the guarded transaction");
			events.push("create");
			const created = { ...data, id: "fixture", messageId: current.length + 1, message: { ...data.message.create, id: current.length + 1 } };
			current.push(created);
			if (failCreate) throw new Error("nested insert failed");
			return created;
		}
	});
	const db = {
		operatorOutboundSend: { findUnique: async (args: any) => delegate(rows, false).findUnique(args) },
		$transaction: async (callback: (tx: any) => Promise<unknown>) => {
			transactions++;
			const snapshot = structuredClone(rows);
			const result = await callback({
				operatorOutboundSend: delegate(snapshot, true),
				$executeRawUnsafe: async () => 1,
				$queryRawUnsafe: async (sql: string) => {
					if (sql.includes("information_schema")) return [{ COLUMN_NAME: "pause_all_channels" }];
					if (sql.includes("FROM telephony_runtime_policy")) { events.push("policy"); return [{ enabled: 1, pause_all_channels: 1, preflight_hash: "a".repeat(64) }]; }
					if (sql.includes("FROM telephony_operator_state")) { events.push("state"); return [{ state, unavailable_since: new Date("2026-11-16T12:00:00Z") }]; }
					if (sql.includes("FROM operadores")) return [{ ATIVO: "SIM" }];
					if (sql.includes("FROM chats")) return [{ id: 5, user_id: -1, is_finished: 0, is_schedule: 0, started_at: new Date("2026-11-16T12:00:01Z") }];
					throw new Error("unexpected query");
				}
			});
			rows = snapshot;
			return result;
		}
	};
	const repository = new Repository(db as unknown as DatabaseClient);
	const input: OperatorOutboundEnqueueInput = { instance: "fixture", userId: 7, clientId: 9,
		idempotencyKey: "same-intent", payloadHash: "a".repeat(64), deliveryMode: "DIRECT", payload: {},
		message: { instance: "fixture", chatId: 5, from: "me:synthetic", to: "synthetic", type: "chat", body: "fixture", timestamp: "1", sentAt: new Date(), status: "PENDING" } };
	await assert.rejects(repository.enqueue(input), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	assert.equal(rows.length, 0);
	state = "available"; events.length = 0;
	assert.equal((await repository.enqueue(input)).created, true);
	assert.deepEqual(events, ["policy", "state", "create"]);
	assert.equal(rows.length, 1);
	state = "paused"; const before = transactions;
	assert.equal((await repository.enqueue(input)).created, false);
	assert.equal(transactions, before, "a confirmed intent replays without new admission");
	state = "available"; failCreate = true;
	await assert.rejects(repository.enqueue({ ...input, idempotencyKey: "second-intent" }), /nested insert failed/);
	assert.equal(rows.length, 1, "failed nested persistence rolls back the whole enqueue");
});
