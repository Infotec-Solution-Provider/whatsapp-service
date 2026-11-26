import instancesService from "./instances.service";
import database from "./prisma.service";

// Preserve the time of day and clamp month ends (e.g. 31 May -> 28 February).
export function threeMonthsBefore(now: Date): Date {
	const start = new Date(now);
	const day = start.getUTCDate();
	start.setUTCDate(1);
	start.setUTCMonth(start.getUTCMonth() - 3);
	const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
	start.setUTCDate(Math.min(day, lastDay));
	return start;
}

export const ACTIVE_USERS_SQL = `SELECT author_id AS userId, COUNT(*) AS messageCount, MAX(sent_at) AS lastSentAt
FROM (
	SELECT m.sent_at, CASE WHEN m.user_id > 0 THEN m.user_id
		WHEN m.\`from\` REGEXP '^user:[1-9][0-9]{0,9}$'
			AND CAST(SUBSTRING(m.\`from\`, 6) AS UNSIGNED) <= 2147483647
		THEN CAST(SUBSTRING(m.\`from\`, 6) AS UNSIGNED) END AS author_id
	FROM messages m
	WHERE m.instance = ? AND m.sent_at >= ? AND m.sent_at <= ?
		AND (m.\`from\` LIKE 'me:%' OR m.\`from\` LIKE 'user:%')
		AND m.agent_id IS NULL
		AND (m.billing_category IS NULL OR m.billing_category NOT LIKE 'AUTO_REPLY%')
		AND m.status IN ('SENT', 'RECEIVED', 'READ', 'DOWNLOADED')
		AND m.type NOT IN ('reaction', 'message-reaction', 'system', 'thirdparty:meta', 'notification',
			'notification_template', 'protocol', 'protocolmessage', 'e2e_notification', 'ciphertext',
			'call_log', 'call', 'security', 'unsupported', 'ack', 'receipt', 'revoked')
) activity WHERE author_id IS NOT NULL GROUP BY author_id ORDER BY lastSentAt DESC, author_id`;

export async function activeUsersReport(instance: string, now = new Date()) {
	const from = threeMonthsBefore(now);
	const rows = await database.$queryRawUnsafe<Array<{ userId: number | bigint; messageCount: number | bigint; lastSentAt: Date }>>(
		ACTIVE_USERS_SQL, instance, from, now
	);
	const ids = rows.map(row => Number(row.userId));
	const names = new Map<number, string>();
	for (let offset = 0; offset < ids.length; offset += 250) {
		const batch = ids.slice(offset, offset + 250);
		const operators = await instancesService.executeQuery<Array<{ CODIGO: number; NOME: string }>>(
			instance, `SELECT CODIGO, NOME FROM operadores WHERE CODIGO IN (${batch.map(() => "?").join(", ")})`, batch
		);
		for (const operator of operators) names.set(Number(operator.CODIGO), operator.NOME);
	}
	return {
		from: from.toISOString(), to: now.toISOString(),
		users: rows.map(row => ({ userId: Number(row.userId), name: names.get(Number(row.userId)) ?? null,
			messageCount: Number(row.messageCount), lastSentAt: new Date(row.lastSentAt).toISOString() }))
	};
}
