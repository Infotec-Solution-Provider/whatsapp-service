import assert from "node:assert/strict";
import axios from "axios";
import { currentDatabaseTenant } from "../../utils/database-tenant-context";
import type { SessionData } from "../../sdk-local";

async function main() {
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown) => {
		const id = require.resolve(path); previous.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
	};
	const queries: string[] = [];
	const requests: Array<{ url: string; data: { customerIds: number[]; filters: Record<string, string> } }> = [];
	let parameterReads = 0;
	let status: number | undefined;
	const session: SessionData = { instance: "a", userId: 3, sectorId: 2, role: "USER", name: "User" };
	try {
		stub("../parameters.service", { getSessionParams: async () => { parameterReads++; return { use_local_contacts_sync: "true" }; } });
		stub("../prisma.service", { $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
			queries.push(sql);
			assert.equal(currentDatabaseTenant(), "a");
			assert.ok(values.includes("a"));
			assert.ok(!sql.includes("wpp_contacts"), "legacy CRM copies omit blocking state and must not drive eligibility");
			if (sql.includes("MAX(id)")) return [{ upper_id: 1 }];
			if (sql.startsWith("SELECT sector.")) return [];
			return [{ id: 1, instance: "a", name: "Contact", phone: "55", customer_id: 0, is_blocked: 1, is_deleted: 0 }];
		} });
		stub("../customers.service", () => ({
			setAuth(token: string) { assert.equal(token, "test"); },
			ax: { post: async (url: string, data: { customerIds: number[]; filters: Record<string, string> }, options: { timeout: number }) => {
				requests.push({ url, data });
				assert.equal(options.timeout, 15000);
				assert.ok(data.customerIds.length <= 100);
				assert.ok(!("instance" in data) && !("instance" in data.filters));
				if (status) {
					const original = new axios.AxiosError("upstream failure");
					original.response = { status, statusText: "failure", data: { message: "Filtro inválido no serviço de clientes." }, headers: {}, config: {} as any };
					throw new Error("SDK wrapper", { cause: original });
				}
				return { data: { data: data.customerIds.map(CODIGO => ({ CODIGO })) } };
			} }
		}));
		const { searchContactAudience } = require("./service") as typeof import("./service");
		const body = { contactFilters: {}, customerFilters: { campaignIds: "0,-1" }, pagination: { page: 1, perPage: 20 } };
		const response = await searchContactAudience(session, "Bearer test", body);
		assert.deepEqual(response.summary, { total: 1, eligible: 0, blocked: 1, skipped: 0 });
		assert.equal(response.data[0]!.customer!.CODIGO, 0);
		assert.equal(parameterReads, 0, "local synchronization cannot change the authoritative source");
		assert.ok(requests.every(request => request.url === "/api/customers/search/matches"));
		assert.deepEqual(requests[0]!.data, { customerIds: [], filters: { campaignIds: "0,-1" } });
		assert.deepEqual(requests[1]!.data.customerIds, [0]);
		const firstQueries = queries.length;
		status = 400;
		await assert.rejects(searchContactAudience(session, "test", body), /Filtro inválido no serviço de clientes/);
		assert.equal(queries.length, firstQueries, "upstream invalid filters must fail before any candidate SQL");
		status = 401;
		await assert.rejects(searchContactAudience(session, "test", body), /Sessão expirada/);
		status = 503;
		await assert.rejects(searchContactAudience(session, "test", body), /SDK wrapper/);
		assert.equal(queries.length, firstQueries);
		console.log("contact-audience runtime storage, scoped matching and upstream errors: passed");
	} finally {
		for (const [id, cached] of previous) { if (cached) require.cache[id] = cached; else delete require.cache[id]; }
	}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
