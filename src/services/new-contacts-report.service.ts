import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import type { FirstReplyStatus, NewContactsQuery, NewContactsStatus } from "./new-contacts-report.contract";
import { buildNewContactsQueries } from "./new-contacts-report.query";

type DatabaseNumber = number | bigint | string;

interface ReportRow {
	contactId: DatabaseNumber;
	contactName: string | null;
	customerId: DatabaseNumber | null;
	firstInboundAt: Date;
	firstChannelId: DatabaseNumber | null;
	firstChannelName: string | null;
	firstResponderId: DatabaseNumber | null;
	firstReplyAt: Date | null;
	firstReplyStatus: FirstReplyStatus;
	firstReplySeconds: DatabaseNumber | null;
	latestChatId: DatabaseNumber | null;
	ownerId: DatabaseNumber | null;
	sectorId: DatabaseNumber | null;
	sectorName: string | null;
	status: NewContactsStatus;
}

interface OwnerCount {
	ownerId: DatabaseNumber | null;
	count: DatabaseNumber;
}

const nullableNumber = (value: DatabaseNumber | null) => value === null ? null : Number(value);

async function operatorNames(instance: string, operatorIds: Iterable<number>) {
	const ids = [...new Set(operatorIds)];
	const names = new Map<number, string>();
	for (let offset = 0; offset < ids.length; offset += 250) {
		const batch = ids.slice(offset, offset + 250);
		const rows = await instancesService.executeQuery<Array<{ CODIGO: number; NOME: string }>>(
			instance,
			`SELECT CODIGO, NOME FROM operadores WHERE CODIGO IN (${batch.map(() => "?").join(", ")})`,
			batch
		);
		for (const row of rows) names.set(Number(row.CODIGO), row.NOME);
	}
	return names;
}

export async function queryNewContactsReport(instance: string, query: NewContactsQuery) {
	const queriedAt = new Date();
	const { summary, rows } = buildNewContactsQueries(instance, query, queriedAt);
	const [counts, rawRows] = await prismaService.$transaction(
		[
			prismaService.$queryRawUnsafe<OwnerCount[]>(summary.sql, ...summary.params),
			prismaService.$queryRawUnsafe<ReportRow[]>(rows.sql, ...rows.params)
		],
		{ isolationLevel: "RepeatableRead" }
	);
	const reportRows = rawRows.map(row => ({
		...row,
		contactId: Number(row.contactId),
		customerId: nullableNumber(row.customerId),
		firstInboundAt: row.firstInboundAt.toISOString(),
		firstChannelId: nullableNumber(row.firstChannelId),
		firstResponderId: nullableNumber(row.firstResponderId),
		firstReplyAt: row.firstReplyAt === null ? null : row.firstReplyAt.toISOString(),
		firstReplySeconds: nullableNumber(row.firstReplySeconds),
		latestChatId: nullableNumber(row.latestChatId),
		ownerId: nullableNumber(row.ownerId),
		sectorId: nullableNumber(row.sectorId)
	}));
	const ids = [
		...counts.map(row => nullableNumber(row.ownerId)),
		...reportRows.map(row => row.firstResponderId)
	].filter((id): id is number => id !== null);
	const names = await operatorNames(instance, ids);
	const nameFor = (id: number | null) => id === null ? null : names.get(id) ?? null;
	const byOwner = counts.map(row => ({
		ownerId: nullableNumber(row.ownerId),
		ownerName: nameFor(nullableNumber(row.ownerId)),
		count: Number(row.count)
	}));

	return {
		rows: reportRows.map(row => ({
			...row,
			ownerName: nameFor(row.ownerId),
			firstResponderName: nameFor(row.firstResponderId)
		})),
		total: byOwner.reduce((total, row) => total + row.count, 0),
		byOwner,
		queriedAt: queriedAt.toISOString(),
		page: query.page,
		pageSize: query.pageSize
	};
}
