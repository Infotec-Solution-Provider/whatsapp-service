import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionData } from "../sdk-local";

type Row = { id: number; instance: string; name: string; userIds: number[] };
let rows: Row[] = [], chats = 0, queries = 0;
const actor: SessionData = { instance: "fixture-a", userId: 7, sectorId: 3, role: "ADMIN", name: "Fixture" };
const database: any = {
  $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(database),
  $queryRawUnsafe: async (sql: string, id: number, instance: string) => {
    queries++; assert.match(sql, /WHERE id=\? AND instance=\? FOR UPDATE$/);
    return rows.filter(row => row.id === id && row.instance === instance);
  },
  wppWallet: {
    findMany: async ({ where, take }: any) => rows.filter(row => row.instance === where.instance && row.id > (where.id?.gt ?? 0)).slice(0, take).map(row => ({ ...row, WppWalletUser: row.userIds.map(userId => ({ userId })) })),
    findFirst: async ({ where }: any) => { const row = rows.find(row => row.id === where.id && row.instance === where.instance); return row ? { ...row, WppWalletUser: row.userIds.map(userId => ({ userId })) } : null; },
    create: async ({ data }: any) => { const row = { ...data, id: rows.length + 1, userIds: [] }; rows.push(row); return row; },
    updateMany: async ({ where, data }: any) => { assert.equal(where.instance, actor.instance); const row = rows.find(row => row.id === where.id && row.instance === where.instance)!; row.name = data.name; return { count: 1 }; },
    deleteMany: async ({ where }: any) => { assert.equal(where.instance, actor.instance); assert.deepEqual(where.WppChat, { none: {} }); const at = rows.findIndex(row => row.id === where.id && row.instance === where.instance); rows.splice(at, 1); return { count: 1 }; }
  },
  wppWalletUser: {
    findMany: async ({ where }: any) => { assert.equal(where.WppWallet.instance, actor.instance); return rows.find(row => row.id === where.walletId)!.userIds.map(userId => ({ userId })); },
    create: async ({ data }: any) => { rows.find(row => row.id === data.walletId)!.userIds.push(data.userId); },
    deleteMany: async ({ where }: any) => { assert.equal(where.WppWallet.instance, actor.instance); const row = rows.find(row => row.id === where.walletId)!; row.userIds = row.userIds.filter(id => id !== where.userId); }
  },
  wppChat: { count: async ({ where }: any) => { assert.equal(where.instance, actor.instance); return chats; } }
};
const saved = new Map<string, NodeModule | undefined>();
for (const [path, value] of [["./prisma.service", database], ["./instances.service", { executeQuery: async (_instance: string, _sql: string, values: number[]) => values[0] === 7 ? [{ CODIGO: 7 }] : [] }]] as const) {
  const file = require.resolve(path); saved.set(file, require.cache[file]);
  require.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
}
const { WalletsService } = require("./wallets.service") as typeof import("./wallets.service");
for (const [file, previous] of saved) { if (previous) require.cache[file] = previous; else delete require.cache[file]; }
const service = new WalletsService();
function reset() { rows = [{ id: 1, instance: actor.instance, name: "Before", userIds: [] }, { id: 2, instance: "fixture-b", name: "Other", userIds: [] }]; chats = 0; queries = 0; }

test("every maintenance operation denies operators before database access", async () => {
  reset(); const operator = { ...actor, role: "ATIVO" as const };
  for (const run of [() => service.list(operator), () => service.get(operator, 1), () => service.create(operator, { name: "A" }), () => service.rename(operator, 1, {}), () => service.remove(operator, 1, {}), () => service.addUser(operator, 1, {}), () => service.removeUser(operator, 1, 7)]) await assert.rejects(run);
  assert.equal(queries, 0);
});
test("tenant isolation applies to reads and locked mutations", async () => {
  reset(); assert.equal((await service.list(actor)).data.length, 1);
  await assert.rejects(() => service.get(actor, 2));
  await assert.rejects(() => service.rename(actor, 2, { newName: "Intrusion", version: "x" }));
  assert.equal(rows[1]!.name, "Other");
});
test("rename is persisted, versions detect stale snapshots and malformed names never write", async () => {
  reset(); const before = await service.get(actor, 1);
  const after = await service.rename(actor, 1, { newName: "After", version: before.version });
  assert.equal((await service.get(actor, 1)).name, "After"); assert.notEqual(after.version, before.version);
  await assert.rejects(() => service.rename(actor, 1, { newName: "Lost update", version: before.version }));
  for (const name of ["", " ", "x".repeat(192), "\u0000", 2]) await assert.rejects(() => service.create(actor, { name }));
  await assert.rejects(() => service.create(actor, { name: "A", instance: "fixture-b" }));
});
test("membership is validated, idempotent and included in optimistic version", async () => {
  reset(); const before = await service.get(actor, 1);
  await assert.rejects(() => service.addUser(actor, 1, { userId: 99 }));
  const added = await service.addUser(actor, 1, { userId: 7 });
  assert.deepEqual((await service.addUser(actor, 1, { userId: 7 })).userIds, [7]);
  assert.notEqual(added.version, before.version);
  await assert.rejects(() => service.remove(actor, 1, { version: before.version }));
  await assert.rejects(() => service.remove(actor, 1, { version: added.version }));
  assert.deepEqual((await service.removeUser(actor, 1, 7)).userIds, []);
  assert.deepEqual((await service.removeUser(actor, 1, 7)).userIds, []);
});
test("wallet deletion blocks historical chat references and deletes only empty current snapshots", async () => {
  reset(); const before = await service.get(actor, 1); chats = 1;
  await assert.rejects(() => service.remove(actor, 1, { version: before.version }));
  chats = 0; await service.remove(actor, 1, { version: before.version });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.instance, "fixture-b");
});
