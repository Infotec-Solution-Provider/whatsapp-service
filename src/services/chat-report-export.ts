import { Prisma } from "@prisma/client";
import { BadRequestError, UnauthorizedError } from "@rgranatodutra/http-errors";
import { SessionData } from "../sdk-local";

const messageLimit = 20_000;

function optionalId(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const id = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestError("Identificador inválido");
	return id;
}

function optionalTimestamp(value: unknown): Date | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new BadRequestError("Limite de data inválido");
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
		throw new BadRequestError("Limite de data inválido");
	}
	return date;
}

export function buildChatReportQuery(session: SessionData, filters: Record<string, unknown>) {
	const { instance, role, sectorId } = session;
	if ((role !== "ADMIN" && role !== "SUPERVISOR") || !sectorId || optionalId(filters["sectorId"]) !== sectorId) {
		throw new UnauthorizedError("Exportação indisponível neste setor");
	}

	const userId = optionalId(filters["userId"]);
	const chatId = optionalId(filters["chatId"]);
	const contactId = optionalId(filters["contactId"]);
	const start = optionalTimestamp(filters["start"]);
	const end = optionalTimestamp(filters["end"]);
	if ([userId, chatId, contactId].filter((id) => id !== undefined).length > 1) {
		throw new BadRequestError("Selecione um único tipo de origem para a exportação");
	}
	if ((!chatId && !contactId && !start) || Boolean(start) !== Boolean(end) || (start && end && start > end)) {
		throw new BadRequestError("Período de exportação inválido");
	}

	return {
		where: {
			instance,
			WppChat: { is: { instance, sectorId, ...(chatId ? { id: chatId } : {}), ...(contactId ? { contactId } : {}), ...(userId ? { userId } : {}) } },
			WppContact: { is: { instance, ...(contactId ? { id: contactId } : {}), ...(role === "ADMIN" ? {} : { isOnlyAdmin: false }) } },
			...(start && end ? { sentAt: { gte: start, lte: end } } : {}),
		},
		select: {
			body: true,
			from: true,
			sentAt: true,
			fileName: true,
			fileType: true,
			WppContact: { select: { id: true, name: true, phone: true } },
		},
		orderBy: [{ sentAt: "asc" }, { id: "asc" }],
		take: messageLimit + 1,
	} satisfies Prisma.WppMessageFindManyArgs;
}

export function assertChatReportSize(count: number) {
	if (count > messageLimit) {
		throw new BadRequestError("A exportação ultrapassou 20 mil mensagens. Selecione um período menor.");
	}
}
