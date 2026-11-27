import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetaBudget, parseMetaCostPeriod, summarizeMetaReceiptCosts } from "./meta-costs.calculation";
import type { MetaCostReceiptReport } from "./meta-cost-receipts";

test("the month uses Brasília boundaries and the current month's cutoff", () => {
	const now = new Date("2026-11-27T13:42:00.000Z");
	const period = parseMetaCostPeriod(undefined, now);
	assert.equal(period.month, "2026-11");
	assert.equal(period.start.toISOString(), "2026-11-01T03:00:00.000Z");
	assert.equal(period.end.toISOString(), now.toISOString());
	assert.equal(parseMetaCostPeriod("2026-10", now).end.toISOString(), period.start.toISOString());
	assert.throws(() => parseMetaCostPeriod(["2026-11"], now), { code: "META_COST_INVALID_MONTH" });
	assert.throws(() => parseMetaCostPeriod("2026-13", now), { code: "META_COST_INVALID_MONTH" });
});

test("zero and removal are distinct from malformed budget amounts", () => {
	assert.equal(parseMetaBudget({ budgetCents: null }), null);
	assert.equal(parseMetaBudget({ budgetCents: 0 }), 0);
	assert.equal(parseMetaBudget({ budgetCents: 5501 }), 5501);
	for (const invalid of [undefined, 1.2, -1, "500", 2147483648]) {
		assert.throws(() => parseMetaBudget({ budgetCents: invalid }), { code: "META_COST_INVALID_BUDGET" });
	}
});

test("only priced Brazilian deliveries consume estimated BRL budget, with fractions rounded after aggregation", () => {
	const report: MetaCostReceiptReport = {
		buckets: [
			{ clientId: 3, operatorId: 5, country: "BR", category: "marketing", pricingType: "regular", volume: 3 },
			{ clientId: 3, operatorId: 5, country: "BR", category: "service", pricingType: "free_customer_service", volume: 5 },
			{ clientId: 3, operatorId: 5, country: "BR", category: "service", pricingType: "regular", volume: 3 },
			{ clientId: 5, operatorId: null, country: "BR", category: "utility", pricingType: "regular", volume: 4 },
			{ clientId: 5, operatorId: 6, country: null, category: "marketing", pricingType: "regular", volume: 2 },
			{ clientId: 5, operatorId: 6, country: "BR", category: null, pricingType: null, volume: 1 }
		],
		confirmed: 18, unattributed: 4, missingPricing: 1
	};
	const { estimate, operatorSpend } = summarizeMetaReceiptCosts(report, "2026-11", 2);
	assert.equal(estimate.totalCents, 121);
	assert.equal(estimate.withoutOperatorCents, 14);
	assert.equal(estimate.withoutOperatorMessages, 4);
	assert.equal(estimate.unpricedMessages, 2);
	assert.equal(estimate.unclassifiedMessages, 1);
	assert.deepEqual(operatorSpend.get(5), { paidMessages: 6, unpricedMessages: 0, spentCents: 107 });
	assert.deepEqual(operatorSpend.get(6), { paidMessages: 2, unpricedMessages: 3, spentCents: 0 });
	assert.equal(summarizeMetaReceiptCosts(report, "2027-01", 2).estimate.unpricedMessages, 12);
});
