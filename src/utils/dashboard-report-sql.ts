import {
	CUSTOMER_MESSAGE_SQL_CONDITION,
	OPERATION_MESSAGE_SQL_CONDITION,
	TRIVIAL_POST_CLOSE_FOLLOW_UP_SQL_CONDITION
} from "./operator-report-sql";

export function buildMessagesPerContactQuery(
	instance: string,
	minDate: Date | null,
	maxDate: Date | null,
	userId: number | null
) {
	const messageConditions = ["msg.instance = ?", "msg.contact_id IS NOT NULL"];
	const messageValues: Array<string | Date | number> = [instance];
	const visitConditions = ["visit.instance = c.instance", "visit.contact_id = c.id"];
	const visitValues: Array<Date | number> = [];

	if (minDate) {
		messageConditions.push("msg.sent_at >= ?");
		messageValues.push(minDate);
		visitConditions.push("visit.started_at >= ?");
		visitValues.push(minDate);
	}

	if (maxDate) {
		messageConditions.push("msg.sent_at <= ?");
		messageValues.push(maxDate);
		visitConditions.push("visit.finished_at <= ?");
		visitValues.push(maxDate);
	}

	if (userId) {
		messageConditions.push("COALESCE(msg.user_id, message_chat.user_id) = ?");
		messageValues.push(userId);
		visitConditions.push("visit.user_id = ?");
		visitValues.push(userId);
	}

	const sent = OPERATION_MESSAGE_SQL_CONDITION("msg");
	const received = CUSTOMER_MESSAGE_SQL_CONDITION("msg");
	const query = `
		SELECT
			c.id AS contactId,
			c.name AS contactName,
			c.customer_id AS customerId,
			COALESCE(metrics.messagesCount, 0) AS messagesCount,
			COALESCE(metrics.sentMessagesCount, 0) AS sentMessagesCount,
			COALESCE(metrics.receivedMessagesCount, 0) AS receivedMessagesCount,
			(SELECT COUNT(*) FROM chats visit WHERE ${visitConditions.join(" AND ")}) AS attendancesCount
		FROM contacts c
		${minDate || maxDate || userId ? "INNER" : "LEFT"} JOIN (
			SELECT
				msg.contact_id AS contactId,
				COUNT(*) AS messagesCount,
				COUNT(CASE WHEN ${sent} THEN 1 END) AS sentMessagesCount,
				COUNT(CASE WHEN ${received} THEN 1 END) AS receivedMessagesCount
			FROM messages msg
			${userId ? `LEFT JOIN chats message_chat ON message_chat.id = msg.chat_id
				AND message_chat.instance = msg.instance AND message_chat.contact_id = msg.contact_id` : ""}
			WHERE ${messageConditions.join(" AND ")} AND (${sent} OR ${received})
			GROUP BY msg.contact_id
		) metrics ON metrics.contactId = c.id
		WHERE c.instance = ?
		ORDER BY c.name, c.id;
	`;

	return { query, values: [...visitValues, ...messageValues, instance] };
}

export const CONTACTS_WAITING_RESPONSE_SQL = `
	SELECT
		ch.id AS CODIGO_ATENDIMENTO,
		ct.name AS CONTATO,
		ct.customer_id AS customerId,
		ch.user_id AS userId,
		ch.sector_id AS sectorId,
		customer.sent_at AS DATA_MENSAGEM_CLIENTE
	FROM chats ch
	JOIN contacts ct ON ct.id = ch.contact_id AND ct.instance = ch.instance
	JOIN messages customer ON customer.id = (
		SELECT msg.id
		FROM messages msg
		WHERE msg.instance = ch.instance AND msg.chat_id = ch.id AND msg.sent_at IS NOT NULL
			AND ${CUSTOMER_MESSAGE_SQL_CONDITION("msg")}
		ORDER BY msg.sent_at DESC, msg.id DESC
		LIMIT 1
	)
	WHERE ch.instance = ?
		AND ch.is_finished = 0
		AND NOT ${TRIVIAL_POST_CLOSE_FOLLOW_UP_SQL_CONDITION("ch.instance", "ch.contact_id", "ch.id", "customer.sent_at", "customer.body")}
		AND NOT EXISTS (
			SELECT 1
			FROM messages reply
			WHERE reply.instance = ch.instance AND reply.chat_id = ch.id
				AND ${OPERATION_MESSAGE_SQL_CONDITION("reply")}
				AND reply.sent_at > customer.sent_at
		)
	ORDER BY customer.sent_at ASC, ch.id ASC;
`;
