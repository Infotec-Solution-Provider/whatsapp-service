/** Provider event time stays independent of insertion IDs after delayed events
 * or imports. Local fallback dates use the legacy sync writer's wall time. */
export function monitorMessageTime(alias: string, hasSentAt: boolean, offsetMillis = 0): string {
	const numeric = `CAST(${alias}.timestamp AS UNSIGNED)`;
	const fallback = hasSentAt ? `COALESCE(TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',${alias}.sent_at)/1000 + ${offsetMillis},0)` : "0";
	return `CASE WHEN ${alias}.timestamp REGEXP '^[0-9]+$' AND ${numeric}>0 THEN CASE WHEN ${numeric}<100000000000 THEN ${numeric}*1000 ELSE ${numeric} END ELSE ${fallback} END`;
}
