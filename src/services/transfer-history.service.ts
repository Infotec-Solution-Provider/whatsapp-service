import { Logger } from "@in.pulse-crm/utils";
import prismaService from "./prisma.service";

type TransferSource =
	| "manual"
	| "auto-sector"
	| "auto-operator"
	| "bot-return-previous-operator";

interface ChatTransferSnapshot {
	id: number;
	instance: string;
	userId: number | null;
	sectorId: number | null;
}

interface RecordTransferInput {
	previousChat: ChatTransferSnapshot;
	nextChat: ChatTransferSnapshot;
	source: TransferSource;
	initiatedByUserId?: number | null;
	reason?: string | null;
}

export interface OperatorTransferAggregateRow {
	operatorId: number | null;
	transfersSentCount: bigint | number;
	transfersReceivedCount: bigint | number;
}

const buildInClause = (field: string, ids: number[] | null) => {
	if (!ids?.length) return "";
	return ` AND ${field} IN (${ids.join(",")})`;
};

class TransferHistoryService {
	public async recordTransfer({ previousChat, nextChat, source, initiatedByUserId, reason }: RecordTransferInput) {
		const fromUserId = previousChat.userId ?? null;
		const toUserId = nextChat.userId ?? null;
		const fromSectorId = previousChat.sectorId ?? null;
		const toSectorId = nextChat.sectorId ?? null;

		if (fromUserId === toUserId && fromSectorId === toSectorId) {
			return;
		}

		try {
			await prismaService.$executeRawUnsafe(
				[
					"INSERT INTO chat_transfer_history (",
					"instance, chat_id, from_user_id, to_user_id, from_sector_id, to_sector_id, initiated_by_user_id, source, reason, transferred_at",
					") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
				].join(" "),
				previousChat.instance,
				previousChat.id,
				fromUserId,
				toUserId,
				fromSectorId,
				toSectorId,
				initiatedByUserId ?? null,
				source,
				reason ?? null,
				new Date()
			);
		} catch (error) {
			Logger.error("Falha ao registrar histórico de transferência", {
				error,
				chatId: previousChat.id,
				instance: previousChat.instance,
				source
			});
		}
	}

	public async getOperatorTransferMetrics(
		instance: string,
		startDate: Date | null,
		endDate: Date | null,
		operatorIds: number[] | null,
		sectorIds: number[] | null
	) {
		const dateClauseParts: string[] = [];
		const dateParams: Array<string | Date> = [instance];

		if (startDate) {
			dateClauseParts.push("history.transferred_at >= ?");
			dateParams.push(startDate);
		}

		if (endDate) {
			dateClauseParts.push("history.transferred_at <= ?");
			dateParams.push(endDate);
		}

		const dateClause = dateClauseParts.length ? ` AND ${dateClauseParts.join(" AND ")}` : "";
		const sectorClause = sectorIds?.length
			? ` AND (history.from_sector_id IN (${sectorIds.join(",")}) OR history.to_sector_id IN (${sectorIds.join(",")}))`
			: "";

		const sentOperatorClause = buildInClause("history.from_user_id", operatorIds);
		const receivedOperatorClause = buildInClause("history.to_user_id", operatorIds);

		const query = `
			SELECT
				aggregated.operatorId,
				SUM(aggregated.transfersSentCount) AS transfersSentCount,
				SUM(aggregated.transfersReceivedCount) AS transfersReceivedCount
			FROM (
				SELECT
					history.from_user_id AS operatorId,
					COUNT(*) AS transfersSentCount,
					0 AS transfersReceivedCount
				FROM chat_transfer_history history
				WHERE history.instance = ?
					AND history.from_user_id IS NOT NULL
					AND history.from_user_id > 0
					${dateClause}
					${sectorClause}
					${sentOperatorClause}
				GROUP BY history.from_user_id

				UNION ALL

				SELECT
					history.to_user_id AS operatorId,
					0 AS transfersSentCount,
					COUNT(*) AS transfersReceivedCount
				FROM chat_transfer_history history
				WHERE history.instance = ?
					AND history.to_user_id IS NOT NULL
					AND history.to_user_id > 0
					${dateClause}
					${sectorClause}
					${receivedOperatorClause}
				GROUP BY history.to_user_id
			) aggregated
			GROUP BY aggregated.operatorId
		`;

		return prismaService.$queryRawUnsafe<OperatorTransferAggregateRow[]>(
			query,
			...dateParams,
			...dateParams
		);
	}
}

export default new TransferHistoryService();