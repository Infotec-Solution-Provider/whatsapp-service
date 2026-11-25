import { CUSTOMER_MESSAGE_SQL_CONDITION } from "../utils/operator-report-sql";
import type { NewContactsQuery } from "./new-contacts-report.contract";

function realIndividualMessage(alias: string) {
	return `${alias}.agent_id IS NULL
		AND ${alias}.type NOT IN (
			'reaction', 'message-reaction', 'system', 'thirdparty:meta', 'notification',
			'notification_template', 'protocol', 'protocolmessage', 'e2e_notification',
			'ciphertext', 'call_log', 'call', 'security', 'unsupported', 'ack', 'receipt', 'revoked'
		)
		AND ${alias}.\`from\` NOT LIKE '%@g.us'
		AND ${alias}.\`to\` NOT LIKE '%@g.us'
		AND ${alias}.\`from\` NOT REGEXP '^[0-9]+-[0-9]+$'
		AND ${alias}.\`to\` NOT REGEXP '^[0-9]+-[0-9]+$'`;
}

function incoming(alias: string) {
	return `${CUSTOMER_MESSAGE_SQL_CONDITION(alias)}
		AND ${realIndividualMessage(alias)}
		AND ${alias}.status NOT IN ('PENDING', 'ERROR')`;
}

const replyAuthor = `CASE
	WHEN reply.user_id > 0 THEN reply.user_id
	WHEN reply.\`from\` REGEXP '^user:[1-9][0-9]{0,9}$'
		AND CAST(SUBSTRING(reply.\`from\`, 6) AS UNSIGNED) <= 2147483647
	THEN CAST(SUBSTRING(reply.\`from\`, 6) AS UNSIGNED)
	ELSE NULL
END`;

export function buildNewContactsQueries(instance: string, query: NewContactsQuery, queriedAt: Date) {
	const filterParams: unknown[] = [];
	const filters: string[] = [];
	const fields = {
		firstChannelIds: "firstChannelId",
		sectorIds: "sectorId",
		ownerIds: "ownerId",
		firstResponderIds: "firstResponderId"
	} as const;
	const includeReplyInSummary = query.ids.firstResponderIds.length > 0;

	for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
		const values = query.ids[key];
		if (values.length) {
			filters.push(`r.${fields[key]} IN (${values.map(() => "?").join(", ")})`);
			filterParams.push(...values);
		}
	}
	if (query.ownership) filters.push(query.ownership === "assigned" ? "r.ownerId IS NOT NULL" : "r.ownerId IS NULL");
	if (query.linked !== undefined) filters.push(query.linked ? "r.customerId IS NOT NULL" : "r.customerId IS NULL");
	if (query.status) {
		filters.push("r.status = ?");
		filterParams.push(query.status);
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const replyProjection = `${replyAuthor} AS firstResponderId, reply.sent_at AS firstReplyAt,`;
	const replyJoin = `LEFT JOIN chats entry
			ON entry.id = a.chat_id AND entry.instance = a.instance AND entry.contact_id = a.contact_id
		LEFT JOIN messages reply ON reply.instance = a.instance AND reply.id = (
			SELECT sent.id
			FROM messages sent
			WHERE sent.instance = a.instance AND sent.chat_id = entry.id
				AND (sent.contact_id IS NULL OR sent.contact_id = a.contact_id)
				AND sent.sent_at <= ?
				AND (sent.sent_at > a.sent_at OR (sent.sent_at = a.sent_at AND sent.id > a.id))
				AND (sent.\`from\` LIKE 'me:%' OR sent.\`from\` LIKE 'user:%')
				AND sent.status IN ('SENT', 'RECEIVED', 'READ', 'DOWNLOADED')
				AND (sent.billing_category IS NULL OR sent.billing_category NOT LIKE 'AUTO_REPLY%')
				AND ${realIndividualMessage("sent")}
			ORDER BY sent.sent_at, sent.id
			LIMIT 1
		)`;
	const cohort = (includeReply: boolean) => `WITH arrivals_in_period AS (
		SELECT m.id, m.instance, m.contact_id, m.chat_id, m.client_id, m.sent_at,
			ROW_NUMBER() OVER (PARTITION BY m.contact_id ORDER BY m.sent_at, m.id) AS occurrence
		FROM messages m
		WHERE m.instance = ? AND m.sent_at >= ? AND m.sent_at < ? AND m.sent_at <= ?
			AND m.contact_id IS NOT NULL AND ${incoming("m")}
	), report_rows AS (
		SELECT a.contact_id AS contactId, a.instance, a.sent_at AS firstInboundAt,
			CASE WHEN NOT contact.is_deleted THEN contact.name END AS contactName,
			CASE WHEN contact.customer_id > 0 THEN contact.customer_id END AS customerId,
			a.client_id AS firstChannelId,
			${includeReply ? replyProjection : ""}
			latest.id AS latestChatId,
			CASE WHEN latest.user_id > 0 THEN latest.user_id END AS ownerId,
			latest.sector_id AS sectorId,
			CASE
				WHEN latest.id IS NULL THEN 'no_chat'
				WHEN latest.is_finished THEN 'finished'
				ELSE 'open'
			END AS status
		FROM arrivals_in_period a
		JOIN contacts contact ON contact.id = a.contact_id AND contact.instance = a.instance
		LEFT JOIN chats latest ON latest.instance = a.instance AND latest.id = (
			SELECT ch.id FROM chats ch
			WHERE ch.instance = a.instance AND ch.contact_id = a.contact_id
				AND (ch.started_at <= ? OR ch.started_at IS NULL)
			ORDER BY ch.started_at DESC, ch.id DESC
			LIMIT 1
		)
		${includeReply ? replyJoin : ""}
		WHERE a.occurrence = 1
			AND COALESCE(contact.whatsapp_id, '') NOT LIKE '%@g.us'
			AND NOT EXISTS (
				SELECT 1 FROM messages earlier
				WHERE earlier.instance = a.instance AND earlier.contact_id = a.contact_id
					AND earlier.sent_at < ? AND ${incoming("earlier")}
			)
	)`;

	const baseParams = (includeReply: boolean) => [
		instance, query.from, query.toExclusive, queriedAt, queriedAt,
		...(includeReply ? [queriedAt] : []), query.from, ...filterParams
	];
	const direction = query.direction === "asc" ? "ASC" : "DESC";
	return {
		summary: {
			sql: `${cohort(includeReplyInSummary)}
				SELECT /*+ MAX_EXECUTION_TIME(8000) */ r.ownerId, COUNT(*) AS count
				FROM report_rows r
				${where}
				GROUP BY r.ownerId
				ORDER BY count DESC, r.ownerId`,
			params: baseParams(includeReplyInSummary)
		},
		rows: {
			sql: `${cohort(true)}
				SELECT /*+ MAX_EXECUTION_TIME(8000) */
					r.contactId, r.contactName, r.customerId, r.firstInboundAt,
					r.firstChannelId, first_channel.name AS firstChannelName,
					r.firstResponderId, r.firstReplyAt,
					CASE
						WHEN r.firstReplyAt IS NULL THEN 'none'
						WHEN r.firstResponderId IS NULL THEN 'unidentified'
						ELSE 'identified'
					END AS firstReplyStatus,
					CASE WHEN r.firstResponderId IS NOT NULL
						THEN TIMESTAMPDIFF(SECOND, r.firstInboundAt, r.firstReplyAt)
					END AS firstReplySeconds,
					r.latestChatId, r.ownerId, r.sectorId, sector.name AS sectorName, r.status
				FROM report_rows r
				LEFT JOIN clients first_channel ON first_channel.id = r.firstChannelId AND first_channel.instance = r.instance
				LEFT JOIN sectors sector ON sector.id = r.sectorId AND sector.instance = r.instance
				${where}
				ORDER BY r.firstInboundAt ${direction}, r.contactId ASC
				LIMIT ? OFFSET ?`,
			params: [...baseParams(true), query.limit, query.offset]
		}
	};
}
