import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import type { SessionData } from "../sdk-local/types/auth.types";
import type { DatabaseClient } from "./prisma.service";
import type { MetaCostsService as CostService } from "./meta-costs.service";

const port = Number(process.env["META_COST_MYSQL_FIXTURE_PORT"]);

test("tenant SQL applies the budget migration and upserts a monthly budget without duplicates or leakage", { skip: !port }, async () => {
	assert.ok(port > 1024 && port !== 3306, "use a disposable MySQL fixture on a nonstandard loopback port");
	const schema = `meta_budget_test_${randomUUID().replaceAll("-", "")}`;
	const root = mysql.createPool({ host: "127.0.0.1", port, user: "root", password: "", connectionLimit: 1 });
	let pool: ReturnType<typeof mysql.createPool> | undefined;
	const overrides = new Map<string, NodeModule | undefined>();
	function stub(path: string, data: object) {
		const id = require.resolve(path);
		overrides.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: data } } as NodeModule;
	}

	try {
		await root.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		pool = mysql.createPool({ host: "127.0.0.1", port, user: "root", password: "", database: schema, connectionLimit: 4 });
		await pool.query(await readFile("prisma/tenant-sql/20261127101000_meta_operator_budgets.sql", "utf8"));
		const database = createTenantSqlRouter(new Map([["fixture-a", pool], ["fixture-b", pool]])) as unknown as DatabaseClient;
		stub("./prisma.service", database);
		const crm = {
			async executeQuery<T>(instance: string, _sql: string, params: unknown[]): Promise<T> {
				const ids = instance === "fixture-a" ? [7, 8] : [7];
				return ids.filter(id => !params.length || params.includes(id)).map(CODIGO => ({ CODIGO, NOME: `Operador ${CODIGO}`, ATIVO: "SIM" })) as T;
			}
		};
		stub("./instances.service", crm);
		const logPath = require.resolve("../utils/processing-logger");
		overrides.set(logPath, require.cache[logPath]);
		require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: {
			__esModule: true, default: class { success() {} failed() {} }
		} } as NodeModule;
		const { MetaCostsService } = require("./meta-costs.service") as { MetaCostsService: typeof CostService };
		const service = new MetaCostsService(database, crm, {
			listMonthly: async () => ({ buckets: [], confirmed: 0, unattributed: 0, missingPricing: 0 })
		}, {
			listCostReceiptChannels: async () => [], getChannelPricing: async () => null
		});
		const actor: SessionData = { instance: "fixture-a", role: "ADMIN", userId: 7, sectorId: 3, name: "Fixture" };
		const other = { ...actor, instance: "fixture-b" };
		const period = { month: "2026-11", start: new Date("2026-11-01"), end: new Date("2026-11-27") };
		await withDatabaseTenant(actor.instance, async () => {
			await Promise.all([service.setBudget(actor, period.month, 7, 1000), service.setBudget(actor, period.month, 7, 2500)]);
			assert.equal(await database.metaOperatorBudget.count({ where: { instance: actor.instance } }), 1);
			assert.deepEqual(await service.setBudget(actor, period.month, 7, 0), { budgetCents: 0 });
			assert.deepEqual(await service.setBudget(actor, "2026-12", 7, 3000), { budgetCents: 3000 });
			assert.equal((await service.getCosts(actor.instance, period)).operators.find(row => row.operatorId === 7)?.budgetCents, 0);
		});
		await withDatabaseTenant(other.instance, async () => {
			await assert.rejects(() => service.setBudget(other, period.month, 8, 2000), { code: "META_COST_OPERATOR_NOT_FOUND" });
			assert.equal((await service.getCosts(other.instance, period)).operators[0]?.budgetCents, null);
			await service.setBudget(other, period.month, 7, 4000);
		});
		await withDatabaseTenant(actor.instance, async () => {
			await service.setBudget(actor, period.month, 7, null);
			assert.equal(await database.metaOperatorBudget.count({ where: { instance: actor.instance, month: period.month } }), 0);
			assert.equal(await database.metaOperatorBudget.count({ where: { instance: actor.instance, month: "2026-12" } }), 1);
		});
		await withDatabaseTenant(other.instance, async () => {
			assert.equal((await service.getCosts(other.instance, period)).operators[0]?.budgetCents, 4000);
		});
	} finally {
		for (const [id, previous] of overrides) {
			if (previous) require.cache[id] = previous;
			else delete require.cache[id];
		}
		await pool?.end();
		await root.query(`DROP DATABASE IF EXISTS \`${schema}\``);
		await root.end();
	}
});
