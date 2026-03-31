import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import transferHistoryService from "./transfer-history.service";

interface OperatorRow {
	CODIGO: number;
	NOME: string;
	ATIVO: string | number | null;
	NIVEL: string | number | null;
	SETOR: number | null;
	SETOR_NOME?: string | null;
}

interface OperatorMessagesAggregateRow {
	operatorId: number | null;
	messagesCount: bigint | number;
	sentMessagesCount: bigint | number;
	receivedMessagesCount: bigint | number;
	chatsHandledCount: bigint | number;
	contactsCount: bigint | number;
}

interface OperatorFinishedChatsAggregateRow {
	operatorId: number | null;
	chatsFinishedCount: bigint | number;
	averageHandlingSeconds: number | string | null;
}

interface OperatorFirstResponseAggregateRow {
	operatorId: number | null;
	respondedChatsCount: bigint | number;
	averageFirstResponseSeconds: number | string | null;
}

interface OperatorPendingReturnsAggregateRow {
	operatorId: number | null;
	pendingReturnsCount: bigint | number;
}

interface DailyMetricsAggregateRow {
	day: string | Date;
	messagesCount?: bigint | number;
	sentMessagesCount?: bigint | number;
	receivedMessagesCount?: bigint | number;
	chatsFinishedCount?: bigint | number;
	pendingReturnsCount?: bigint | number;
	transfersSentCount?: bigint | number;
	transfersReceivedCount?: bigint | number;
	averageFirstResponseSeconds?: number | string | null;
	averageHandlingSeconds?: number | string | null;
}

interface OperatorPerformancePeriodResult {
	summary: OperatorPerformanceSummary;
	operatorPerformance: OperatorPerformanceRow[];
}

interface DailySeriesMetricsBucket {
	messagesCount: number;
	sentMessagesCount: number;
	receivedMessagesCount: number;
	chatsFinishedCount: number;
	pendingReturnsCount: number;
	transfersSentCount: number;
	transfersReceivedCount: number;
	averageFirstResponseSeconds: number | null;
	averageHandlingSeconds: number | null;
}

export interface OperatorPerformanceRow {
	userId: number;
	userName: string;
	userActive: string | number | null;
	userType: string | number | null;
	userSector: string | null;
	messagesCount: number;
	sentMessagesCount: number;
	receivedMessagesCount: number;
	contactsCount: number;
	chatsHandledCount: number;
	chatsFinishedCount: number;
	respondedChatsCount: number;
	pendingReturnsCount: number;
	transfersSentCount: number;
	transfersReceivedCount: number;
	averageFirstResponseSeconds: number | null;
	averageHandlingSeconds: number | null;
	previousMessagesCount: number;
	previousChatsFinishedCount: number;
	previousPendingReturnsCount: number;
	previousTransfersSentCount: number;
	previousTransfersReceivedCount: number;
	previousAverageFirstResponseSeconds: number | null;
	previousAverageHandlingSeconds: number | null;
}

export interface OperatorPerformanceSummary {
	periodStart: string | null;
	periodEnd: string | null;
	operatorsCount: number;
	messagesCount: number;
	sentMessagesCount: number;
	receivedMessagesCount: number;
	contactsCount: number;
	chatsHandledCount: number;
	chatsFinishedCount: number;
	pendingReturnsCount: number;
	transfersSentCount: number;
	transfersReceivedCount: number;
	averageFirstResponseSeconds: number | null;
	averageHandlingSeconds: number | null;
}

export interface OperatorPerformanceDailySeriesRow {
	date: string;
	label: string;
	previousDate: string | null;
	messagesCount: number;
	chatsFinishedCount: number;
	pendingReturnsCount: number;
	transfersSentCount: number;
	transfersReceivedCount: number;
	averageFirstResponseSeconds: number | null;
	averageHandlingSeconds: number | null;
	previousMessagesCount: number;
	previousChatsFinishedCount: number;
	previousPendingReturnsCount: number;
	previousTransfersSentCount: number;
	previousTransfersReceivedCount: number;
	previousAverageFirstResponseSeconds: number | null;
	previousAverageHandlingSeconds: number | null;
}

export interface OperatorPerformanceReportResult {
	summary: OperatorPerformanceSummary;
	previousSummary: OperatorPerformanceSummary | null;
	comparisonEnabled: boolean;
	operatorPerformance: OperatorPerformanceRow[];
	dailySeries: OperatorPerformanceDailySeriesRow[];
}

const FROM_US_SQL_CONDITION = (alias: string) =>
	`(${alias}.user_id IS NOT NULL OR ${alias}.\`from\` LIKE 'me:%' OR ${alias}.\`from\` LIKE 'user:%' OR ${alias}.\`from\` LIKE 'system:%' OR ${alias}.\`from\` LIKE 'bot%' OR ${alias}.\`from\` LIKE 'thirdparty:%')`;

const SYSTEM_OPERATOR_ID = -1;
const SYSTEM_OPERATOR_NAME = "Sistema/Admin";
const ALL_TIME_START = "2000-01-01";
const ALL_TIME_END = "2099-12-31";
const MAX_DAILY_SERIES_DAYS = 93;

const toNumber = (value: bigint | number | string | null | undefined) => {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
};

const toAverageNumber = (value: number | string | null | undefined) => {
	if (value == null) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const parseBoundaryDate = (value: string | null | undefined, boundary: "start" | "end") => {
	if (!value) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;

	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) return null;

	if (!trimmed.includes("T") && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		if (boundary === "start") {
			date.setHours(0, 0, 0, 0);
		} else {
			date.setHours(23, 59, 59, 999);
		}
	}

	return date;
};

const parseIds = (rawValue: string | null | undefined) => {
	if (!rawValue || rawValue === "*") return null;

	const ids = rawValue
		.split(",")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isInteger(value) && value > 0);

	return ids.length ? Array.from(new Set(ids)) : null;
};

const buildInClause = (field: string, ids: number[] | null) => {
	if (!ids?.length) return "";
	return ` AND ${field} IN (${ids.join(",")})`;
};

const isVisibleOperator = (operatorId: number, operatorsMap: Map<number, OperatorRow>) =>
	operatorId === SYSTEM_OPERATOR_ID || operatorsMap.has(operatorId);

const padDateUnit = (value: number) => String(value).padStart(2, "0");

const formatDateKey = (value: Date) =>
	`${value.getFullYear()}-${padDateUnit(value.getMonth() + 1)}-${padDateUnit(value.getDate())}`;

const formatShortDateLabel = (dateKey: string) => {
	const [year, month, day] = dateKey.split("-");
	if (!year || !month || !day) return dateKey;
	return `${day}/${month}`;
};

const normalizeDayKey = (value: string | Date | null | undefined) => {
	if (!value) return null;
	if (value instanceof Date) return formatDateKey(value);
	if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : formatDateKey(parsed);
};

const shiftDays = (value: Date, amount: number) => {
	const next = new Date(value);
	next.setDate(next.getDate() + amount);
	return next;
};

const enumerateDayKeys = (startDate: Date, endDate: Date) => {
	const dates: string[] = [];
	let cursor = new Date(startDate);
	cursor.setHours(0, 0, 0, 0);

	const end = new Date(endDate);
	end.setHours(0, 0, 0, 0);

	while (cursor.getTime() <= end.getTime()) {
		dates.push(formatDateKey(cursor));
		cursor = shiftDays(cursor, 1);
	}

	return dates;
};

const getRangeLengthInDays = (startDate: Date, endDate: Date) => {
	const start = new Date(startDate);
	start.setHours(0, 0, 0, 0);
	const end = new Date(endDate);
	end.setHours(0, 0, 0, 0);
	return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
};

const getPreviousRange = (startDate: Date, endDate: Date) => {
	const duration = endDate.getTime() - startDate.getTime();
	const previousEnd = new Date(startDate.getTime() - 1);
	const previousStart = new Date(previousEnd.getTime() - duration);
	return { previousStart, previousEnd };
};

const createEmptyDailyBucket = (): DailySeriesMetricsBucket => ({
	messagesCount: 0,
	sentMessagesCount: 0,
	receivedMessagesCount: 0,
	chatsFinishedCount: 0,
	pendingReturnsCount: 0,
	transfersSentCount: 0,
	transfersReceivedCount: 0,
	averageFirstResponseSeconds: null,
	averageHandlingSeconds: null
});

class OperatorPerformanceService {
	private async fetchOperators(instance: string, operatorIds: number[]) {
		if (!operatorIds.length) return new Map<number, OperatorRow>();

		const query = `
			SELECT
				o.CODIGO,
				o.NOME,
				o.ATIVO,
				o.NIVEL,
				o.SETOR,
				s.NOME AS SETOR_NOME
			FROM operadores o
			LEFT JOIN w_setores s ON s.CODIGO = o.SETOR
			WHERE o.CODIGO IN (${operatorIds.join(",")})
		`;

		const rows = await instancesService.executeQuery<OperatorRow[]>(instance, query, []);
		return new Map(rows.map((row) => [row.CODIGO, row]));
	}

	private createOperatorPerformanceRow(operatorId: number, operator?: OperatorRow): OperatorPerformanceRow {
		if (operatorId === SYSTEM_OPERATOR_ID) {
			return {
				userId: SYSTEM_OPERATOR_ID,
				userName: SYSTEM_OPERATOR_NAME,
				userActive: null,
				userType: "ADMIN",
				userSector: null,
				messagesCount: 0,
				sentMessagesCount: 0,
				receivedMessagesCount: 0,
				contactsCount: 0,
				chatsHandledCount: 0,
				chatsFinishedCount: 0,
				respondedChatsCount: 0,
				pendingReturnsCount: 0,
				transfersSentCount: 0,
				transfersReceivedCount: 0,
				averageFirstResponseSeconds: null,
				averageHandlingSeconds: null,
				previousMessagesCount: 0,
				previousChatsFinishedCount: 0,
				previousPendingReturnsCount: 0,
				previousTransfersSentCount: 0,
				previousTransfersReceivedCount: 0,
				previousAverageFirstResponseSeconds: null,
				previousAverageHandlingSeconds: null
			};
		}

		return {
			userId: operatorId,
			userName: operator?.NOME || `#${operatorId}`,
			userActive: operator?.ATIVO || null,
			userType: operator?.NIVEL || null,
			userSector: operator?.SETOR_NOME || null,
			messagesCount: 0,
			sentMessagesCount: 0,
			receivedMessagesCount: 0,
			contactsCount: 0,
			chatsHandledCount: 0,
			chatsFinishedCount: 0,
			respondedChatsCount: 0,
			pendingReturnsCount: 0,
			transfersSentCount: 0,
			transfersReceivedCount: 0,
			averageFirstResponseSeconds: null,
			averageHandlingSeconds: null,
			previousMessagesCount: 0,
			previousChatsFinishedCount: 0,
			previousPendingReturnsCount: 0,
			previousTransfersSentCount: 0,
			previousTransfersReceivedCount: 0,
			previousAverageFirstResponseSeconds: null,
			previousAverageHandlingSeconds: null
		};
	}

	private buildSummary(
		operatorPerformance: OperatorPerformanceRow[],
		startDate: Date | null,
		endDate: Date | null
	): OperatorPerformanceSummary {
		const totalResponses = operatorPerformance.reduce((sum, row) => sum + row.respondedChatsCount, 0);
		const totalHandledFinished = operatorPerformance.reduce((sum, row) => sum + row.chatsFinishedCount, 0);

		return {
			periodStart: startDate ? formatDateKey(startDate) : null,
			periodEnd: endDate ? formatDateKey(endDate) : null,
			operatorsCount: operatorPerformance.length,
			messagesCount: operatorPerformance.reduce((sum, row) => sum + row.messagesCount, 0),
			sentMessagesCount: operatorPerformance.reduce((sum, row) => sum + row.sentMessagesCount, 0),
			receivedMessagesCount: operatorPerformance.reduce((sum, row) => sum + row.receivedMessagesCount, 0),
			contactsCount: operatorPerformance.reduce((sum, row) => sum + row.contactsCount, 0),
			chatsHandledCount: operatorPerformance.reduce((sum, row) => sum + row.chatsHandledCount, 0),
			chatsFinishedCount: totalHandledFinished,
			pendingReturnsCount: operatorPerformance.reduce((sum, row) => sum + row.pendingReturnsCount, 0),
			transfersSentCount: operatorPerformance.reduce((sum, row) => sum + row.transfersSentCount, 0),
			transfersReceivedCount: operatorPerformance.reduce((sum, row) => sum + row.transfersReceivedCount, 0),
			averageFirstResponseSeconds: totalResponses
				? operatorPerformance.reduce((sum, row) => {
					const average = row.averageFirstResponseSeconds ?? 0;
					return sum + average * row.respondedChatsCount;
				}, 0) / totalResponses
				: null,
			averageHandlingSeconds: totalHandledFinished
				? operatorPerformance.reduce((sum, row) => {
					const average = row.averageHandlingSeconds ?? 0;
					return sum + average * row.chatsFinishedCount;
				}, 0) / totalHandledFinished
				: null
		};
	}

	private async buildPeriodPerformance(
		instance: string,
		startDate: Date | null,
		endDate: Date | null,
		operatorIds: number[] | null,
		sectorIds: number[] | null
	): Promise<OperatorPerformancePeriodResult> {
		const messageParams: Array<string | Date> = [instance];
		let messageDateClause = "";
		if (startDate) {
			messageDateClause += " AND msg.sent_at >= ?";
			messageParams.push(startDate);
		}
		if (endDate) {
			messageDateClause += " AND msg.sent_at <= ?";
			messageParams.push(endDate);
		}

		const finishedParams: Array<string | Date> = [instance];
		let finishedDateClause = "";
		if (startDate) {
			finishedDateClause += " AND ch.finished_at >= ?";
			finishedParams.push(startDate);
		}
		if (endDate) {
			finishedDateClause += " AND ch.finished_at <= ?";
			finishedParams.push(endDate);
		}

		const responseParams: Array<string | Date> = [instance, instance];
		let responseDateClause = "";
		if (startDate) {
			responseDateClause += " AND response.sent_at >= ?";
			responseParams.push(startDate);
		}
		if (endDate) {
			responseDateClause += " AND response.sent_at <= ?";
			responseParams.push(endDate);
		}

		const pendingParams: Array<string | Date> = [instance];
		let pendingDateClause = "";
		if (startDate) {
			pendingDateClause += " AND pending.lastCustomerMessageAt >= ?";
			pendingParams.push(startDate);
		}
		if (endDate) {
			pendingDateClause += " AND pending.lastCustomerMessageAt <= ?";
			pendingParams.push(endDate);
		}

		const operatorMessageClause = buildInClause("COALESCE(msg.user_id, ch.user_id)", operatorIds);
		const operatorFinishedClause = buildInClause("COALESCE(ch.finished_by, ch.user_id)", operatorIds);
		const operatorResponseClause = buildInClause("COALESCE(response.user_id, ch.user_id)", operatorIds);
		const operatorPendingClause = buildInClause("ch.user_id", operatorIds);

		const sectorMessageClause = buildInClause("ch.sector_id", sectorIds);
		const sectorFinishedClause = buildInClause("ch.sector_id", sectorIds);
		const sectorResponseClause = buildInClause("ch.sector_id", sectorIds);
		const sectorPendingClause = buildInClause("ch.sector_id", sectorIds);

		const messagesQuery = `
			SELECT
				COALESCE(msg.user_id, ch.user_id) AS operatorId,
				COUNT(*) AS messagesCount,
				SUM(CASE WHEN ${FROM_US_SQL_CONDITION("msg")} THEN 1 ELSE 0 END) AS sentMessagesCount,
				SUM(CASE WHEN NOT ${FROM_US_SQL_CONDITION("msg")} THEN 1 ELSE 0 END) AS receivedMessagesCount,
				COUNT(DISTINCT ch.id) AS chatsHandledCount,
				COUNT(DISTINCT msg.contact_id) AS contactsCount
			FROM messages msg
			LEFT JOIN chats ch ON ch.id = msg.chat_id
			WHERE msg.instance = ?
				AND COALESCE(msg.user_id, ch.user_id) IS NOT NULL
				${messageDateClause}
				${operatorMessageClause}
				${sectorMessageClause}
			GROUP BY operatorId
		`;

		const finishedChatsQuery = `
			SELECT
				COALESCE(ch.finished_by, ch.user_id) AS operatorId,
				COUNT(*) AS chatsFinishedCount,
				AVG(TIMESTAMPDIFF(SECOND, ch.started_at, ch.finished_at)) AS averageHandlingSeconds
			FROM chats ch
			WHERE ch.instance = ?
				AND ch.is_finished = 1
				AND ch.started_at IS NOT NULL
				AND ch.finished_at IS NOT NULL
				AND COALESCE(ch.finished_by, ch.user_id) IS NOT NULL
				${finishedDateClause}
				${operatorFinishedClause}
				${sectorFinishedClause}
			GROUP BY operatorId
		`;

		const firstResponseQuery = `
			SELECT
				responseMetrics.operatorId,
				COUNT(*) AS respondedChatsCount,
				AVG(responseMetrics.firstResponseSeconds) AS averageFirstResponseSeconds
			FROM (
				SELECT
					ch.id AS chatId,
					COALESCE(response.user_id, ch.user_id) AS operatorId,
					TIMESTAMPDIFF(SECOND, customer.firstCustomerMessageAt, response.sent_at) AS firstResponseSeconds
				FROM chats ch
				INNER JOIN (
					SELECT
						msg.chat_id AS chatId,
						MIN(msg.sent_at) AS firstCustomerMessageAt
					FROM messages msg
					WHERE msg.instance = ?
						AND msg.chat_id IS NOT NULL
						AND NOT ${FROM_US_SQL_CONDITION("msg")}
					GROUP BY msg.chat_id
				) customer ON customer.chatId = ch.id
				INNER JOIN messages response ON response.chat_id = ch.id
					AND response.sent_at = (
						SELECT MIN(msg2.sent_at)
						FROM messages msg2
						WHERE msg2.chat_id = ch.id
							AND ${FROM_US_SQL_CONDITION("msg2")}
							AND msg2.sent_at > customer.firstCustomerMessageAt
					)
				WHERE ch.instance = ?
					AND COALESCE(response.user_id, ch.user_id) IS NOT NULL
					${responseDateClause}
					${operatorResponseClause}
					${sectorResponseClause}
			) responseMetrics
			GROUP BY responseMetrics.operatorId
		`;

		const pendingReturnsQuery = `
			SELECT
				pending.operatorId,
				COUNT(*) AS pendingReturnsCount
			FROM (
				SELECT
					ch.id AS chatId,
					ch.user_id AS operatorId,
					(
						SELECT MAX(msg.sent_at)
						FROM messages msg
						WHERE msg.chat_id = ch.id
							AND NOT ${FROM_US_SQL_CONDITION("msg")}
					) AS lastCustomerMessageAt
				FROM chats ch
				WHERE ch.instance = ?
					AND ch.is_finished = 0
					AND ch.user_id IS NOT NULL
					${operatorPendingClause}
					${sectorPendingClause}
			) pending
			WHERE pending.lastCustomerMessageAt IS NOT NULL
				${pendingDateClause}
				AND NOT EXISTS (
					SELECT 1
					FROM messages response
					WHERE response.chat_id = pending.chatId
						AND ${FROM_US_SQL_CONDITION("response")}
						AND response.sent_at > pending.lastCustomerMessageAt
				)
			GROUP BY pending.operatorId
		`;

		const [messageRows, finishedRows, responseRows, pendingRows, transferRows] = await Promise.all([
			prismaService.$queryRawUnsafe<OperatorMessagesAggregateRow[]>(messagesQuery, ...messageParams),
			prismaService.$queryRawUnsafe<OperatorFinishedChatsAggregateRow[]>(finishedChatsQuery, ...finishedParams),
			prismaService.$queryRawUnsafe<OperatorFirstResponseAggregateRow[]>(firstResponseQuery, ...responseParams),
			prismaService.$queryRawUnsafe<OperatorPendingReturnsAggregateRow[]>(pendingReturnsQuery, ...pendingParams),
			transferHistoryService.getOperatorTransferMetrics(instance, startDate, endDate, operatorIds, sectorIds)
		]);

		const operatorIdSet = new Set<number>();
		for (const row of messageRows) {
			if (row.operatorId != null) operatorIdSet.add(row.operatorId);
		}
		for (const row of finishedRows) {
			if (row.operatorId != null) operatorIdSet.add(row.operatorId);
		}
		for (const row of responseRows) {
			if (row.operatorId != null) operatorIdSet.add(row.operatorId);
		}
		for (const row of pendingRows) {
			if (row.operatorId != null) operatorIdSet.add(row.operatorId);
		}
		for (const row of transferRows) {
			if (row.operatorId != null) operatorIdSet.add(row.operatorId);
		}

		if (operatorIds?.length) {
			for (const operatorId of operatorIds) {
				operatorIdSet.add(operatorId);
			}
		}

		const operatorsMap = await this.fetchOperators(instance, Array.from(operatorIdSet).filter((value) => value > 0));
		const rowsMap = new Map<number, OperatorPerformanceRow>();

		const ensureRow = (operatorId: number) => {
			const existing = rowsMap.get(operatorId);
			if (existing) return existing;

			const row = this.createOperatorPerformanceRow(operatorId, operatorsMap.get(operatorId));
			rowsMap.set(operatorId, row);
			return row;
		};

		for (const row of messageRows) {
			if (row.operatorId == null) continue;
			const target = ensureRow(row.operatorId);
			target.messagesCount = toNumber(row.messagesCount);
			target.sentMessagesCount = toNumber(row.sentMessagesCount);
			target.receivedMessagesCount = toNumber(row.receivedMessagesCount);
			target.contactsCount = toNumber(row.contactsCount);
			target.chatsHandledCount = toNumber(row.chatsHandledCount);
		}

		for (const row of finishedRows) {
			if (row.operatorId == null) continue;
			const target = ensureRow(row.operatorId);
			target.chatsFinishedCount = toNumber(row.chatsFinishedCount);
			target.averageHandlingSeconds = toAverageNumber(row.averageHandlingSeconds);
		}

		for (const row of responseRows) {
			if (row.operatorId == null) continue;
			const target = ensureRow(row.operatorId);
			target.respondedChatsCount = toNumber(row.respondedChatsCount);
			target.averageFirstResponseSeconds = toAverageNumber(row.averageFirstResponseSeconds);
		}

		for (const row of pendingRows) {
			if (row.operatorId == null) continue;
			const target = ensureRow(row.operatorId);
			target.pendingReturnsCount = toNumber(row.pendingReturnsCount);
		}

		for (const row of transferRows) {
			if (row.operatorId == null) continue;
			const target = ensureRow(row.operatorId);
			target.transfersSentCount = toNumber(row.transfersSentCount);
			target.transfersReceivedCount = toNumber(row.transfersReceivedCount);
		}

		const operatorPerformance = Array.from(rowsMap.values())
			.filter((row) => isVisibleOperator(row.userId, operatorsMap))
			.sort((left, right) => {
				if (right.chatsFinishedCount !== left.chatsFinishedCount) {
					return right.chatsFinishedCount - left.chatsFinishedCount;
				}
				if (right.messagesCount !== left.messagesCount) {
					return right.messagesCount - left.messagesCount;
				}
				return left.userName.localeCompare(right.userName);
			});

		return {
			summary: this.buildSummary(operatorPerformance, startDate, endDate),
			operatorPerformance
		};
	}

	private async getDailyMetricsMap(
		instance: string,
		startDate: Date,
		endDate: Date,
		operatorIds: number[] | null,
		sectorIds: number[] | null
	) {
		const operatorMessageClause = buildInClause("COALESCE(msg.user_id, ch.user_id)", operatorIds);
		const operatorFinishedClause = buildInClause("COALESCE(ch.finished_by, ch.user_id)", operatorIds);
		const operatorResponseClause = buildInClause("COALESCE(response.user_id, ch.user_id)", operatorIds);
		const operatorPendingClause = buildInClause("ch.user_id", operatorIds);
		const sentOperatorClause = buildInClause("history.from_user_id", operatorIds);
		const receivedOperatorClause = buildInClause("history.to_user_id", operatorIds);

		const sectorMessageClause = buildInClause("ch.sector_id", sectorIds);
		const sectorFinishedClause = buildInClause("ch.sector_id", sectorIds);
		const sectorResponseClause = buildInClause("ch.sector_id", sectorIds);
		const sectorPendingClause = buildInClause("ch.sector_id", sectorIds);
		const transferSectorClause = sectorIds?.length
			? ` AND (history.from_sector_id IN (${sectorIds.join(",")}) OR history.to_sector_id IN (${sectorIds.join(",")}))`
			: "";

		const messagesQuery = `
			SELECT
				DATE(msg.sent_at) AS day,
				COUNT(*) AS messagesCount,
				SUM(CASE WHEN ${FROM_US_SQL_CONDITION("msg")} THEN 1 ELSE 0 END) AS sentMessagesCount,
				SUM(CASE WHEN NOT ${FROM_US_SQL_CONDITION("msg")} THEN 1 ELSE 0 END) AS receivedMessagesCount
			FROM messages msg
			LEFT JOIN chats ch ON ch.id = msg.chat_id
			WHERE msg.instance = ?
				AND msg.sent_at >= ?
				AND msg.sent_at <= ?
				AND COALESCE(msg.user_id, ch.user_id) IS NOT NULL
				${operatorMessageClause}
				${sectorMessageClause}
			GROUP BY DATE(msg.sent_at)
		`;

		const finishedQuery = `
			SELECT
				DATE(ch.finished_at) AS day,
				COUNT(*) AS chatsFinishedCount,
				AVG(TIMESTAMPDIFF(SECOND, ch.started_at, ch.finished_at)) AS averageHandlingSeconds
			FROM chats ch
			WHERE ch.instance = ?
				AND ch.is_finished = 1
				AND ch.started_at IS NOT NULL
				AND ch.finished_at IS NOT NULL
				AND ch.finished_at >= ?
				AND ch.finished_at <= ?
				AND COALESCE(ch.finished_by, ch.user_id) IS NOT NULL
				${operatorFinishedClause}
				${sectorFinishedClause}
			GROUP BY DATE(ch.finished_at)
		`;

		const firstResponseQuery = `
			SELECT
				DATE(responseMetrics.responseAt) AS day,
				AVG(responseMetrics.firstResponseSeconds) AS averageFirstResponseSeconds
			FROM (
				SELECT
					response.sent_at AS responseAt,
					TIMESTAMPDIFF(SECOND, customer.firstCustomerMessageAt, response.sent_at) AS firstResponseSeconds
				FROM chats ch
				INNER JOIN (
					SELECT
						msg.chat_id AS chatId,
						MIN(msg.sent_at) AS firstCustomerMessageAt
					FROM messages msg
					WHERE msg.instance = ?
						AND msg.chat_id IS NOT NULL
						AND NOT ${FROM_US_SQL_CONDITION("msg")}
					GROUP BY msg.chat_id
				) customer ON customer.chatId = ch.id
				INNER JOIN messages response ON response.chat_id = ch.id
					AND response.sent_at = (
						SELECT MIN(msg2.sent_at)
						FROM messages msg2
						WHERE msg2.chat_id = ch.id
							AND ${FROM_US_SQL_CONDITION("msg2")}
							AND msg2.sent_at > customer.firstCustomerMessageAt
					)
				WHERE ch.instance = ?
					AND response.sent_at >= ?
					AND response.sent_at <= ?
					AND COALESCE(response.user_id, ch.user_id) IS NOT NULL
					${operatorResponseClause}
					${sectorResponseClause}
			) responseMetrics
			GROUP BY DATE(responseMetrics.responseAt)
		`;

		const pendingQuery = `
			SELECT
				DATE(pending.lastCustomerMessageAt) AS day,
				COUNT(*) AS pendingReturnsCount
			FROM (
				SELECT
					ch.id AS chatId,
					(
						SELECT MAX(msg.sent_at)
						FROM messages msg
						WHERE msg.chat_id = ch.id
							AND NOT ${FROM_US_SQL_CONDITION("msg")}
					) AS lastCustomerMessageAt
				FROM chats ch
				WHERE ch.instance = ?
					AND ch.is_finished = 0
					AND ch.user_id IS NOT NULL
					${operatorPendingClause}
					${sectorPendingClause}
			) pending
			WHERE pending.lastCustomerMessageAt IS NOT NULL
				AND pending.lastCustomerMessageAt >= ?
				AND pending.lastCustomerMessageAt <= ?
				AND NOT EXISTS (
					SELECT 1
					FROM messages response
					WHERE response.chat_id = pending.chatId
						AND ${FROM_US_SQL_CONDITION("response")}
						AND response.sent_at > pending.lastCustomerMessageAt
				)
			GROUP BY DATE(pending.lastCustomerMessageAt)
		`;

		const transfersQuery = `
			SELECT
				aggregated.day,
				SUM(aggregated.transfersSentCount) AS transfersSentCount,
				SUM(aggregated.transfersReceivedCount) AS transfersReceivedCount
			FROM (
				SELECT
					DATE(history.transferred_at) AS day,
					COUNT(*) AS transfersSentCount,
					0 AS transfersReceivedCount
				FROM chat_transfer_history history
				WHERE history.instance = ?
					AND history.transferred_at >= ?
					AND history.transferred_at <= ?
					AND history.from_user_id IS NOT NULL
					AND history.from_user_id > 0
					${transferSectorClause}
					${sentOperatorClause}
				GROUP BY DATE(history.transferred_at)

				UNION ALL

				SELECT
					DATE(history.transferred_at) AS day,
					0 AS transfersSentCount,
					COUNT(*) AS transfersReceivedCount
				FROM chat_transfer_history history
				WHERE history.instance = ?
					AND history.transferred_at >= ?
					AND history.transferred_at <= ?
					AND history.to_user_id IS NOT NULL
					AND history.to_user_id > 0
					${transferSectorClause}
					${receivedOperatorClause}
				GROUP BY DATE(history.transferred_at)
			) aggregated
			GROUP BY aggregated.day
		`;

		const [messageRows, finishedRows, responseRows, pendingRows, transferRows] = await Promise.all([
			prismaService.$queryRawUnsafe<DailyMetricsAggregateRow[]>(messagesQuery, instance, startDate, endDate),
			prismaService.$queryRawUnsafe<DailyMetricsAggregateRow[]>(finishedQuery, instance, startDate, endDate),
			prismaService.$queryRawUnsafe<DailyMetricsAggregateRow[]>(firstResponseQuery, instance, instance, startDate, endDate),
			prismaService.$queryRawUnsafe<DailyMetricsAggregateRow[]>(pendingQuery, instance, startDate, endDate),
			prismaService.$queryRawUnsafe<DailyMetricsAggregateRow[]>(
				transfersQuery,
				instance,
				startDate,
				endDate,
				instance,
				startDate,
				endDate
			)
		]);

		const metricsMap = new Map<string, DailySeriesMetricsBucket>();
		const ensureBucket = (day: string) => {
			const existing = metricsMap.get(day);
			if (existing) return existing;
			const bucket = createEmptyDailyBucket();
			metricsMap.set(day, bucket);
			return bucket;
		};

		for (const row of messageRows) {
			const day = normalizeDayKey(row.day);
			if (!day) continue;
			const bucket = ensureBucket(day);
			bucket.messagesCount = toNumber(row.messagesCount);
			bucket.sentMessagesCount = toNumber(row.sentMessagesCount);
			bucket.receivedMessagesCount = toNumber(row.receivedMessagesCount);
		}

		for (const row of finishedRows) {
			const day = normalizeDayKey(row.day);
			if (!day) continue;
			const bucket = ensureBucket(day);
			bucket.chatsFinishedCount = toNumber(row.chatsFinishedCount);
			bucket.averageHandlingSeconds = toAverageNumber(row.averageHandlingSeconds);
		}

		for (const row of responseRows) {
			const day = normalizeDayKey(row.day);
			if (!day) continue;
			const bucket = ensureBucket(day);
			bucket.averageFirstResponseSeconds = toAverageNumber(row.averageFirstResponseSeconds);
		}

		for (const row of pendingRows) {
			const day = normalizeDayKey(row.day);
			if (!day) continue;
			const bucket = ensureBucket(day);
			bucket.pendingReturnsCount = toNumber(row.pendingReturnsCount);
		}

		for (const row of transferRows) {
			const day = normalizeDayKey(row.day);
			if (!day) continue;
			const bucket = ensureBucket(day);
			bucket.transfersSentCount = toNumber(row.transfersSentCount);
			bucket.transfersReceivedCount = toNumber(row.transfersReceivedCount);
		}

		return metricsMap;
	}

	private async buildDailySeries(
		instance: string,
		startDate: Date,
		endDate: Date,
		previousStartDate: Date | null,
		previousEndDate: Date | null,
		operatorIds: number[] | null,
		sectorIds: number[] | null
	): Promise<OperatorPerformanceDailySeriesRow[]> {
		const currentDays = enumerateDayKeys(startDate, endDate);
		const currentMetrics = await this.getDailyMetricsMap(instance, startDate, endDate, operatorIds, sectorIds);

		let previousDays: string[] = [];
		let previousMetrics = new Map<string, DailySeriesMetricsBucket>();
		if (previousStartDate && previousEndDate) {
			previousDays = enumerateDayKeys(previousStartDate, previousEndDate);
			previousMetrics = await this.getDailyMetricsMap(
				instance,
				previousStartDate,
				previousEndDate,
				operatorIds,
				sectorIds
			);
		}

		return currentDays.map((date, index) => {
			const current = currentMetrics.get(date) || createEmptyDailyBucket();
			const previousDate = previousDays[index] || null;
			const previous = previousDate ? previousMetrics.get(previousDate) || createEmptyDailyBucket() : createEmptyDailyBucket();

			return {
				date,
				label: formatShortDateLabel(date),
				previousDate,
				messagesCount: current.messagesCount,
				chatsFinishedCount: current.chatsFinishedCount,
				pendingReturnsCount: current.pendingReturnsCount,
				transfersSentCount: current.transfersSentCount,
				transfersReceivedCount: current.transfersReceivedCount,
				averageFirstResponseSeconds: current.averageFirstResponseSeconds,
				averageHandlingSeconds: current.averageHandlingSeconds,
				previousMessagesCount: previous.messagesCount,
				previousChatsFinishedCount: previous.chatsFinishedCount,
				previousPendingReturnsCount: previous.pendingReturnsCount,
				previousTransfersSentCount: previous.transfersSentCount,
				previousTransfersReceivedCount: previous.transfersReceivedCount,
				previousAverageFirstResponseSeconds: previous.averageFirstResponseSeconds,
				previousAverageHandlingSeconds: previous.averageHandlingSeconds
			};
		});
	}

	public async getOperatorPerformance(
		instance: string,
		startDateRaw?: string | null,
		endDateRaw?: string | null,
		operatorsRaw?: string | null,
		sectorsRaw?: string | null
	): Promise<OperatorPerformanceReportResult> {
		const startDate = parseBoundaryDate(startDateRaw, "start");
		const endDate = parseBoundaryDate(endDateRaw, "end");
		const operatorIds = parseIds(operatorsRaw);
		const sectorIds = parseIds(sectorsRaw);

		const currentPeriod = await this.buildPeriodPerformance(instance, startDate, endDate, operatorIds, sectorIds);

		const comparisonEnabled = Boolean(
			startDate &&
			endDate &&
			startDateRaw &&
			endDateRaw &&
			startDateRaw !== ALL_TIME_START &&
			endDateRaw !== ALL_TIME_END
		);

		let previousSummary: OperatorPerformanceSummary | null = null;
		let previousRowsById = new Map<number, OperatorPerformanceRow>();
		let previousStartDate: Date | null = null;
		let previousEndDate: Date | null = null;

		if (comparisonEnabled && startDate && endDate) {
			const previousRange = getPreviousRange(startDate, endDate);
			previousStartDate = previousRange.previousStart;
			previousEndDate = previousRange.previousEnd;

			const previousPeriod = await this.buildPeriodPerformance(
				instance,
				previousStartDate,
				previousEndDate,
				operatorIds,
				sectorIds
			);

			previousSummary = previousPeriod.summary;
			previousRowsById = new Map(previousPeriod.operatorPerformance.map((row) => [row.userId, row]));
		}

		const operatorPerformance = currentPeriod.operatorPerformance.map((row) => {
			const previousRow = previousRowsById.get(row.userId);
			return {
				...row,
				previousMessagesCount: previousRow?.messagesCount ?? 0,
				previousChatsFinishedCount: previousRow?.chatsFinishedCount ?? 0,
				previousPendingReturnsCount: previousRow?.pendingReturnsCount ?? 0,
				previousTransfersSentCount: previousRow?.transfersSentCount ?? 0,
				previousTransfersReceivedCount: previousRow?.transfersReceivedCount ?? 0,
				previousAverageFirstResponseSeconds: previousRow?.averageFirstResponseSeconds ?? null,
				previousAverageHandlingSeconds: previousRow?.averageHandlingSeconds ?? null
			};
		});

		const dailySeries =
			comparisonEnabled &&
			startDate &&
			endDate &&
			getRangeLengthInDays(startDate, endDate) <= MAX_DAILY_SERIES_DAYS
				? await this.buildDailySeries(
					instance,
					startDate,
					endDate,
					previousStartDate,
					previousEndDate,
					operatorIds,
					sectorIds
				)
				: [];

		return {
			summary: currentPeriod.summary,
			previousSummary,
			comparisonEnabled,
			operatorPerformance,
			dailySeries
		};
	}
}

export default new OperatorPerformanceService();