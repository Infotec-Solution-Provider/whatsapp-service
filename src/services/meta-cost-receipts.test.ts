import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createConnection, createPool } from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { currentDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";
import type { DatabaseClient } from "./prisma.service";
import { MetaCostReceiptLimitError, MetaCostReceiptRepository, type MetaCostReceiptBucket } from "./meta-cost-receipts";

const bounds = {
	start: new Date("2026-11-01T03:00:00.000Z"),
	end: new Date("2026-12-01T03:00:00.000Z")
};
const channels = [
	{ clientId: 7, phoneId: "8400" },
	{ clientId: 9, phoneId: "8400" },
	{ clientId: 12, phoneId: "8600" }
];

type QueryDatabase = Pick<DatabaseClient, "$queryRawUnsafe">;

function mockQuery(query: (sql: string, values: unknown[]) => unknown): QueryDatabase {
	return {
		$queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise.resolve(query(sql, values))
	} as unknown as QueryDatabase;
}

test("bounds indexed acquisition and receipt timestamps independently and queries the selected tenant", async () => {
	const repo = new MetaCostReceiptRepository(mockQuery((query, values) => {
		assert.equal(currentDatabaseTenant(), "fixture-sa");
		assert.match(query, /FROM waba_webhook_queue\s+WHERE instance = \? AND created_at >= \? AND created_at < \?/);
		assert.match(query, /m\.instance = \?/);
		assert.deepEqual(values, [
			JSON.stringify(channels), "fixture-sa", "2026-10-30 03:00:00.000", "2026-12-03 03:00:00.000",
			"fixture-sa", "fixture-sa", Date.parse("2026-11-01T03:00:00Z") / 1000, Date.parse("2026-12-01T03:00:00Z") / 1000,
			Date.parse("2026-11-01T03:00:00Z") / 1000, "2026-11-01 03:00:00.000"
		]);
		return [
			{ clientId: 7, operatorId: 23, country: "BR", category: "marketing", pricingType: "regular", volume: 3n, queueRows: 6n },
			{ clientId: 9, operatorId: null, country: null, category: null, pricingType: null, volume: 1n, queueRows: 6n }
		];
	}));
	assert.deepEqual(await repo.listMonthly("fixture-sa", channels, bounds), {
		buckets: [
			{ clientId: 7, operatorId: 23, country: "BR", category: "marketing", pricingType: "regular", volume: 3 },
			{ clientId: 9, operatorId: null, country: null, category: null, pricingType: null, volume: 1 }
		],
		confirmed: 4, unattributed: 1, missingPricing: 1
	});
});

test("distinguishes an empty report from a receipt window exceeding the scan limit", async () => {
	const empty = new MetaCostReceiptRepository(mockQuery(() => [
		{ clientId: null, operatorId: null, category: null, country: null, pricingType: null, volume: null, queueRows: 0n }
	]));
	assert.deepEqual(await empty.listMonthly("fixture-sa", channels, bounds), {
		buckets: [], confirmed: 0, unattributed: 0, missingPricing: 0
	});
	const full = new MetaCostReceiptRepository(mockQuery(() => [
		{ clientId: null, operatorId: null, category: null, country: null, pricingType: null, volume: null, queueRows: 200_001n }
	]));
	await assert.rejects(full.listMonthly("fixture-sa", channels, bounds), MetaCostReceiptLimitError);
	await assert.rejects(empty.listMonthly("fixture-sa", channels, { start: bounds.end, end: bounds.start }), RangeError);
});

function event(
	id: string,
	status: "sent" | "delivered" | "read",
	timestamp: string,
	pricing: { category: string; type?: string; pricing_model?: string; billable?: boolean } | undefined,
	recipientId = "5551912345678"
) {
	return { id, status, timestamp: String(Date.parse(timestamp) / 1_000), recipient_id: recipientId, pricing };
}

const charge = { category: "marketing", type: "regular", pricing_model: "PMP" };
const free = { category: "utility", type: "free_entry_point", pricing_model: "PMP" };
const mysqlPort = Number(process.env["META_COST_RECEIPTS_MYSQL_PORT"]);

test("real MySQL deduplicates statuses and preserves tenant and send-time operator across central and tenant SQL", {
	skip: !(Number.isInteger(mysqlPort) && mysqlPort > 0 && mysqlPort <= 65_535)
}, async () => {
	const suffix = randomUUID().replaceAll("-", "");
	const schema = `meta_receipt_test_${suffix}`;
	const fixture = { host: "127.0.0.1", port: mysqlPort, user: "root", timezone: "Z" };
	const admin = await createConnection(fixture);
	const central = new PrismaClient({ datasources: { db: { url: `mysql://root@127.0.0.1:${mysqlPort}/${schema}` } } });
	const pool = createPool({ ...fixture, database: schema });
	const tenantDb = createTenantSqlRouter(new Map([["fixture-sa", pool]])) as unknown as QueryDatabase;

	try {
		await admin.query(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4`);
		await admin.query(`USE ${schema}`);
		for (const prefix of ["", "wpp_runtime_"]) {
			const queue = `${prefix}waba_webhook_queue`;
			const msgs = `${prefix}messages`;
			await admin.query(`CREATE TABLE ${queue} (
				id VARCHAR(36) PRIMARY KEY, instance VARCHAR(191) NOT NULL,
				payload JSON NOT NULL, created_at DATETIME(3) NOT NULL
			)`);
			const messageCollation = prefix ? "utf8mb4_unicode_ci" : "utf8mb3_general_ci";
			await admin.query(`CREATE TABLE ${msgs} (
				id INT PRIMARY KEY AUTO_INCREMENT, instance VARCHAR(191) NOT NULL, client_id INT NOT NULL,
				user_id INT, waba_id VARCHAR(191) COLLATE ${messageCollation} NOT NULL UNIQUE, sent_at DATETIME(3) NOT NULL
			)`);
			const indexDdl = await readFile(prefix
				? "prisma/tenant-sql/20261127102000_meta_cost_receipt_window.sql"
				: "prisma/migrations/20261127102000_meta_cost_receipt_window/migration.sql", "utf8");
			await admin.query(indexDdl);
			await admin.query(`INSERT INTO ${msgs} (instance, client_id, user_id, waba_id, sent_at) VALUES
				('fixture-sa',9,41,'wamid.owned','2026-11-01 03:00:00'),
				('fixture-sa',12,42,'wamid.foreign-market','2026-11-01 03:00:00'),
				('fixture-other',7,89,'wamid.cross-tenant','2026-11-01 03:00:00'),
				('fixture-sa',12,75,'wamid.wrong-channel','2026-11-01 03:00:00'),
				('fixture-sa',7,62,'wamid.local-read','2026-11-01 03:00:00'),
				('fixture-sa',7,56,'wamid.old-send','2026-10-15 08:00:00')`);
			const first = "2026-11-01T03:00:00Z";
			const insert = async (tenant: string, acquired: string, ...values: Array<{ phoneId: string; statuses: ReturnType<typeof event>[] }>) => {
				const payload = { entry: values.map(({ phoneId, statuses }) => ({
					changes: [{ value: { metadata: { phone_number_id: phoneId }, statuses } }]
				})) };
				await admin.query(`INSERT INTO ${queue} (id, instance, payload, created_at) VALUES (?,?,?,?)`,
					[randomUUID(), tenant, JSON.stringify(payload), acquired]);
			};
			await insert("fixture-sa", "2026-11-01 00:00:20",
				{ phoneId: "8400", statuses: [
					event("wamid.owned", "delivered", first, charge),
					event("wamid.cross-tenant", "delivered", first, charge),
					event("wamid.wrong-channel", "delivered", first, charge),
					event("wamid.OWNED", "delivered", first, charge)
				] },
				{ phoneId: "8600", statuses: [event("wamid.foreign-market", "delivered", first, free, "14155552325")] },
				{ phoneId: "9999", statuses: [event("wamid.unselected", "delivered", first, charge)] }
			);
			await insert("fixture-sa", "2026-11-01 03:04:00", { phoneId: "8400", statuses: [
				event("wamid.owned", "read", first, charge),
				event("wamid.owned", "delivered", first, charge),
				event("wamid.old-send", "read", first, charge),
				event("wamid.only-read", "read", first, charge),
				event("wamid.local-read", "read", first, charge),
				event("wamid.sent-and-read", "sent", first, charge),
				event("wamid.sent-and-read", "read", first, charge),
				event("wamid.earlier", "delivered", "2026-11-01T02:59:59Z", charge),
				event("wamid.earlier", "read", first, charge),
				event("wamid.sent-only", "sent", first, charge),
				event("wamid.legacy", "delivered", first, { category: "marketing", type: "regular", pricing_model: "CBP" }),
				event("wamid.unpriced", "delivered", first, { category: "service", billable: true }),
				event("wamid.no-country", "delivered", first, charge, "US.TEST-BSUID"),
				event("wamid.conflict", "sent", first, free),
				event("wamid.conflict", "delivered", first, charge),
				event("wamid.end", "delivered", "2026-12-01T03:00:00Z", charge)
			] });
			await insert("fixture-other", "2026-11-01 03:05:00", { phoneId: "8400", statuses: [
				event("wamid.foreign-receipt", "delivered", first, charge)
			] });
		}

		const asKey = (bucket: MetaCostReceiptBucket) => [
			bucket.clientId, bucket.operatorId, bucket.country, bucket.category, bucket.pricingType
		].join(":");
		for (const db of [central, tenantDb]) {
			const result = await new MetaCostReceiptRepository(db).listMonthly("fixture-sa", channels, bounds);
			assert.equal(result.confirmed, 11);
			assert.equal(result.unattributed, 8);
			assert.equal(result.missingPricing, 3);
			assert.deepEqual(Object.fromEntries(result.buckets.map(entry => [asKey(entry), entry.volume])), {
				"7::BR:marketing:regular": 4,
				"7:::marketing:regular": 1,
				"7::BR::": 3,
				"7:62:BR:marketing:regular": 1,
				"9:41:BR:marketing:regular": 1,
				"12:42::utility:free_entry_point": 1
			});
		}
		await assert.rejects(withDatabaseTenant("fixture-other", async () =>
			new MetaCostReceiptRepository(tenantDb).listMonthly("fixture-sa", channels, bounds)
		), /TENANT_SQL_SCOPE_MISMATCH/);
	} finally {
		await central.$disconnect();
		await pool.end();
		await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
		await admin.end();
	}
});
