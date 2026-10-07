import assert from "node:assert/strict";
import {
	describeComparisonRange,
	getPreviousRange,
	parseComparisonInstant,
	resolveComparisonRange
} from "./comparison-range";

const iso = (value: Date | null) => (value ? value.toISOString() : null);

// Período atual: dia 06/10 de São Paulo, como o ai-service envia.
const start = new Date("2026-10-06T00:00:00-03:00");
const end = new Date("2026-10-06T23:59:59.999-03:00");

// parseComparisonInstant: só instantes ISO com horário.
assert.equal(iso(parseComparisonInstant("2026-10-05T00:00:00-03:00")), "2026-10-05T03:00:00.000Z");
assert.equal(iso(parseComparisonInstant("2026-10-05T03:00:00Z")), "2026-10-05T03:00:00.000Z");
assert.equal(iso(parseComparisonInstant(" 2026-10-05T08:30:00.250-03:00 ")), "2026-10-05T11:30:00.250Z");
// "+" do deslocamento que virou espaço na query.
assert.equal(iso(parseComparisonInstant("2026-10-05T00:00:00 03:00")), "2026-10-04T21:00:00.000Z");
assert.equal(parseComparisonInstant("2026-10-05"), null);
assert.equal(parseComparisonInstant("ontem"), null);
assert.equal(parseComparisonInstant(""), null);
assert.equal(parseComparisonInstant("2026-13-45T99:99:00-03:00"), null);
assert.equal(parseComparisonInstant(null), null);
assert.equal(parseComparisonInstant(undefined), null);
assert.equal(parseComparisonInstant(["2026-10-05T00:00:00-03:00"]), null);

// Sem comparativo informado: período anterior de mesma duração (comportamento de antes).
const previous = getPreviousRange(start, end);
assert.equal(iso(previous.previousStart), "2026-10-05T03:00:00.000Z");
assert.equal(iso(previous.previousEnd), "2026-10-06T02:59:59.999Z");

const fallback = resolveComparisonRange(start, end);
assert.equal(fallback.source, "previous-period");
assert.deepEqual(describeComparisonRange(fallback), {
	startDate: "2026-10-05T03:00:00.000Z",
	endDate: "2026-10-06T02:59:59.999Z"
});

// Comparativo informado: usado exatamente, sem arredondar para o dia.
const lastWeek = resolveComparisonRange(start, end, "2026-09-29T00:00:00-03:00", "2026-09-29T23:59:59.999-03:00");
assert.equal(lastWeek.source, "custom");
assert.deepEqual(describeComparisonRange(lastWeek), {
	startDate: "2026-09-29T03:00:00.000Z",
	endDate: "2026-09-30T02:59:59.999Z"
});

const partialDay = resolveComparisonRange(start, end, "2026-10-05T08:30:00-03:00", "2026-10-05T12:15:00-03:00");
assert.equal(partialDay.source, "custom");
assert.deepEqual(describeComparisonRange(partialDay), {
	startDate: "2026-10-05T11:30:00.000Z",
	endDate: "2026-10-05T15:15:00.000Z"
});

// Duração diferente do período atual também vale (ex.: mês anterior inteiro).
const lastMonth = resolveComparisonRange(start, end, "2026-09-01T00:00:00-03:00", "2026-09-30T23:59:59.999-03:00");
assert.equal(lastMonth.source, "custom");
assert.equal(iso(lastMonth.previousStart), "2026-09-01T03:00:00.000Z");
assert.equal(iso(lastMonth.previousEnd), "2026-10-01T02:59:59.999Z");

// Inválido, incompleto ou invertido: volta ao período anterior.
const fallbackCases: Array<[unknown, unknown]> = [
	["2026-10-05T00:00:00-03:00", undefined],
	[undefined, "2026-10-05T23:59:59-03:00"],
	["2026-10-05T23:59:59-03:00", "2026-10-05T00:00:00-03:00"],
	["2026-10-05T10:00:00-03:00", "2026-10-05T10:00:00-03:00"],
	["2026-10-05", "2026-10-05"],
	["ontem", "hoje"],
	[null, null]
];
for (const [compareStart, compareEnd] of fallbackCases) {
	const range = resolveComparisonRange(start, end, compareStart, compareEnd);
	assert.equal(range.source, "previous-period", `${String(compareStart)} / ${String(compareEnd)}`);
	assert.deepEqual(describeComparisonRange(range), describeComparisonRange(fallback));
}

console.log("comparison-range: ok");
