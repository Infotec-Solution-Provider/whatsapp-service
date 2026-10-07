import { parseBoundaryDate } from "./date-boundary";

export type ComparisonRangeSource = "custom" | "previous-period";

export interface ComparisonRange {
	previousStart: Date;
	previousEnd: Date;
	source: ComparisonRangeSource;
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Instante ISO com horário (ex.: 2026-10-06T00:00:00-03:00). Data pura ou texto
 * inválido não servem. Um "+" do deslocamento que chegou como espaço (query sem
 * codificação) é restaurado.
 */
export const parseComparisonInstant = (value: unknown): Date | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().replace(/ (\d{2}:?\d{2})$/, "+$1");
	if (!ISO_INSTANT_PATTERN.test(trimmed)) return null;

	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Limite do comparativo. "AAAA-MM-DD" segue a mesma regra de startDate/endDate
 * (início ou fim do dia no fuso do servidor), recusando datas que não existem
 * (ex.: 2026-02-30); instantes ISO com horário são usados exatamente.
 */
export const parseComparisonBoundary = (value: unknown, boundary: "start" | "end"): Date | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();

	const dateOnlyMatch = trimmed.match(DATE_ONLY_PATTERN);
	if (dateOnlyMatch) {
		const date = parseBoundaryDate(trimmed, boundary);
		const [, year, month, day] = dateOnlyMatch.map(Number);
		const exists =
			date != null &&
			date.getFullYear() === year &&
			date.getMonth() === month! - 1 &&
			date.getDate() === day;
		return exists ? date : null;
	}

	return parseComparisonInstant(trimmed);
};

/** Período de mesma duração imediatamente anterior ao atual. */
export const getPreviousRange = (startDate: Date, endDate: Date) => {
	const duration = endDate.getTime() - startDate.getTime();
	const previousEnd = new Date(startDate.getTime() - 1);
	const previousStart = new Date(previousEnd.getTime() - duration);
	return { previousStart, previousEnd };
};

/**
 * Intervalo do comparativo: o informado (compareStartDate/compareEndDate) quando
 * os dois são válidos e o início vem antes do fim; senão, o período anterior de
 * mesma duração. O campo source diz qual dos dois foi usado.
 */
export const resolveComparisonRange = (
	startDate: Date,
	endDate: Date,
	compareStartRaw?: unknown,
	compareEndRaw?: unknown
): ComparisonRange => {
	const compareStart = parseComparisonBoundary(compareStartRaw, "start");
	const compareEnd = parseComparisonBoundary(compareEndRaw, "end");

	if (compareStart && compareEnd && compareStart.getTime() < compareEnd.getTime()) {
		return { previousStart: compareStart, previousEnd: compareEnd, source: "custom" };
	}

	return { ...getPreviousRange(startDate, endDate), source: "previous-period" };
};

export const describeComparisonRange = (range: ComparisonRange) => ({
	startDate: range.previousStart.toISOString(),
	endDate: range.previousEnd.toISOString(),
	source: range.source
});
