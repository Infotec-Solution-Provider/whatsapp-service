import assert from "node:assert/strict";
import { test } from "node:test";
type Snapshot = {
	id: number;
	instance: string;
	customerId: number;
	tagType: string;
	tagValue: string;
	label: string;
	color: string;
	calculatedAt: Date;
	metadataJson: unknown;
};
let snapshots: Snapshot[] = [],
	snapshotReads = 0,
	rawReads = 0,
	crmReads = 0;
const now = new Date("2026-11-13T15:00:00Z");
const saved = new Map<string, NodeModule | undefined>();
function stub(path: string, value: unknown) {
	const filename = require.resolve(path);
	saved.set(filename, require.cache[filename]);
	require.cache[filename] = {
		id: filename,
		filename,
		loaded: true,
		exports: { __esModule: true, default: value }
	} as NodeModule;
}
stub("./prisma.service", {
	customerProfileTag: {
		findMany: async ({ where }: { where: { instance: string; customerId: { in: number[] } } }) => {
			snapshotReads++;
			assert.equal(where.instance, "fixture");
			return snapshots.filter((snapshot) => where.customerId.in.includes(snapshot.customerId));
		}
	},
	$queryRaw: async (query: { sql: string; values: unknown[] }) => {
		rawReads++;
		assert.ok(query.values.includes("fixture"));
		assert.match(query.sql, /ct\.instance=\?/);
		assert.match(query.sql, /ct\.is_deleted=0/);
		return [];
	}
});
stub("./instances.service", {
	executeQuery: async (instance: string, sql: string) => {
		crmReads++;
		assert.equal(instance, "fixture");
		assert.ok(sql.includes("GROUP BY CLIENTE") || sql.includes("DATACAD"));
		return [];
	}
});
const service = (require("./customer-profile-tags.service") as typeof import("./customer-profile-tags.service"))
	.default;
for (const [filename, previous] of saved) {
	if (previous) require.cache[filename] = previous;
	else delete require.cache[filename];
}
function reset() {
	snapshots = [];
	snapshotReads = 0;
	rawReads = 0;
	crmReads = 0;
}
function snapshot(tagType: string, tagValue: string, metadataJson: unknown): Snapshot {
	return {
		id: snapshots.length + 1,
		instance: "fixture",
		customerId: 1,
		tagType,
		tagValue,
		label: tagValue,
		color: "#000",
		calculatedAt: now,
		metadataJson
	};
}

test("profile agenda batch calculates missing data with constant query count and no writes", async () => {
	reset();
	const profiles = await service.getCustomerProfileSummariesReadOnly(
		"fixture",
		Array.from({ length: 200 }, (_, index) => index + 1),
		now
	);
	assert.equal(profiles.length, 200);
	assert.equal(snapshotReads, 1);
	assert.equal(rawReads, 2);
	assert.equal(crmReads, 2);
	assert.ok(
		profiles.every(
			(profile) =>
				profile.tags.interaction.tagValue === "sem_interacao" &&
				profile.tags.purchase.tagValue === "sem_compras" &&
				profile.tags.age.tagValue === "sem_data_cadastro"
		)
	);
	assert.ok(
		profiles.every(
			(profile) =>
				profile.tags.interaction.id === 0 && profile.tags.interaction.calculatedAt === now.toISOString()
		)
	);
});
test("existing snapshot semantics and manual overrides are retained without rebuilding", async () => {
	reset();
	snapshots = [
		snapshot("INTERACTION_LEVEL", "interacao_alta", { recentActiveDays90d: 5 }),
		snapshot("PURCHASE_LEVEL", "muitas_compras", {
			manualOverrides: {
				profileLevel: "consolidado",
				purchaseInterestLevel: "alto_interesse",
				updatedAt: now.toISOString(),
				updatedByUserId: 7,
				updatedByName: "Fixture"
			}
		}),
		snapshot("CUSTOMER_AGE", "cliente_novo", { customerAgeMonths: 0, customerAgeDays: 5 })
	];
	const [profile] = await service.getCustomerProfileSummariesReadOnly("fixture", [1, 1], now);
	assert.equal(snapshotReads, 1);
	assert.equal(rawReads, 0);
	assert.equal(crmReads, 0);
	assert.equal(profile?.profileLevel, "consolidado");
	assert.equal(profile?.purchaseInterest.level, "alto_interesse");
	assert.equal(profile?.profileSource, "manual_override");
	assert.equal(profile?.tags.purchase.id, snapshots[1]?.id);
});
test("batch rejects oversized input before any database access and empty reads are free", async () => {
	reset();
	assert.deepEqual(await service.getCustomerProfileSummariesReadOnly("fixture", []), []);
	await assert.rejects(
		() =>
			service.getCustomerProfileSummariesReadOnly(
				"fixture",
				Array.from({ length: 251 }, (_, index) => index + 1)
			),
		/BATCH_TOO_LARGE/
	);
	assert.equal(snapshotReads + rawReads + crmReads, 0);
});
