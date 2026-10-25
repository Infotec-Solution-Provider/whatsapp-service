import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import type { SessionData } from "../sdk-local";

test("wallet native tenant SQL persists membership, serializes concurrent renames, and protects dependencies", { skip: process.env["CRM_COMPLETION_MYSQL_ENABLED"] !== "1" }, async () => {
  if (process.env["CRM_COMPLETION_MYSQL_PORT"] !== "3308") throw new Error("Dedicated loopback fixture port required");
  const name = `crm_wallet_fixture_${randomBytes(6).toString("hex")}`;
  const root = mysql.createPool({ host: "127.0.0.1", port: 3308, user: "root", password: "", connectionLimit: 1 });
  let pool: ReturnType<typeof mysql.createPool> | undefined;
  const saved = new Map<string, NodeModule | undefined>();
  try {
    await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ host: "127.0.0.1", port: 3308, user: "root", password: "", database: name, connectionLimit: 4 });
    await pool.query("CREATE TABLE wpp_runtime_wallets (id INT PRIMARY KEY AUTO_INCREMENT, instance VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL) ENGINE=InnoDB");
    await pool.query("CREATE TABLE wpp_runtime_wallets_users (wallet_id INT, user_id INT, UNIQUE(wallet_id,user_id)) ENGINE=InnoDB");
    await pool.query("CREATE TABLE wpp_runtime_chats (id INT PRIMARY KEY, instance VARCHAR(191),wallet_id INT) ENGINE=InnoDB");
    const database = createTenantSqlRouter(new Map([["fixture-a", pool]]));
    for (const [path, value] of [["./prisma.service", database], ["./instances.service", { executeQuery: async () => [{ CODIGO: 7 }] }]] as const) {
      const file = require.resolve(path); saved.set(file, require.cache[file]);
      require.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
    }
    const { WalletsService } = require("./wallets.service") as typeof import("./wallets.service");
    const service = new WalletsService(database as any, { executeQuery: async () => [{ CODIGO: 7 }] } as any);
    const actor: SessionData = { instance: "fixture-a", role: "ADMIN", userId: 7, sectorId: 3, name: "Fixture" };
    await withDatabaseTenant(actor.instance, async () => {
      const wallet = await service.create(actor, { name: "Before" });
      const attempts = await Promise.allSettled([service.rename(actor, wallet.id, { newName: "First", version: wallet.version }), service.rename(actor, wallet.id, { newName: "Second", version: wallet.version })]);
      assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
      const changed = await service.get(actor, wallet.id); assert.notEqual(changed.name, wallet.name);
      const added = await service.addUser(actor, wallet.id, { userId: 7 });
      assert.deepEqual((await service.get(actor, wallet.id)).userIds, [7]);
      assert.equal((await service.getUserWallets(actor)).length, 1);
      await assert.rejects(() => service.remove(actor, wallet.id, { version: added.version }));
      const empty = await service.removeUser(actor, wallet.id, 7);
      await pool!.query("INSERT INTO wpp_runtime_chats VALUES (1,'fixture-a',?)", [wallet.id]);
      await assert.rejects(() => service.remove(actor, wallet.id, { version: empty.version }));
      await pool!.query("DELETE FROM wpp_runtime_chats WHERE id=1");
      await service.remove(actor, wallet.id, { version: empty.version });
      assert.equal((await service.list(actor)).data.length, 0);
      await assert.rejects(() => service.rename({ ...actor, instance: "fixture-b" }, wallet.id, { newName: "Other", version: empty.version }));
    });
  } finally {
    for (const [file, previous] of saved) { if (previous) require.cache[file] = previous; else delete require.cache[file]; }
    if (pool) await pool.end();
    if (!/^crm_wallet_fixture_[a-f0-9]{12}$/.test(name)) throw new Error("Unsafe cleanup");
    await root.query(`DROP DATABASE IF EXISTS \`${name}\``); await root.end();
  }
});
