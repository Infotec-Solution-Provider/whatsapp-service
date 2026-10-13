import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { createTenantSqlRouter } from "./router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { validateRegistry } from "./registry";

function fixture() {
	const calls: string[] = [];
	const make = (tenant: string, id: number): Record<string, any> => {
		const db: Record<string, any> = {};
		db["wppContact"] = {
			findMany: async (args: any) => { calls.push(`${tenant}:read`); return !args.where?.id || args.where.id === id ? [{ id, instance: tenant, name: tenant }] : []; },
			findUnique: async (args: any) => args.where.id === id ? { id, instance: tenant } : null,
			count: async () => 1,
			update: async () => { calls.push(`${tenant}:write`); return { id, instance: tenant }; },
		};
		db["$transaction"] = async (callback: (tx: Record<string, any>) => Promise<any>) => {
			calls.push(`${tenant}:begin`);
			await new Promise(resolve => setTimeout(resolve, 2));
			try { const result = await callback(db); calls.push(`${tenant}:commit`); return result; }
			catch (error) { calls.push(`${tenant}:rollback`); throw error; }
		};
		return db;
	};
	const clients = new Map([["homolog", make("homolog", 1)], ["suprimaxxi", make("suprimaxxi", 2)]]);
	return { db: createTenantSqlRouter(new Map<string, Pool>(), clients), calls };
}

test("authenticated scope cannot address another tenant or unprepared destination", async () => {
	const { db, calls } = fixture();
	await assert.rejects(withDatabaseTenant("homolog", async () => db["wppContact"].findMany({ where: { instance: "suprimaxxi" } })), /SCOPE_MISMATCH/);
	await assert.rejects(withDatabaseTenant("production", async () => db["wppContact"].findMany({})), /NOT_PREPARED/);
	assert.deepEqual(calls, []);
});

test("workers resolve globally reserved IDs while scoped reads stay in one database", async () => {
	const { db, calls } = fixture();
	assert.equal((await db["wppContact"].findUnique({ where: { id: 2 } })).instance, "suprimaxxi");
	assert.equal((await db["wppContact"].update({ where: { id: 2 }, data: { name: "x" } })).instance, "suprimaxxi");
	assert.ok(calls.includes("suprimaxxi:write"));
	assert.ok(!calls.includes("homolog:write"));
	assert.equal(await db["wppContact"].count({}), 2);
});

test("parallel callback operations bind one connection and serialize acquisition", async () => {
	const { db, calls } = fixture();
	await withDatabaseTenant("homolog", () => db["$transaction"](async (tx: any) => {
		await Promise.all([tx.wppContact.findMany({}), tx.wppContact.findMany({})]);
	}));
	assert.equal(calls.filter(call => call === "homolog:begin").length, 1);
	assert.equal(calls.filter(call => call === "homolog:commit").length, 1);
	assert.ok(!calls.some(call => call.startsWith("suprimaxxi:")));
});

test("array transaction remains lazy and rejects mixed tenants before writing", async () => {
	const { db, calls } = fixture();
	const first = db["wppContact"].findMany({ where: { instance: "homolog" } });
	const second = db["wppContact"].findMany({ where: { instance: "suprimaxxi" } });
	assert.deepEqual(calls, []);
	await assert.rejects(db["$transaction"]([first, second]), /CROSS_TENANT_TRANSACTION/);
	assert.deepEqual(calls, []);
});

test("array results are cached after commit and cannot replay outside the transaction", async () => {
	const { db, calls } = fixture();
	const query = db["wppContact"].findMany({ where: { instance: "homolog" } });
	const results = await db["$transaction"]([query]);
	assert.deepEqual(await query, results[0]);
	assert.equal(calls.filter(call => call === "homolog:read").length, 1);
});

test("a captured callback client cannot issue a late mutation", async () => {
	const { db, calls } = fixture();
	let captured: any;
	await withDatabaseTenant("homolog", () => db["$transaction"](async (tx: any) => { captured = tx; await tx.wppContact.findMany({}); }));
	await assert.rejects(captured.wppContact.update({ where: { id: 1 }, data: { name: "x" } }), /CLOSED/);
	assert.ok(!calls.includes("homolog:write"));
});

test("callback failure rolls back its bound native transaction", async () => {
	const { db, calls } = fixture();
	await assert.rejects(withDatabaseTenant("homolog", () => db["$transaction"](async (tx: any) => {
		await tx.wppContact.update({ where: { id: 1 }, data: { name: "x" } });
		throw new Error("forced rollback");
	})), /forced rollback/);
	assert.ok(calls.includes("homolog:rollback"));
	assert.ok(!calls.includes("homolog:commit"));
});

test("registry requires both verified homolog destinations and unique ID offsets", () => {
	const registry = { version: 1, host: "127.0.0.1", port: 3306, user: "homolog", credentialFile: "/home/inpulse/htdocs/homolog/.db-password",
		sourceDatabase: "homolog-whatsapp", tablePrefix: "wpp_runtime_", autoIncrementIncrement: 2,
		tenants: [{ instance: "homolog", database: "homolog-crm", autoIncrementOffset: 1, prepared: true },
			{ instance: "suprimaxxi", database: "homolog-crm-suprimaxxi", autoIncrementOffset: 2, prepared: true }] };
	assert.equal(validateRegistry(registry).tenants.length, 2);
	assert.throws(() => validateRegistry({ ...registry, host: "production" }), /homolog/);
	assert.throws(() => validateRegistry({ ...registry, tenants: [registry.tenants[0], registry.tenants[0]] }), /invalid/);
});
