import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import PrismaOperatorOutboundRepository from "./operator-outbound.repository";

/** Disposable localhost fixture only. Never reads application connection variables. */
async function run(): Promise<void> {
  const database = `session_stability_central_test_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  assert.match(database, /^session_stability_central_test_[a-f0-9]{8}$/);
  const connection = await createConnection({ host: "127.0.0.1", port: 13367, user: "root",
    password: "session-stability-test-only", multipleStatements: true });
  let client: PrismaClient | null = null;
  let receipts: PrismaClient | null = null;
  try {
    const schema = execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "diff",
      "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8" });
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    await connection.query(`USE \`${database}\``);
    await connection.query(schema);
    const url = `mysql://root:session-stability-test-only@127.0.0.1:13367/${database}`;
    client = new PrismaClient({ datasources: { db: { url } } });
    receipts = new PrismaClient({ datasources: { db: { url } } });
    const db = client;
    const receiptDb = receipts;
    const repo = new PrismaOperatorOutboundRepository(db);
    await db.wppClient.create({ data: { id: 11, name: "fixture", instance: "fixture", type: "REMOTE", isActive: true } });
    const now = new Date();
    const fixture = await repo.enqueue({ instance: "fixture", userId: 1, clientId: 11,
      idempotencyKey: "mysql-reconciliation-fixture", payloadHash: "a".repeat(64), deliveryMode: "REMOTE", payload: {},
      message: { instance: "fixture", from: "me:fixture", to: "fixture", type: "chat", body: "fixture only",
        timestamp: "1", sentAt: now, status: "PENDING", clientId: 11 } });
    const id = fixture.job.id;
    const messageId = fixture.message.id;
    await db.operatorOutboundSend.update({ where: { id }, data: { status: "UNKNOWN", remoteJobId: "known-job",
      completedAt: now, nextAttemptAt: now, notificationPending: false } });
    await db.wppMessage.update({ where: { id: messageId }, data: { status: "UNKNOWN" } });
    const claim = await repo.claimReconciliation(id, "owner", now, new Date(now.getTime() - 86_400_000),
      new Date(now.getTime() + 60_000), new Date(now.getTime() + 300_000));
    assert.ok(claim);
    assert.deepEqual(await new PrismaOperatorOutboundRepository(db).reconciliationCandidates(now,
      new Date(now.getTime() - 86_400_000), 4), [], "restart cannot bypass a persisted lease/cadence");
    const outcome = { status: "SENT" as const, remoteJobId: "known-job", result: { wwebjsIdStanza: "durable-id" } };
    await assert.rejects(repo.completeReconciliation(id, "owner", now, outcome,
      async () => { throw new Error("finalizer fixture failure"); }), /finalizer fixture failure/);
    assert.equal((await db.operatorOutboundSend.findUniqueOrThrow({ where: { id } })).status, "UNKNOWN");
    const rolledBack = await db.wppMessage.findUniqueOrThrow({ where: { id: messageId } });
    assert.equal(rolledBack.status, "UNKNOWN");
    assert.equal(rolledBack.wwebjsIdStanza, null, "provider identity is rolled back with status/finalizer");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const committing = repo.completeReconciliation(id, "owner", now, outcome, async () => { enter(); await barrier; });
    await entered;
    const receipt = receiptDb.wppMessage.update({ where: { id: messageId }, data: { status: "READ" } }).then(value => value);
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [waits] = await connection.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
           WHERE l.OBJECT_SCHEMA = ?`, [database]);
        if (Number(waits[0]?.["n"]) > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "the real receipt transaction must overlap and wait for the reconciliation row lock");
    } finally { release(); }
    await Promise.all([committing, receipt]);
    assert.equal((await db.wppMessage.findUniqueOrThrow({ where: { id: messageId } })).status, "READ");
    const final = await db.operatorOutboundSend.findUniqueOrThrow({ where: { id } });
    assert.equal(final.status, "SENT");
    assert.equal(final.notificationPending, true);
    assert.equal(await repo.completeReconciliation(id, "owner", now, outcome, undefined), false, "finalization is idempotent");
    console.log("operator-outbound.mysql: real MySQL rollback, concurrent READ, lease/cadence and idempotency passed");
  } finally {
    await client?.$disconnect();
    await receipts?.$disconnect();
    await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.end();
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
