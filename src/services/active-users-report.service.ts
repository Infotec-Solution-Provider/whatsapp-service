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

const technicalTypes = `('reaction', 'message-reaction', 'system', 'thirdparty:meta', 'notification',
	'notification_template', 'protocol', 'protocolmessage', 'e2e_notification', 'ciphertext',
	'call_log', 'call', 'security', 'unsupported', 'ack', 'receipt', 'revoked')`;
const confirmedStatuses = `('SENT', 'RECEIVED', 'READ', 'DOWNLOADED')`;

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
		AND m.status IN ${confirmedStatuses}
		AND m.type NOT IN ${technicalTypes}
) activity WHERE author_id IS NOT NULL GROUP BY author_id ORDER BY lastSentAt DESC, author_id`;

// Internal sends persist the operator in `from` and the event time as an epoch string.
export const INTERNAL_ACTIVITY_SQL = `SELECT userId, COUNT(*) AS messageCount, MAX(sent_ms) AS lastSentMs
FROM (
	SELECT CAST(SUBSTRING(m.\`from\`, 6) AS UNSIGNED) AS userId,
		CASE WHEN m.timestamp REGEXP '^[0-9]{13}$' THEN CAST(m.timestamp AS UNSIGNED)
			WHEN m.timestamp REGEXP '^[0-9]{10}$' THEN CAST(m.timestamp AS UNSIGNED) * 1000 END AS sent_ms
	FROM internalmessages m
	WHERE m.instance = ? AND m.\`from\` REGEXP '^user:[1-9][0-9]{0,9}$'
		AND m.status IN ${confirmedStatuses} AND m.type NOT IN ${technicalTypes}
) activity
WHERE userId <= 2147483647 AND sent_ms >= ? AND sent_ms <= ?
GROUP BY userId`;

type DbNumber = number | bigint | string;
type Activity = { userId: DbNumber; messageCount: DbNumber };
type UserActivity = { userId: number; whatsappCount: number; internalCount: number; lastSentAt: number };

export function combineUserActivity(
	whatsapp: (Activity & { lastSentAt: Date })[],
	internal: (Activity & { lastSentMs: DbNumber })[]
): UserActivity[] {
	const users = new Map<number, UserActivity>();
	for (const row of whatsapp) {
		const userId = Number(row.userId);
		users.set(userId, {
			userId, whatsappCount: Number(row.messageCount), internalCount: 0, lastSentAt: new Date(row.lastSentAt).getTime()
		});
	}
	for (const row of internal) {
		const userId = Number(row.userId);
		const lastSentAt = Number(row.lastSentMs);
		const existing = users.get(userId);
		users.set(userId, {
			userId, whatsappCount: existing?.whatsappCount ?? 0, internalCount: Number(row.messageCount),
			lastSentAt: Math.max(existing?.lastSentAt ?? lastSentAt, lastSentAt)
		});
	}
	return [...users.values()].sort((a, b) => b.lastSentAt - a.lastSentAt || a.userId - b.userId);
}

export async function activeUsersReport(instance: string, now = new Date()) {
	const from = threeMonthsBefore(now);
	const [whatsapp, internal] = await Promise.all([
		database.$queryRawUnsafe<(Activity & { lastSentAt: Date })[]>(ACTIVE_USERS_SQL, instance, from, now),
		database.$queryRawUnsafe<(Activity & { lastSentMs: DbNumber })[]>(INTERNAL_ACTIVITY_SQL, instance, from.getTime(), now.getTime())
	]);
	const rows = combineUserActivity(whatsapp, internal);
	const ids = rows.map(row => row.userId);
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
		users: rows.map(row => ({
			...row, name: names.get(row.userId) ?? null,
			messageCount: row.whatsappCount + row.internalCount, lastSentAt: new Date(row.lastSentAt).toISOString()
		}))
	};
}
