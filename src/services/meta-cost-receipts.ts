import { currentDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";
import database, { type DatabaseClient } from "./prisma.service";

export interface MetaCostReceiptChannel {
	clientId: number;
	phoneId: string;
}

export interface MetaCostReceiptBucket {
	clientId: number;
	operatorId: number | null;
	country: "BR" | null;
	category: string | null;
	pricingType: string | null;
	volume: number;
}

export interface MetaCostReceiptReport {
	buckets: MetaCostReceiptBucket[];
	confirmed: number;
	unattributed: number;
	missingPricing: number;
}

interface ReceiptAggregateRow extends Omit<MetaCostReceiptBucket, "clientId" | "volume"> {
	clientId: number | null;
	volume: bigint | number | null;
	queueRows: bigint | number;
}

const queueRowLimit = 200_000;
const dayMs = 86_400_000;
const receiptOverlapMs = 2 * dayMs;

export class MetaCostReceiptLimitError extends Error {
	public readonly code = "META_COST_RECEIPT_LIMIT";

	constructor() {
		super("O mês contém mais recibos do que o relatório local pode consultar de uma vez.");
		this.name = "MetaCostReceiptLimitError";
	}
}

// The queue may be written in SQL-session time (NOW) or UTC, depending on the
// ingress path. Use its indexed timestamps only as an acquisition window. Meta's
// event epoch determines the reporting month. A delivered event takes precedence
// over a read event, which requires a send in the same period as corroboration.
// The WAMID lookup converts the receipt key to ASCII, which lets the indexed
// message column retain its own collation. The binary check keeps IDs exact.
const receiptQuery = `
	WITH configured AS (
		SELECT channel.clientId, channel.phoneId
		FROM JSON_TABLE(?, '$[*]' COLUMNS (
			clientId INT PATH '$.clientId',
			phoneId VARCHAR(32) PATH '$.phoneId'
		)) AS channel
	), phones AS (
		SELECT phoneId, MIN(clientId) AS fallbackClientId FROM configured GROUP BY phoneId
	), queue_window AS (
		SELECT id
		FROM waba_webhook_queue
		WHERE instance = ? AND created_at >= ? AND created_at < ?
		LIMIT ${queueRowLimit + 1}
	), scan_size AS (
		SELECT COUNT(*) AS queueRows FROM queue_window
	), status_events AS (
		SELECT e.phoneId, CAST(e.messageId AS BINARY) AS messageKey,
			e.status, e.eventEpoch,
			CASE
				WHEN e.recipientId REGEXP '^[+]?55[0-9]{10,11}$' THEN 'BR'
				WHEN e.recipientId REGEXP '^[+]?[1-9][0-9]{6,14}$' THEN 'OTHER'
			END AS market,
			CASE
				WHEN (e.pricingModel IS NULL OR UPPER(e.pricingModel) = 'PMP')
					AND LOWER(e.category) REGEXP '^[a-z][a-z0-9_]{0,47}$'
					AND LOWER(e.pricingType) REGEXP '^[a-z][a-z0-9_]{0,47}$'
				THEN CONCAT(LOWER(e.category), '|', LOWER(e.pricingType))
			END AS pricing
		FROM scan_size AS scan
		INNER JOIN queue_window AS item ON scan.queueRows <= ${queueRowLimit}
		INNER JOIN waba_webhook_queue AS q ON q.id = item.id AND q.instance = ?
		INNER JOIN JSON_TABLE(q.payload, '$.entry[*].changes[*].value' COLUMNS (
			phoneId VARCHAR(32) PATH '$.metadata.phone_number_id',
			NESTED PATH '$.statuses[*]' COLUMNS (
				messageId VARCHAR(255) PATH '$.id',
				status VARCHAR(16) PATH '$.status',
				eventEpoch BIGINT PATH '$.timestamp' NULL ON EMPTY NULL ON ERROR,
				recipientId VARCHAR(32) PATH '$.recipient_id',
				category VARCHAR(48) PATH '$.pricing.category',
				pricingType VARCHAR(48) PATH '$.pricing.type',
				pricingModel VARCHAR(16) PATH '$.pricing.pricing_model'
			)
		)) AS e ON TRUE
		INNER JOIN phones AS p ON p.phoneId = e.phoneId
		WHERE e.messageId <> '' AND e.eventEpoch > 0 AND e.status IN ('sent', 'delivered', 'read')
	), message_receipts AS (
		SELECT phoneId, messageKey,
			MIN(CASE WHEN status = 'sent' THEN eventEpoch END) AS sentEpoch,
			MIN(CASE WHEN status = 'delivered' THEN eventEpoch END) AS deliveredEpoch,
			MIN(CASE WHEN status = 'read' THEN eventEpoch END) AS readEpoch,
			CASE WHEN MIN(market) = 'BR' AND MAX(market) = 'BR' THEN 'BR' END AS country,
			CASE WHEN MIN(pricing) = MAX(pricing) THEN MIN(pricing) END AS pricing
		FROM status_events
		GROUP BY phoneId, messageKey
	), buckets AS (
		SELECT COALESCE(mapped.clientId, p.fallbackClientId) AS clientId,
			CASE WHEN mapped.clientId IS NOT NULL AND m.user_id > 0 THEN m.user_id END AS operatorId,
			r.country, SUBSTRING_INDEX(r.pricing, '|', 1) AS category,
			SUBSTRING_INDEX(r.pricing, '|', -1) AS pricingType, COUNT(*) AS volume
		FROM message_receipts AS r
		INNER JOIN phones AS p ON p.phoneId = r.phoneId
		LEFT JOIN messages AS m ON m.instance = ?
			AND m.waba_id = CONVERT(r.messageKey USING ascii)
			AND CAST(m.waba_id AS BINARY) = r.messageKey
		LEFT JOIN configured AS mapped ON mapped.clientId = m.client_id AND mapped.phoneId = r.phoneId
		WHERE COALESCE(r.deliveredEpoch, r.readEpoch) >= ?
			AND COALESCE(r.deliveredEpoch, r.readEpoch) < ?
			AND (r.deliveredEpoch IS NOT NULL OR (
				(r.sentEpoch IS NOT NULL OR mapped.clientId IS NOT NULL)
				AND (r.sentEpoch IS NULL OR r.sentEpoch >= ?)
				AND (mapped.clientId IS NULL OR m.sent_at >= ?)
			))
		GROUP BY COALESCE(mapped.clientId, p.fallbackClientId),
			CASE WHEN mapped.clientId IS NOT NULL AND m.user_id > 0 THEN m.user_id END,
			r.country, r.pricing
	)
	SELECT b.clientId, b.operatorId, b.country, b.category, b.pricingType, b.volume, s.queueRows
	FROM scan_size AS s LEFT JOIN buckets AS b ON TRUE
`;

function sqlUtcDate(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 23).replace("T", " ");
}

export class MetaCostReceiptRepository {
	constructor(private readonly db: Pick<DatabaseClient, "$queryRawUnsafe"> = database) {}

	public async listMonthly(
		instance: string,
		channels: readonly MetaCostReceiptChannel[],
		bounds: { start: Date; end: Date }
	): Promise<MetaCostReceiptReport> {
		const tenant = currentDatabaseTenant();
		if (tenant && tenant !== instance) throw new Error("TENANT_SQL_SCOPE_MISMATCH");
		const startMs = bounds.start.getTime();
		const endMs = bounds.end.getTime();
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > 32 * dayMs) {
			throw new RangeError("Período inválido para consultar os recibos de cobrança da Meta.");
		}
		const result: MetaCostReceiptReport = { buckets: [], confirmed: 0, unattributed: 0, missingPricing: 0 };
		if (!channels.length || startMs === endMs) return result;

		const uniqueChannels = [...new Map(channels.map(channel => [
			channel.clientId,
			{ clientId: channel.clientId, phoneId: channel.phoneId }
		])).values()];
		const startEpoch = Math.ceil(startMs / 1_000);
		const rows = await withDatabaseTenant(instance, async () => this.db.$queryRawUnsafe<ReceiptAggregateRow[]>(
			receiptQuery,
			JSON.stringify(uniqueChannels), instance, sqlUtcDate(startMs - receiptOverlapMs), sqlUtcDate(endMs + receiptOverlapMs),
			instance, instance, startEpoch, Math.ceil(endMs / 1_000), startEpoch, sqlUtcDate(startMs)
		));
		if (rows.some(row => Number(row.queueRows) > queueRowLimit)) throw new MetaCostReceiptLimitError();

		for (const row of rows) {
			if (row.clientId === null || row.volume === null) continue;
			const { clientId, operatorId, country, category, pricingType } = row;
			const volume = Number(row.volume);
			result.buckets.push({ clientId, operatorId, country, category, pricingType, volume });
			result.confirmed += volume;
			if (operatorId === null) result.unattributed += volume;
			if (category === null || pricingType === null) result.missingPricing += volume;
		}
		return result;
	}
}
