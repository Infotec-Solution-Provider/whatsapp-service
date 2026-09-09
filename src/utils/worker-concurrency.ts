/** Keep background work bounded while HTTP requests share the same Prisma pool. */
export function resolveWorkerConcurrency(value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) return 4;
	return Math.min(8, Math.floor(parsed));
}
