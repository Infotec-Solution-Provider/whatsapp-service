/**
 * "AAAA-MM-DD" vira início/fim do dia no fuso do servidor; qualquer outro texto
 * aceito por Date (ex.: instante ISO) é usado como veio.
 */
export const parseBoundaryDate = (value: string | null | undefined, boundary: "start" | "end") => {
	if (!value) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;

	const simpleDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (simpleDateMatch) {
		const [, yearRaw, monthRaw, dayRaw] = simpleDateMatch;
		const year = Number(yearRaw);
		const month = Number(monthRaw);
		const day = Number(dayRaw);

		if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
			return null;
		}

		if (boundary === "start") {
			return new Date(year, month - 1, day, 0, 0, 0, 0);
		}

		return new Date(year, month - 1, day, 23, 59, 59, 999);
	}

	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) return null;

	return date;
};
