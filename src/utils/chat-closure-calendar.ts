const DAY_MS = 24 * 60 * 60 * 1000;
const localDate = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "America/Sao_Paulo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
});

export function isChatClosureCalendarEnabled(): boolean {
	return process.env["CHAT_AUTO_FINISH_CLOSED_DAYS_ENABLED"] === "true";
}

export function closedDateKey(timestamp: number): string {
	return localDate.format(timestamp);
}

function utcDateKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function isClosedDay(day: number, dates: ReadonlySet<string>): boolean {
	const weekday = new Date(day).getUTCDay();
	return weekday === 0 || weekday === 6 || dates.has(utcDateKey(day));
}

export class ChatClosureCalendar {
	private readonly dayStarts = new Map<number, number>();
	private readonly cutoffs = new Map<number, number>();

	constructor(private readonly dates: ReadonlySet<string>, private readonly now: number) {}

	isClosedAt(timestamp: number): boolean {
		return isClosedDay(Date.parse(closedDateKey(timestamp)), this.dates);
	}

	cutoff(duration: number): number {
		if (!Number.isFinite(duration) || duration < 0) return this.now - duration;
		const cached = this.cutoffs.get(duration);
		if (cached !== undefined) return cached;
		const cutoff = this.findCutoff(duration);
		this.cutoffs.set(duration, cutoff);
		return cutoff;
	}

	// Earliest instant whose elapsed open-day time is still within the given duration.
	private findCutoff(duration: number): number {
		let day = Date.parse(closedDateKey(this.now));
		let end = this.now;
		let remaining = duration;
		for (;;) {
			const start = this.dayStart(day);
			if (!isClosedDay(day, this.dates)) {
				const elapsed = end - start;
				if (remaining < elapsed) return end - remaining;
				remaining -= elapsed;
			}
			day -= DAY_MS;
			end = start;
		}
	}

	private dayStart(day: number): number {
		const cached = this.dayStarts.get(day);
		if (cached !== undefined) return cached;

		// Find the first instant of the local date, including historical offset changes.
		const date = utcDateKey(day);
		let before = day - DAY_MS / 2;
		let start = day + DAY_MS / 2;
		while (start - before > 1) {
			const middle = Math.floor((before + start) / 2);
			if (closedDateKey(middle) < date) before = middle;
			else start = middle;
		}
		this.dayStarts.set(day, start);
		return start;
	}
}
