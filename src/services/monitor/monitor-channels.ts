import type { SessionData } from "../../sdk-local";
import { BadRequestError } from "@rgranatodutra/http-errors";

/** Safe catalog only: never serialize the provider credentials on WppClient. */
export function monitorChannelQuery(session: SessionData, input: { page?: unknown; search?: unknown }) {
	if (input.page !== undefined && typeof input.page !== "string" && typeof input.page !== "number")
		throw new BadRequestError("Página de canais inválida.");
	const page = input.page === undefined ? 1 : Number(input.page);
	if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
		throw new BadRequestError("Página de canais inválida.");
	const search = input.search ?? "";
	if (typeof search !== "string" || search.length > 100)
		throw new BadRequestError("Pesquisa de canais deve ter até 100 caracteres.");
	const where = {
		instance: session.instance,
		...(session.instance === "nunes" && session.sectorId !== 3
			? { sectors: { some: { instance: session.instance, id: session.sectorId } } }
			: {}),
		...(search.trim() ? { OR: [{ name: { contains: search.trim() } }, { phone: { contains: search.trim() } }] } : {})
	};
	return {
		where,
		select: { id: true, name: true, phone: true, isActive: true } as const,
		orderBy: [{ name: "asc" }, { id: "asc" }] as [{ name: "asc" }, { id: "asc" }],
		skip: (page - 1) * 20,
		take: 20,
		page
	};
}
