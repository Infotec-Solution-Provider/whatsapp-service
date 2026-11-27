import { MetaGraphError } from "./meta-management.graph";
import type { MetaCostReceiptReport } from "./meta-cost-receipts";

export const META_COST_TIME_ZONE = "America/Sao_Paulo";
const localDate = new Intl.DateTimeFormat("sv-SE", {
	timeZone: META_COST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
});
const DAY_MS = 24 * 60 * 60 * 1000;

function localMonthStart(year: number, monthIndex: number): Date {
	const utc = Date.UTC(year, monthIndex, 1);
	const dateKey = new Date(utc).toISOString().slice(0, 10);
	let before = utc - DAY_MS;
	let first = utc + DAY_MS;
	while (first - before > 1) {
		const middle = Math.floor((before + first) / 2);
		if (localDate.format(middle) < dateKey) before = middle;
		else first = middle;
	}
	return new Date(first);
}

export function parseMetaCostPeriod(input: unknown, now = new Date()) {
	const month = input === undefined ? localDate.format(now).slice(0, 7) : input;
	if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
		throw new MetaGraphError(400, "META_COST_INVALID_MONTH", "Informe o mês no formato AAAA-MM.");
	}
	const year = Number(month.slice(0, 4));
	const monthIndex = Number(month.slice(5)) - 1;
	const start = localMonthStart(year, monthIndex);
	const end = new Date(Math.min(now.getTime(), localMonthStart(year, monthIndex + 1).getTime()));
	return { month, start, end };
}

export function parseMetaBudget(input: unknown): number | null {
	if (input && typeof input === "object" && "budgetCents" in input) {
		const value = input.budgetCents;
		if (value === null) return null;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647) {
			return value;
		}
	}
	throw new MetaGraphError(400, "META_COST_INVALID_BUDGET", "Informe um orçamento válido em reais, com até duas casas decimais.");
}

// Meta's official BRL list rates for Brazilian recipients, published for 2026 Q3 and Q4.
// Units are ten-thousandths of a real. New periods need a verified rate card.
const brazilRates = [
	{ firstMonth: "2026-07", lastMonth: "2026-09", rates: { MARKETING: 3217, UTILITY: 350, AUTHENTICATION: 350 } },
	{ firstMonth: "2026-10", lastMonth: "2026-12", rates: { MARKETING: 3217, UTILITY: 350, AUTHENTICATION: 350, SERVICE: 350 } }
] satisfies { firstMonth: string; lastMonth: string; rates: Record<string, number> }[];

const freeTypes = new Set(["FREE_ENTRY_POINT", "FREE_CUSTOMER_SERVICE", "FREE_GROUP_CUSTOMER_SERVICE", "PAID_EXEMPT"]);
const cents = (units: number) => Math.round(units / 100);

export function summarizeMetaReceiptCosts(report: MetaCostReceiptReport, month: string, channelCount: number) {
	const rates: Record<string, number | undefined> = brazilRates.find(({ firstMonth, lastMonth }) =>
		month >= firstMonth && month <= lastMonth
	)?.rates ?? {};
	const categories = new Map<string, { paidMessages: number; freeMessages: number; amount: number }>();
	const operators = new Map<number, { paidMessages: number; unpricedMessages: number; amount: number }>();
	let pricedMessages = 0;
	let unpricedMessages = 0;
	let unclassifiedMessages = 0;
	let total = 0;
	let withoutOperator = 0;
	let withoutOperatorMessages = 0;

	for (const bucket of report.buckets) {
		const rawCategory = bucket.category?.toUpperCase();
		const category = rawCategory === "MARKETING_LITE" ? "MARKETING" : rawCategory;
		const pricingType = bucket.pricingType?.toUpperCase();
		const isPaid = pricingType === "REGULAR";
		const isFree = pricingType !== undefined && freeTypes.has(pricingType);
		const rate = isPaid && category && bucket.country === "BR" ? rates[category] : undefined;
		const amount = (rate ?? 0) * bucket.volume;
		const unclassified = !category || (!isPaid && !isFree);
		const unpriced = Boolean(category && isPaid && rate === undefined);

		if (unclassified) unclassifiedMessages += bucket.volume;
		if (rate !== undefined) pricedMessages += bucket.volume;
		if (unpriced) unpricedMessages += bucket.volume;
		if (category && (isPaid || isFree)) {
			const row = categories.get(category) ?? { paidMessages: 0, freeMessages: 0, amount: 0 };
			if (isPaid) row.paidMessages += bucket.volume;
			else row.freeMessages += bucket.volume;
			row.amount += amount;
			categories.set(category, row);
		}
		total += amount;

		if (bucket.operatorId === null) {
			if (isPaid) withoutOperatorMessages += bucket.volume;
			withoutOperator += amount;
			continue;
		}
		const operator = operators.get(bucket.operatorId) ?? { paidMessages: 0, unpricedMessages: 0, amount: 0 };
		if (isPaid) operator.paidMessages += bucket.volume;
		if (unpriced || unclassified) operator.unpricedMessages += bucket.volume;
		operator.amount += amount;
		operators.set(bucket.operatorId, operator);
	}

	return {
		estimate: {
			currency: "BRL" as const,
			observedMessages: report.confirmed,
			channelCount,
			totalCents: cents(total),
			pricedMessages, unpricedMessages, unclassifiedMessages, withoutOperatorMessages,
			withoutOperatorCents: cents(withoutOperator),
			rows: [...categories.entries()].map(([category, { paidMessages, freeMessages, amount }]) => ({
				category, paidMessages, freeMessages, estimateCents: cents(amount)
			})).sort((a, b) => b.estimateCents - a.estimateCents || a.category.localeCompare(b.category))
		},
		operatorSpend: new Map([...operators.entries()].map(([operatorId, { paidMessages, unpricedMessages, amount }]) =>
			[operatorId, { paidMessages, unpricedMessages, spentCents: cents(amount) }]))
	};
}
