import assert from "node:assert/strict";
import { resolveDatabaseOperationTenant } from "./database-operation-tenant";
import { currentDatabaseTenant, withDatabaseTenant } from "./database-tenant-context";
import { DatabaseOperationMetrics } from "./database-operation-metrics";

export async function testDatabaseOperationTenant(): Promise<void> {
	const query = (where: unknown) => resolveDatabaseOperationTenant("WppMessage", "findMany", { where });
	const fromQuery = { tenant: "tenant-a", tenantSource: "query" };
	assert.deepEqual(query({ instance: "tenant-a" }), fromQuery);
	assert.deepEqual(query({ instance: { equals: "tenant-a" } }), fromQuery);
	assert.deepEqual(query({ instance: { in: ["tenant-a"] } }), fromQuery);
	assert.deepEqual(query({ AND: [{ instance: "tenant-a" }, { id: 123 }] }), fromQuery);
	assert.deepEqual(query({ OR: [{ instance: "tenant-a" }, { instance: "tenant-a", id: 123 }] }), fromQuery);
	assert.equal(query({ OR: [{ instance: "tenant-a" }, { id: 123 }] }).tenantSource, "ambiguous");
	assert.equal(query({ instance: { in: ["tenant-a", "tenant-b"] } }).tenant, null);
	assert.equal(query({ AND: [{ instance: "tenant-a" }, { instance: "tenant-b" }] }).tenant, null);
	assert.equal(query({ NOT: { instance: "tenant-a" } }).tenant, null);
	assert.equal(query({ OR: [{ id: 1 }, { id: 2 }] }).tenantSource, "unknown");
	assert.equal(query({ instance: "bad\ntenant" }).tenant, null);
	assert.equal(query({ instance: "a".repeat(129) }).tenant, null);
	assert.deepEqual(resolveDatabaseOperationTenant("WppContact", "findUnique", {
		where: { instance_phone: { instance: "tenant-a", phone: "private-phone" } },
	}), fromQuery);
	assert.deepEqual(resolveDatabaseOperationTenant("WppMessage", "create", {
		data: { instance: "tenant-a", body: "private-message", mentionMetadata: { instance: "private-payload" } },
	}), fromQuery);
	assert.equal(resolveDatabaseOperationTenant("WppMessage", "createMany", {
		data: [{ instance: "tenant-a" }, { instance: "tenant-b" }],
	}).tenantSource, "ambiguous");
	assert.equal(resolveDatabaseOperationTenant("WppMessage", "createMany", {
		data: Array.from({ length: 65 }, () => ({ instance: "tenant-a" })),
	}).tenant, null);
	assert.equal(query({ mentionMetadata: { instance: "private-payload" } }).tenant, null);
	assert.equal(resolveDatabaseOperationTenant(undefined, "$queryRawUnsafe", ["SELECT private-sql", { instance: "private-parameter" }]).tenant, null);
	// An upsert's create branch cannot identify the existing row on its update branch.
	assert.equal(resolveDatabaseOperationTenant("WppMessage", "upsert", { where: { id: 1 }, create: { instance: "tenant-a" } }).tenant, null);
	let deep: unknown = { instance: "tenant-a" };
	for (let index = 0; index < 100; index++) deep = { AND: [deep] };
	assert.equal(query(deep).tenant, null, "diagnostic traversal is bounded");
	assert.equal(query({ OR: Array.from({ length: 65 }, () => ({ instance: "tenant-a" })) }).tenant, null);

	await withDatabaseTenant("tenant-a", async () => {
		await Promise.resolve();
		assert.equal(query({ id: 1 }).tenantSource, "context");
		assert.equal(query({ id: 1 }).tenant, "tenant-a");
		assert.equal(query({ OR: [{ id: 1 }, { id: 2 }] }).tenant, "tenant-a", "unrelated OR filters preserve caller context");
		assert.equal(query({ instance: "tenant-b" }).tenant, "tenant-b", "explicit query identity wins over caller identity");
		assert.equal(query({ instance: { in: ["tenant-a", "tenant-b"] } }).tenant, null, "multi-tenant query must not fall back to caller");
		await withDatabaseTenant(null, async () => assert.equal(currentDatabaseTenant(), null));
		assert.equal(currentDatabaseTenant(), "tenant-a");
	});
	assert.equal(currentDatabaseTenant(), null);

	let now = 0;
	const reports: Record<string, unknown>[] = [];
	const metrics = new DatabaseOperationMetrics({ clock: () => now, report: (entry) => { reports.push(entry); } });
	const failure = Object.assign(new Error("private-error"), { code: "P2025" });
	let releaseA!: () => void;
	let releaseB!: () => void;
	const a = withDatabaseTenant("tenant-a", () => metrics.measure("WppMessage", "findUniqueOrThrow", async () => {
		await new Promise<void>((resolve) => { releaseA = resolve; });
		assert.equal(currentDatabaseTenant(), "tenant-a");
		throw failure;
	}, query({ id: 1 })));
	const checkedA = assert.rejects(a, (error: unknown) => error === failure);
	const b = withDatabaseTenant("tenant-b", () => metrics.measure("WppMessage", "findMany", async () => {
		await new Promise<void>((resolve) => { releaseB = resolve; });
		assert.equal(currentDatabaseTenant(), "tenant-b");
		return [];
	}, query({ id: 2 })));
	assert.deepEqual(metrics.snapshot().active.map((item) => item.tenant).sort(), ["tenant-a", "tenant-b"]);
	now = 2_000;
	releaseB();
	await b;
	now += 5_000;
	releaseA();
	await checkedA;
	assert.deepEqual(reports.map((entry) => entry["tenant"]), ["tenant-b", "tenant-a"]);
	assert.equal(reports[1]?.["code"], "P2025");
	assert.equal(currentDatabaseTenant(), null, "concurrent task contexts must not leak to the caller");
	assert.doesNotMatch(JSON.stringify({ reports, snapshot: metrics.snapshot() }), /private/);
}
