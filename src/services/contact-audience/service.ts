import axios from "axios";
import { BadRequestError, UnauthorizedError, UnauthenticatedError } from "@rgranatodutra/http-errors";
import type { Customer, SessionData } from "../../sdk-local";
import { withDatabaseTenant } from "../../utils/database-tenant-context";
import getCustomersClient from "../customers.service";
import database from "../prisma.service";
import { parseContactAudienceRequest } from "./contract";
import { ContactAudienceReader } from "./reader";
import { ContactAudienceRepository, type AudienceExecute } from "./repository";

export async function searchContactAudience(session: SessionData, authorization: string, input: unknown) {
	const request = parseContactAudienceRequest(input);
	// Both central Prisma and native tenant SQL expose this raw read contract.
	// The latter rewrites contacts/contacts_sectors to the prepared runtime tables
	// without loading a Prisma engine. Legacy CRM copies omit blocking state.
	const execute: AudienceExecute = <T>(sql: string, values: unknown[]) =>
		withDatabaseTenant(session.instance, async () => database.$queryRawUnsafe<T>(sql, ...values));
	const customerClient = getCustomersClient();
	customerClient.setAuth(authorization.replace(/^Bearer\s+/i, ""));
	const reader = new ContactAudienceReader(new ContactAudienceRepository(execute), async (customerIds, filters) => {
		try {
			const response = await customerClient.ax.post<{ data: Customer[] }>("/api/customers/search/matches", { customerIds, filters }, { timeout: 15000 });
			if (!Array.isArray(response.data?.data)) throw new Error("Invalid customer audience response");
			return response.data.data;
		} catch (error) {
			const cause = error instanceof Error && error.cause ? error.cause : error;
			if (axios.isAxiosError(cause)) {
				if (cause.response?.status === 400) throw new BadRequestError(typeof cause.response.data?.message === "string" ? cause.response.data.message : "Filtros de cliente inválidos.");
				if (cause.response?.status === 401) throw new UnauthenticatedError("Sessão expirada ao consultar clientes.");
				if (cause.response?.status === 403) throw new UnauthorizedError("Sem acesso à consulta de clientes.");
			}
			throw error;
		}
	});
	return reader.search(session.instance, request);
}
