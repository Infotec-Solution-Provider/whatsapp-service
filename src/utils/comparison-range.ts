export interface ComparisonRange {
	previousStart: Date;
	previousEnd: Date;
	source: "custom" | "previous-period";
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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

/** Período de mesma duração imediatamente anterior ao atual. */
export const getPreviousRange = (startDate: Date, endDate: Date) => {
	const duration = endDate.getTime() - startDate.getTime();
	const previousEnd = new Date(startDate.getTime() - 1);
	const previousStart = new Date(previousEnd.getTime() - duration);
	return { previousStart, previousEnd };
};

/**
 * Intervalo do comparativo: o informado (compareStartDate/compareEndDate), como
 * instantes exatos, quando os dois são válidos e o início vem antes do fim;
 * senão, o período anterior de mesma duração.
 */
export const resolveComparisonRange = (
	startDate: Date,
	endDate: Date,
	compareStartRaw?: unknown,
	compareEndRaw?: unknown
): ComparisonRange => {
	const compareStart = parseComparisonInstant(compareStartRaw);
	const compareEnd = parseComparisonInstant(compareEndRaw);

	if (compareStart && compareEnd && compareStart.getTime() < compareEnd.getTime()) {
		return { previousStart: compareStart, previousEnd: compareEnd, source: "custom" };
	}

	return { ...getPreviousRange(startDate, endDate), source: "previous-period" };
};

export const describeComparisonRange = (range: Pick<ComparisonRange, "previousStart" | "previousEnd">) => ({
	startDate: range.previousStart.toISOString(),
	endDate: range.previousEnd.toISOString()
});
