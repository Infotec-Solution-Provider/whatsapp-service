import prismaService from "./prisma.service";
import instancesService from "./instances.service";
import { FETCH_CUSTOMERS_QUERY } from "./chats.service";
import operatorPerformanceService, { parseBoundaryDate } from "./operator-performance.service";
import { getReportMessageType } from "../utils/report-rules";
import { Prisma } from "@prisma/client";
import {
	buildMessagesPerContactQuery,
	CONTACTS_WAITING_RESPONSE_SQL
} from "../utils/dashboard-report-sql";

interface OperatorRow {
	CODIGO: number;
	NOME: string;
	ATIVO: string | number | null;
	NIVEL: string | number | null;
	SETOR: number | null;
	SETOR_NOME?: string | null;
}

interface CustomerRow {
	CODIGO: number;
	RAZAO: string;
	CPF_CNPJ?: string | null;
	SETOR?: number | null;
}

interface AwaitingResponseRow {
	CODIGO_ATENDIMENTO: number;
	CONTATO: string;
	customerId: number | null;
	userId: number | null;
	sectorId: number | null;
	DATA_MENSAGEM_CLIENTE: Date | null;
}

interface MessagesPerContactRow {
	contactId: number;
	contactName: string;
	customerId: number | null;
	messagesCount: number;
	sentMessagesCount: number;
	receivedMessagesCount: number;
	attendancesCount: number;
}

// "YYYY-MM-DD" vira início/fim do dia local, igual ao card de desempenho (não meia-noite UTC).
const parseDate = (value: string | null | undefined, boundary: "start" | "end"): Date | null => {
	if (!value) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) {
		const dateFromNumber = new Date(Number(trimmed));
		return Number.isNaN(dateFromNumber.getTime()) ? null : dateFromNumber;
	}
	return parseBoundaryDate(trimmed, boundary);
};

class DashboardService {
	private async fetchOperators(instance: string, operatorIds: number[]) {
		if (!operatorIds.length) return new Map<number, OperatorRow>();

		const query =
			"SELECT o.*, s.NOME as SETOR_NOME FROM operadores o LEFT JOIN w_setores s ON s.CODIGO = o.SETOR WHERE o.CODIGO IN (?)";
		const rows = await instancesService.executeQuery<OperatorRow[]>(instance, query, [operatorIds]);

		return new Map(rows.map((row) => [row.CODIGO, row]));
	}

	private async fetchCustomers(instance: string, customerIds: number[]) {
		if (!customerIds.length) return new Map<number, CustomerRow>();
		const rows = await instancesService.executeQuery<CustomerRow[]>(
			instance,
			FETCH_CUSTOMERS_QUERY,
			[customerIds]
		);

		return new Map(rows.map((row) => [row.CODIGO, row]));
	}

	private async fetchLegacySectors(instance: string, sectorIds: number[]) {
		if (!sectorIds.length) return new Map<number, string>();
		const query = "SELECT CODIGO, NOME FROM w_setores WHERE CODIGO IN (?)";
		const rows = await instancesService.executeQuery<Array<{ CODIGO: number; NOME: string }>>(
			instance,
			query,
			[sectorIds]
		);

		return new Map(rows.map((row) => [row.CODIGO, row.NOME]));
	}

	private parseDateRange(dateFilter?: string | null) {
		const [minRaw, maxRaw] = (dateFilter || "").split("_");
		return {
			minDate: parseDate(minRaw, "start"),
			maxDate: parseDate(maxRaw, "end")
		};
	}

	public async contactsWaitingResponseService(instance: string) {
		const rows = await prismaService.$queryRawUnsafe<AwaitingResponseRow[]>(
			CONTACTS_WAITING_RESPONSE_SQL,
			instance
		);

		const customerIds = Array.from(
			new Set(rows.map((row) => row.customerId).filter((id): id is number => Number.isFinite(id)))
		);
		const operatorIds = Array.from(
			new Set(rows.map((row) => row.userId).filter((id): id is number => Number.isFinite(id)))
		);
		const sectorIds = Array.from(
			new Set(rows.map((row) => row.sectorId).filter((id): id is number => Number.isFinite(id)))
		);

		const [customersMap, operatorsMap, sectors] = await Promise.all([
			this.fetchCustomers(instance, customerIds),
			this.fetchOperators(instance, operatorIds),
			prismaService.wppSector.findMany({ where: { instance, id: { in: sectorIds } } })
		]);

		const sectorsMap = new Map(sectors.map((sector) => [sector.id, sector.name]));

		return rows.map((row) => {
			const customer = row.customerId ? customersMap.get(row.customerId) : null;
			const operator = row.userId ? operatorsMap.get(row.userId) : null;
			const sectorName = row.sectorId ? sectorsMap.get(row.sectorId) : null;

			return {
				CODIGO_ATENDIMENTO: row.CODIGO_ATENDIMENTO,
				CONTATO: row.CONTATO,
				CLIENTE: customer?.RAZAO || null,
				OPERADOR: operator?.NOME || null,
				SETOR: sectorName || operator?.SETOR_NOME || null,
				DATA_MENSAGEM_CLIENTE: row.DATA_MENSAGEM_CLIENTE
			};
		});
	}

	public async messagesPerUserService(instance: string, dateFilter?: string | null) {
		const { minDate, maxDate } = this.parseDateRange(dateFilter);
		const messagesPerUser = await operatorPerformanceService.getMessagesPerOperator(instance, minDate, maxDate);

		return { messagesPerUser };
	}

	public async messagesPerContactService(
		instance: string,
		dateFilter?: string | null,
		userId: number | null = null
	) {
		const { minDate, maxDate } = this.parseDateRange(dateFilter);

		const { query, values } = buildMessagesPerContactQuery(instance, minDate, maxDate, userId);
		const rows = await prismaService.$queryRawUnsafe<MessagesPerContactRow[]>(query, ...values);

		const customerIds = Array.from(
			new Set(rows.map((row) => row.customerId).filter((id): id is number => Number.isFinite(id)))
		);

		const customersMap = await this.fetchCustomers(instance, customerIds);

		const isNatrielli = instance === "natrielli";
		let sectorMap = new Map<number, string>();
		if (isNatrielli) {
			const sectorIds = Array.from(
				new Set(
					Array.from(customersMap.values())
						.map((customer) => customer.SETOR)
						.filter((id): id is number => Number.isFinite(id))
				)
			);
			sectorMap = await this.fetchLegacySectors(instance, sectorIds);
		}

		const messagesPerContact = rows.map((row) => {
			const customer = row.customerId ? customersMap.get(row.customerId) : null;
			const base = {
				...row,
				messagesCount: typeof row.messagesCount === "bigint" ? Number(row.messagesCount) : row.messagesCount,
				sentMessagesCount:
					typeof row.sentMessagesCount === "bigint"
						? Number(row.sentMessagesCount)
						: row.sentMessagesCount,
				receivedMessagesCount:
					typeof row.receivedMessagesCount === "bigint"
						? Number(row.receivedMessagesCount)
						: row.receivedMessagesCount,
				attendancesCount:
					typeof row.attendancesCount === "bigint"
						? Number(row.attendancesCount)
						: row.attendancesCount,
				customerName: customer?.RAZAO || null,
				customerCnpj: customer?.CPF_CNPJ || null
			};

			if (isNatrielli && customer?.SETOR) {
				return {
					...base,
					customerSector: sectorMap.get(customer.SETOR) || null
				};
			}

			return base;
		});

		return { messagesPerContact };
	}

	public async messagesPerHourDayService(
		instance: string,
		SETORES: string,
		OPERADORES: string,
		MIN_DATE: string | null,
		MAX_DATE: string | null
	) {
		const minDate = parseDate(MIN_DATE, "start");
		const maxDate = parseDate(MAX_DATE, "end");

		const operatorIds = OPERADORES === "*" ? null : OPERADORES.split(",").map((id) => +id).filter(Boolean);
		const sectorIds = SETORES === "*" ? null : SETORES.split(",").map((id) => +id).filter(Boolean);

		const where: Prisma.WppMessageWhereInput = { instance };

		if (minDate || maxDate) {
			where.sentAt = {
				...(minDate ? { gte: minDate } : {}),
				...(maxDate ? { lte: maxDate } : {})
			};
		}

		if (operatorIds) {
			where.OR = [
				{ userId: { in: operatorIds } },
				{ userId: null, WppChat: { instance, userId: { in: operatorIds } } }
			];
		}

		const selectedOperators = operatorIds && new Set(operatorIds);
		const selectedSectors = sectorIds && new Set(sectorIds);
		const operatorsMap = new Map<number, OperatorRow>();
		const lookedUpOperatorIds = new Set<number>();
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const batchSize = 2000;
		let cursor: number | undefined;

		const aggregated = new Map<
			string,
			{
				sector: string | null;
				hour: number;
				weekDay: number;
				messagesCount: number;
				sentMessagesCount: number;
				receivedMessagesCount: number;
			}
		>();

		while (true) {
			const messages = await prismaService.wppMessage.findMany({
				where,
				orderBy: [{ sentAt: "asc" }, { id: "asc" }],
				take: batchSize,
				...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
				select: {
					id: true,
					from: true,
					to: true,
					userId: true,
					sentAt: true,
					contactId: true,
					WppChat: { select: { instance: true, contactId: true, userId: true } }
				}
			});

			const eligible = messages.flatMap((message) => {
				const type = getReportMessageType(message);
				if (type !== "SENT" && type !== "RECEIVED") return [];
				const chat = message.WppChat;
				const assignedUserId =
					chat?.instance === instance && chat.contactId === message.contactId ? chat.userId : null;
				const operatorId = message.userId ?? assignedUserId;
				if (!operatorId || (selectedOperators && !selectedOperators.has(operatorId))) return [];
				return [{ type, operatorId, sentAt: message.sentAt }];
			});

			const newOperatorIds = [...new Set(eligible.map((message) => message.operatorId))]
				.filter((id) => !lookedUpOperatorIds.has(id));
			for (const id of newOperatorIds) lookedUpOperatorIds.add(id);
			for (const [id, operator] of await this.fetchOperators(instance, newOperatorIds)) {
				operatorsMap.set(id, operator);
			}

			for (const message of eligible) {
				const operator = operatorsMap.get(message.operatorId);
				if (!operator || (selectedSectors && (operator.SETOR == null || !selectedSectors.has(operator.SETOR)))) {
					continue;
				}

				const hour = message.sentAt.getHours();
				const weekDay = message.sentAt.getDay() + 1;
				const sector = operator.SETOR_NOME || null;
				const key = JSON.stringify([sector, hour, weekDay]);
				const row = aggregated.get(key) ?? {
					sector,
					hour,
					weekDay,
					messagesCount: 0,
					sentMessagesCount: 0,
					receivedMessagesCount: 0
				};

				row.messagesCount++;
				if (message.type === "SENT") row.sentMessagesCount++;
				else row.receivedMessagesCount++;
				aggregated.set(key, row);
			}

			const lastMessage = messages.at(-1);
			if (!lastMessage || messages.length < batchSize) break;
			cursor = lastMessage.id;
		}

		const messagesPerHourDay = Array.from(aggregated.values()).sort((a, b) => {
			if (a.weekDay !== b.weekDay) return a.weekDay - b.weekDay;
			if (a.hour !== b.hour) return a.hour - b.hour;
			return String(a.sector || "").localeCompare(String(b.sector || ""));
		});

		return { messagesPerHourDay, timeZone };
	}
}

export default new DashboardService();
