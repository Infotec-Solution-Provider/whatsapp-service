import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNewContactsQuery } from "./new-contacts-report.contract";
import { buildNewContactsQueries } from "./new-contacts-report.query";

test("interprets both end dates in São Paulo time and counts civil days", () => {
	const oneDay = parseNewContactsQuery({ filters: { from: "2026-11-24", to: "2026-11-24" } });
	assert.equal(oneDay.from.toISOString(), "2026-11-24T03:00:00.000Z");
	assert.equal(oneDay.toExclusive.toISOString(), "2026-11-25T03:00:00.000Z");
	const daylightSaving = parseNewContactsQuery({ filters: { from: "2018-11-04", to: "2018-11-04" } });
	assert.equal(daylightSaving.from.toISOString(), "2018-11-04T03:00:00.000Z");
	assert.equal(daylightSaving.toExclusive.toISOString(), "2018-11-05T02:00:00.000Z");
	assert.doesNotThrow(() => parseNewContactsQuery({ filters: { from: "2026-01-01", to: "2026-03-31" } }));
	assert.throws(() => parseNewContactsQuery({ filters: { from: "2026-01-01", to: "2026-04-01" } }));
	assert.throws(() => parseNewContactsQuery({ filters: { from: "2026-02-29", to: "2026-03-01" } }));
	assert.throws(() => parseNewContactsQuery({ filters: { from: "2026-11-25", to: "2026-11-24" } }));
});

test("rejects tenant overrides and invalid filter values", () => {
	const filters = { from: "2026-11-24", to: "2026-11-24" };
	assert.throws(() => parseNewContactsQuery({ filters, instance: "odim" }));
	assert.throws(() => parseNewContactsQuery({ filters: { ...filters, firstResponderIds: ["1"] } }));
	assert.throws(() => parseNewContactsQuery({ filters, exportLimit: 10_001 }));
	assert.throws(() => parseNewContactsQuery({ filters, sort: { field: "firstInboundAt", direction: "invalid" } }));
});

test("binds filters and keeps the requested export ordering without pagination", () => {
	const query = parseNewContactsQuery({
		filters: {
			from: "2026-11-24", to: "2026-11-24", firstChannelIds: [11, 11],
			ownerIds: [12], firstResponderIds: [13], status: "finished", linked: true
		},
		exportLimit: 500,
		page: 3,
		sort: { field: "firstInboundAt", direction: "asc" }
	});
	const { summary, rows } = buildNewContactsQueries("suprimaxxi", query, new Date("2026-11-25T00:00:00Z"));
	assert.equal(summary.sql.match(/\?/g)?.length, summary.params.length);
	assert.equal(rows.sql.match(/\?/g)?.length, rows.params.length);
	assert.deepEqual(summary.params.slice(-4), [11, 12, 13, "finished"]);
	assert.deepEqual(rows.params.slice(-6), [11, 12, 13, "finished", 501, 0]);
	assert.match(rows.sql, /ORDER BY r\.firstInboundAt ASC, r\.contactId ASC/);
});

test("reads explicit export batches without the legacy overflow row", () => {
	const filters = { from: "2026-11-24", to: "2026-11-24" };
	for (const exportOffset of [0, 1_000]) {
		const query = parseNewContactsQuery({ filters, exportLimit: 1_000, exportOffset });
		const { rows } = buildNewContactsQueries("suprimaxxi", query, new Date("2026-11-25T00:00:00Z"));
		assert.deepEqual(rows.params.slice(-2), [1_000, exportOffset]);
	}

	assert.throws(() => parseNewContactsQuery({ filters, exportOffset: 0 }));
	for (const exportOffset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null]) {
		assert.throws(() => parseNewContactsQuery({ filters, exportLimit: 1_000, exportOffset }));
	}
});
