import prismaService from "./prisma.service";
import instancesService from "./instances.service";
import { FETCH_CUSTOMERS_QUERY } from "./chats.service";
import { Prisma } from "@prisma/client";

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

interface UserMessages {
	userId: number;
	userName: string;
	userActive: string | number | null;
	userType: string | number | null;
	userSector: string | null | undefined;
	attendancesCount: number;
	messagesCount: number;
	sentMessagesCount: number;
	receivedMessagesCount: number;
	contactsCount: number;
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

const FROM_US_SQL_CONDITION = (alias: string) =>
	`(${alias}.user_id IS NOT NULL OR ${alias}.\`from\` LIKE 'me:%' OR ${alias}.\`from\` LIKE 'user:%' OR ${alias}.\`from\` LIKE 'system:%' OR ${alias}.\`from\` LIKE 'bot%' OR ${alias}.\`from\` LIKE 'thirdparty:%')`;

const isFromUs = (fromValue: string | null | undefined, userId?: number | null) => {
	if (userId) return true;
	const from = String(fromValue || "").toLowerCase();
	return (
		from.startsWith("me:") ||
		from.startsWith("user:") ||
		from.startsWith("system:") ||
		from.startsWith("bot") ||
		from.startsWith("thirdparty:")
	);
};

const parseDate = (value?: string | null): Date | null => {
	if (!value) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	const asNumber = Number(trimmed);
	if (!Number.isNaN(asNumber) && /^\d+$/.test(trimmed)) {
		const dateFromNumber = new Date(asNumber);
		return Number.isNaN(dateFromNumber.getTime()) ? null : dateFromNumber;
	}
	const parsed = new Date(trimmed);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
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
			minDate: parseDate(minRaw),
			maxDate: parseDate(maxRaw)
		};
	}

	public async contactsWaitingResponseService(instance: string) {
		const query = `
			SELECT
				ch.id AS CODIGO_ATENDIMENTO,
				ct.name AS CONTATO,
				ct.customer_id AS customerId,
				ch.user_id AS userId,
				ch.sector_id AS sectorId,
				(
					SELECT msg1.sent_at
					FROM messages msg1
					WHERE msg1.chat_id = ch.id
						AND NOT ${FROM_US_SQL_CONDITION("msg1")}
					ORDER BY msg1.sent_at ASC
					LIMIT 1
				) AS DATA_MENSAGEM_CLIENTE
			FROM chats ch
			JOIN contacts ct ON ch.contact_id = ct.id
			WHERE ch.instance = ?
				AND ch.is_finished = 0
				AND EXISTS (
					SELECT 1
					FROM messages msg2
					WHERE msg2.chat_id = ch.id
						AND NOT ${FROM_US_SQL_CONDITION("msg2")}
					LIMIT 1
				)
				AND NOT EXISTS (
					SELECT 1
					FROM messages msg3
					WHERE msg3.chat_id = ch.id
						AND ${FROM_US_SQL_CONDITION("msg3")}
						AND msg3.sent_at > (
							SELECT msg4.sent_at
							FROM messages msg4
							WHERE msg4.chat_id = ch.id
								AND NOT ${FROM_US_SQL_CONDITION("msg4")}
							ORDER BY msg4.sent_at ASC
							LIMIT 1
						)
				)
			ORDER BY DATA_MENSAGEM_CLIENTE ASC;
		`;

		const rows = await prismaService.$queryRawUnsafe<AwaitingResponseRow[]>(query, instance);

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
			prismaService.wppSector.findMany({ where: { id: { in: sectorIds } } })
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

		const messages = await prismaService.wppMessage.findMany({
			where: {
				instance,
				...(minDate || maxDate
					? {
						sentAt: {
							...(minDate ? { gte: minDate } : {}),
							...(maxDate ? { lte: maxDate } : {})
						}
					}
					: {})
			},
			select: {
				id: true,
				userId: true,
				contactId: true,
				chatId: true,
				from: true,
				WppChat: { select: { userId: true } }
			}
		});

		const operatorIds = Array.from(
			new Set(
				messages
					.map((message) => message.userId ?? message.WppChat?.userId)
					.filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 1)
			)
		);

		const operatorsMap = await this.fetchOperators(instance, operatorIds);

		const messagesPerUser = new Map<number, UserMessages>();
		const contactsPerUser = new Map<number, Set<number>>();
		const attendancesPerUser = new Map<number, Set<number>>();

		for (const message of messages) {
			const operatorId = message.userId ?? message.WppChat?.userId;
			if (!operatorId || operatorId <= 1) continue;

			const operator = operatorsMap.get(operatorId);
			if (!operator) continue;

			let userMessage = messagesPerUser.get(operatorId);
			if (!userMessage) {
				userMessage = {
					userId: operator.CODIGO,
					userName: operator.NOME,
					userActive: operator.ATIVO,
					userType: operator.NIVEL,
					userSector: operator.SETOR_NOME || null,
					attendancesCount: 0,
					messagesCount: 0,
					sentMessagesCount: 0,
					receivedMessagesCount: 0,
					contactsCount: 0
				};
				messagesPerUser.set(operatorId, userMessage);
			}

			userMessage.messagesCount++;
			if (isFromUs(message.from, message.userId)) {
				userMessage.sentMessagesCount++;
			} else {
				userMessage.receivedMessagesCount++;
			}

			if (message.contactId) {
				const userContacts = contactsPerUser.get(operatorId) || new Set<number>();
				userContacts.add(message.contactId);
				contactsPerUser.set(operatorId, userContacts);
			}

			if (message.chatId) {
				const userAttendances = attendancesPerUser.get(operatorId) || new Set<number>();
				userAttendances.add(message.chatId);
				attendancesPerUser.set(operatorId, userAttendances);
			}
		}

		messagesPerUser.forEach((userMessage, userId) => {
			userMessage.contactsCount = contactsPerUser.get(userId)?.size || 0;
			userMessage.attendancesCount = attendancesPerUser.get(userId)?.size || 0;
		});

		return { messagesPerUser: Array.from(messagesPerUser.values()) };
	}

	public async messagesPerContactService(
		instance: string,
		dateFilter?: string | null,
		userId: number | null = null
	) {
		const { minDate, maxDate } = this.parseDateRange(dateFilter);

		const joinConditions: string[] = ["ch.instance = c.instance"];
		const joinValues: any[] = [];

		if (minDate) {
			joinConditions.push("ch.started_at >= ?");
			joinValues.push(minDate);
		}

		if (maxDate) {
			joinConditions.push("ch.finished_at <= ?");
			joinValues.push(maxDate);
		}

		if (userId) {
			joinConditions.push("ch.user_id = ?");
			joinValues.push(userId);
		}

		const whereConditions: string[] = ["c.instance = ?"];
		const whereValues: any[] = [instance];

		if (minDate) {
			whereConditions.push("msg.sent_at >= ?");
			whereValues.push(minDate);
		}

		if (maxDate) {
			whereConditions.push("msg.sent_at <= ?");
			whereValues.push(maxDate);
		}

		if (userId) {
			whereConditions.push("COALESCE(msg.user_id, ch.user_id) = ?");
			whereValues.push(userId);
		}

		const query = `
			SELECT
				c.id AS contactId,
				c.name AS contactName,
				c.customer_id AS customerId,
				SUM(CASE WHEN msg.id IS NOT NULL THEN 1 ELSE 0 END) AS messagesCount,
				SUM(CASE WHEN msg.id IS NOT NULL AND ${FROM_US_SQL_CONDITION("msg")} THEN 1 ELSE 0 END) AS sentMessagesCount,
				SUM(CASE WHEN msg.id IS NOT NULL AND NOT ${FROM_US_SQL_CONDITION("msg")} THEN 1 ELSE 0 END) AS receivedMessagesCount,
				COUNT(DISTINCT ch.id) AS attendancesCount
			FROM contacts c
			LEFT JOIN messages msg ON msg.contact_id = c.id AND msg.instance = c.instance
			LEFT JOIN chats ch ON ch.contact_id = c.id AND ${joinConditions.join(" AND ")}
			WHERE ${whereConditions.join(" AND ")}
			GROUP BY contactId, contactName, customerId
			ORDER BY contactName;
		`;

		const rows = await prismaService.$queryRawUnsafe<MessagesPerContactRow[]>(
			query,
			...joinValues,
			...whereValues
		);

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
		const minDate = parseDate(MIN_DATE);
		const maxDate = parseDate(MAX_DATE);

		const operatorIds = OPERADORES === "*" ? null : OPERADORES.split(",").map((id) => +id).filter(Boolean);
		const sectorIds = SETORES === "*" ? null : SETORES.split(",").map((id) => +id).filter(Boolean);

		const where: Prisma.WppMessageWhereInput = { instance };

		if (minDate || maxDate) {
			where.sentAt = {
				...(minDate ? { gt: minDate } : {}),
				...(maxDate ? { lt: maxDate } : {})
			};
		}

		if (operatorIds && operatorIds.length) {
			where.OR = [
				{ userId: { in: operatorIds } },
				{ WppChat: { userId: { in: operatorIds } } }
			];
		}

		const messages = await prismaService.wppMessage.findMany({
			where,
			select: {
				id: true,
				from: true,
				userId: true,
				sentAt: true,
				WppChat: { select: { userId: true } }
			}
		});

		const messageOperatorIds = Array.from(
			new Set(
				messages
					.map((message) => message.userId ?? message.WppChat?.userId)
					.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
			)
		);

		const operatorsMap = await this.fetchOperators(instance, messageOperatorIds);

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

		for (const message of messages) {
			const operatorId = message.userId ?? message.WppChat?.userId;
			if (!operatorId) continue;

			const operator = operatorsMap.get(operatorId);
			if (!operator) continue;

			if (sectorIds && operator.SETOR && !sectorIds.includes(operator.SETOR)) {
				continue;
			}

			const messageDate = message.sentAt;
			if (!messageDate) continue;

			const hour = messageDate.getHours();
			const weekDay = messageDate.getDay() + 1;
			const sectorName = operator.SETOR_NOME || null;
			const key = `${sectorName || ""}|${hour}|${weekDay}`;

			const row = aggregated.get(key) || {
				sector: sectorName,
				hour,
				weekDay,
				messagesCount: 0,
				sentMessagesCount: 0,
				receivedMessagesCount: 0
			};

			row.messagesCount++;
			if (isFromUs(message.from, message.userId)) {
				row.sentMessagesCount++;
			} else {
				row.receivedMessagesCount++;
			}

			aggregated.set(key, row);
		}

		const messagesPerHourDay = Array.from(aggregated.values()).sort((a, b) => {
			if (a.weekDay !== b.weekDay) return a.weekDay - b.weekDay;
			if (a.hour !== b.hour) return a.hour - b.hour;
			return String(a.sector || "").localeCompare(String(b.sector || ""));
		});

		return { messagesPerHourDay };
	}
}

export default new DashboardService();
