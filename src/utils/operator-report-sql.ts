// Internal SQL fragments only: expressions/clauses are constants from the report service, never request text.
const SYSTEM_OR_THIRDPARTY_SQL_CONDITION = (alias: string) =>
	`(${alias}.\`from\` LIKE 'system%' OR ${alias}.\`to\` LIKE 'system%' OR ${alias}.\`from\` LIKE 'thirdparty:%' OR ${alias}.\`to\` LIKE 'thirdparty:%' OR ${alias}.\`from\` LIKE 'bot%' OR ${alias}.\`to\` LIKE 'bot%')`;

export const OPERATION_MESSAGE_SQL_CONDITION = (alias: string) =>
	`(${alias}.user_id IS NOT NULL OR ${alias}.\`from\` LIKE 'me:%' OR ${alias}.\`from\` LIKE 'user:%')`;

export const CUSTOMER_MESSAGE_SQL_CONDITION = (alias: string) =>
	`(NOT ${SYSTEM_OR_THIRDPARTY_SQL_CONDITION(alias)} AND NOT ${OPERATION_MESSAGE_SQL_CONDITION(alias)} AND ${alias}.\`from\` REGEXP '^[0-9]')`;

export const TRIVIAL_POST_CLOSE_FOLLOW_UP_SQL_CONDITION = (
	instanceExpression: string,
	contactIdExpression: string,
	currentChatIdExpression: string,
	messageAtExpression: string,
	bodyExpression: string
) => `(
	${contactIdExpression} IS NOT NULL
	AND ${messageAtExpression} IS NOT NULL
	AND TRIM(LOWER(COALESCE(${bodyExpression}, ''))) REGEXP '^(ok(ay)?|obg|obrigad[oa]s?|valeu|vlw|blz|beleza|bom[[:space:]]+dia|boa[[:space:]]+tarde|boa[[:space:]]+noite|certo|perfeito|show|joia|tmj|thanks?)[[:space:][:punct:]]*$'
	AND EXISTS (
		SELECT 1 FROM chats previous_chat
		WHERE previous_chat.instance = ${instanceExpression}
			AND previous_chat.contact_id = ${contactIdExpression}
			AND previous_chat.id <> ${currentChatIdExpression}
			AND previous_chat.is_finished = 1
			AND previous_chat.finished_at IS NOT NULL
			AND previous_chat.finished_at < ${messageAtExpression}
			AND previous_chat.finished_at >= DATE_SUB(${messageAtExpression}, INTERVAL 1 HOUR)
	)
)`;

/** One source of first customer/operation pairs for KPI, daily series and details. */
export function firstResponseSourceSql(candidateDateClause: string) {
	return `FROM chats ch
	INNER JOIN (
		SELECT DISTINCT msg.chat_id AS chatId
		FROM messages msg
		WHERE msg.instance = ? AND msg.chat_id IS NOT NULL
			AND ${OPERATION_MESSAGE_SQL_CONDITION("msg")}
			${candidateDateClause}
	) responseCandidate ON responseCandidate.chatId = ch.id
	INNER JOIN messages customer ON customer.id = (
		SELECT msg2.id FROM messages msg2
		WHERE msg2.instance = ch.instance AND msg2.chat_id = ch.id
			AND ${CUSTOMER_MESSAGE_SQL_CONDITION("msg2")}
		ORDER BY msg2.sent_at ASC, msg2.id ASC LIMIT 1
	)
	INNER JOIN messages response ON response.id = (
		SELECT msg3.id FROM messages msg3
		WHERE msg3.instance = ch.instance AND msg3.chat_id = ch.id
			AND ${OPERATION_MESSAGE_SQL_CONDITION("msg3")}
			AND msg3.sent_at > customer.sent_at
		ORDER BY msg3.sent_at ASC, msg3.id ASC LIMIT 1
	)`;
}

// Preserve the existing metric: SQL date of stored timestamps, not working hours or a new timezone policy.
export const FIRST_RESPONSE_ELIGIBILITY_SQL = `response.sent_at IS NOT NULL
	AND COALESCE(response.user_id, ch.user_id) IS NOT NULL
	AND DATE(customer.sent_at) = DATE(response.sent_at)
	AND NOT ${TRIVIAL_POST_CLOSE_FOLLOW_UP_SQL_CONDITION("ch.instance", "ch.contact_id", "ch.id", "customer.sent_at", "customer.body")}`;
