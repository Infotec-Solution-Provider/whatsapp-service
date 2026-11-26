import assert from "node:assert/strict";
import test from "node:test";
import { currentDatabaseTenant } from "../utils/database-tenant-context";
import type { MessageQueueProcessHandler } from "./message-queue.service";

interface QueueWorker {
  processQueue(): Promise<void>;
  setProcessHandler(handler: MessageQueueProcessHandler): void;
}

interface QueueWhere {
  id?: { in: string[] } | string;
  instance?: string;
  status: string;
}

function queueFixture(tenants: string[] | null) {
  const items = ["first", "second"].map((id, index) => ({
    id, instance: "healthy", clientId: 12, messageId: index + 1, contactPhone: "fixture",
    contactName: null, status: "PENDING", lockedBy: null as string | null
  }));
  const scans: Array<string | null> = [];
  const processed: number[] = [];
  let recoveryAttempts = 0;
  let failRecovery!: () => void;
  const unavailable = new Promise<never>((_, reject) => {
    failRecovery = () => reject(new Error("Unknown database"));
  });
  const queueModel = {
    async findMany({ where }: { where: QueueWhere }) {
      if (where.status === "PENDING") {
        scans.push(currentDatabaseTenant());
        assert.equal(where.instance, tenants ? "healthy" : undefined);
      }
      return items.filter((item) => item.status === where.status &&
        (typeof where.id !== "object" || where.id.in.includes(item.id)));
    },
    async findUnique({ where }: { where: { id: string } }) {
      assert.equal(currentDatabaseTenant(), "healthy");
      return items.find((item) => item.id === where.id);
    },
    async updateMany({ where, data }: { where: QueueWhere; data: { status: string; lockedBy: string | null } }) {
      if (currentDatabaseTenant() === "unavailable") {
        recoveryAttempts++;
        assert.equal(where.instance, "unavailable");
        return unavailable;
      }
      if (where.id === undefined) return { count: 0 };
      const matching = items.filter((item) => item.status === where.status &&
        (typeof where.id === "string" ? where.id === item.id : where.id!.in.includes(item.id)));
      for (const item of matching) Object.assign(item, data);
      return { count: matching.length };
    }
  };
  const mocks: Record<string, unknown> = {
    "./prisma.service": {
      default: { wppMessageProcessingQueue: queueModel, wppMessage: { findUnique: async ({ where }: { where: { id: number } }) => ({ id: where.id }) } }
    },
    "../tenant-sql/registry": { tenantSqlEnabled: () => tenants !== null },
    "../tenant-sql/router": { tenantSqlInstanceNames: () => tenants ?? [] },
    "../utils/processing-logger": { default: class { log() {} success() {} failed() {} } },
    "@in.pulse-crm/utils": { Logger: { info() {}, error() {} } }
  };
  const serviceId = require.resolve("./message-queue.service");
  const originals = new Map([[serviceId, require.cache[serviceId]]]);
  delete require.cache[serviceId];
  let worker: QueueWorker;
  try {
    for (const [path, exports] of Object.entries(mocks)) {
      const id = require.resolve(path);
      originals.set(id, require.cache[id]);
      require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...(exports as object) } } as NodeModule;
    }
    worker = require(serviceId).default as QueueWorker;
  } finally {
    for (const [id, module] of originals) {
      if (module) require.cache[id] = module;
      else delete require.cache[id];
    }
  }
  worker.setProcessHandler({
    async processMessage(instance, _clientId, messageId) {
      assert.equal(instance, "healthy");
      assert.equal(currentDatabaseTenant(), instance);
      processed.push(messageId);
    }
  });
  return { worker, processed, scans, failRecovery, recoveryAttempts: () => recoveryAttempts };
}

test("a native queue keeps processing its own contact while a peer database fails", async () => {
  const fixture = queueFixture(["unavailable", "healthy"]);
  const blockedTick = fixture.worker.processQueue();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.processed, [1]);
  await fixture.worker.processQueue();
  assert.deepEqual(fixture.processed, [1, 2]);
  fixture.failRecovery();
  await blockedTick;
  await fixture.worker.processQueue();
  assert.equal(fixture.recoveryAttempts(), 1);
  assert.deepEqual(fixture.scans, ["healthy", "healthy", "healthy"]);
});

test("central storage retains one scan and the contact order per tick", async () => {
  const fixture = queueFixture(null);
  await fixture.worker.processQueue();
  assert.deepEqual(fixture.processed, [1]);
  await fixture.worker.processQueue();
  assert.deepEqual(fixture.processed, [1, 2]);
  assert.deepEqual(fixture.scans, [null, null]);
});
