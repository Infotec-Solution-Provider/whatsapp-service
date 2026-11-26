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
    await pool.query("ALTER TABLE wpp_runtime_wallets ADD COLUMN member_rules TEXT NULL");
    await pool.query("CREATE TABLE wpp_runtime_message_flows (id INT PRIMARY KEY, instance VARCHAR(191))");
    await pool.query("CREATE TABLE wpp_runtime_message_flows_steps (id INT PRIMARY KEY, message_flow_id INT, type VARCHAR(32), config JSON, connections JSON, step_number INT, next_step_id INT, fallback_step_id INT, enabled BOOL, description TEXT, created_at DATETIME, updated_at DATETIME)");
    const database = createTenantSqlRouter(new Map([["fixture-a", pool]]));
    for (const [path, value] of [["./prisma.service", database], ["./instances.service", { executeQuery: async () => [{ CODIGO: 7 }] }]] as const) {
      const file = require.resolve(path); saved.set(file, require.cache[file]);
      require.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
    }
    const { WalletsService } = require("./wallets.service") as typeof import("./wallets.service");
    const crm = pool;
    await crm.query("CREATE TABLE operadores (CODIGO INT PRIMARY KEY,NOME VARCHAR(30),SETOR INT,NIVEL VARCHAR(10),ATIVO VARCHAR(3))");
    await crm.query("INSERT INTO operadores VALUES (7,'Ana',3,'ADMIN','SIM'),(8,'Bia',3,'RECEP','SIM'),(9,'Caio',4,'RECEP','SIM')");
    const service = new WalletsService(database as any, { executeQuery: async (_instance: string, sql: string, params: unknown[]) =>
      (await crm.query(sql, params))[0] } as any);
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
      const config = { name: "Compartilhada", userIds: [7, 8], rules: [{ sectorId: 3, role: "RECEP" }, { role: "ADMIN" }] };
      const shared = await service.create(actor, config);
      assert.equal(shared.memberCount, 2);
      assert.deepEqual(await service.preview(actor, { userIds: config.userIds, rules: config.rules }), [
        { id: 7, name: "Ana", manual: true, matchedRules: [2] }, { id: 8, name: "Bia", manual: true, matchedRules: [1] }
      ]);
      const updated = await service.save(actor, shared.id, { ...config, userIds: [7], version: shared.version });
      assert.equal(updated.memberCount, 2);
      await assert.rejects(service.save(actor, shared.id, { ...config, version: shared.version }), /mudou/);
      await crm.query("UPDATE operadores SET SETOR=IF(CODIGO=9,3,4),ATIVO=IF(CODIGO=7,'NAO','SIM')");
      assert.deepEqual(await service.eventRecipients(actor.instance, "wallet", shared.id), [9]);
      assert.equal((await service.effectiveWallets(actor.instance, 8)).length, 0);
      assert.equal((await service.effectiveWallets(actor.instance, 7)).length, 0);
      assert.equal((await service.effectiveWallets(actor.instance, 9))[0]?.id, shared.id);
      const cleared = await service.save(actor, shared.id, { ...config, userIds: [], rules: [], version: updated.version });
      await crm.execute("INSERT INTO wpp_runtime_message_flows VALUES (1,'fixture-a')");
      await crm.execute("INSERT INTO wpp_runtime_message_flows_steps (id,message_flow_id,type,config) VALUES (1,1,'ASSIGN',?)", [JSON.stringify({ walletId: shared.id })]);
      await assert.rejects(service.remove(actor, shared.id, { version: cleared.version }), /fluxo publicado/);
      await assert.rejects(() => service.rename({ ...actor, instance: "fixture-b" }, wallet.id, { newName: "Other", version: empty.version }));
    });
  } finally {
    for (const [file, previous] of saved) { if (previous) require.cache[file] = previous; else delete require.cache[file]; }
    if (pool) await pool.end();
    if (!/^crm_wallet_fixture_[a-f0-9]{12}$/.test(name)) throw new Error("Unsafe cleanup");
    await root.query(`DROP DATABASE IF EXISTS \`${name}\``); await root.end();
  }
});
