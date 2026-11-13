import assert from "node:assert/strict";
import type { SessionData } from "../../sdk-local";
import { useOptimizedCentralMonitor } from "./optimized-access";
import { parseMonitorRequest } from "./monitor-contract";

async function main() {
	const session: SessionData = { instance: "odim", role: "ADMIN", userId: 9, sectorId: 138, name: "Fixture" };
	const base = { session, filters: parseMonitorRequest({}).filters, local: false, slaMinutes: 30, now: new Date(), customerIds: [] };
	assert.equal(useOptimizedCentralMonitor(base, false), true);
	assert.equal(useOptimizedCentralMonitor({ ...base, local: true }, false), false);
	assert.equal(useOptimizedCentralMonitor(base, true), false);
	assert.equal(useOptimizedCentralMonitor({ ...base, session: { ...session, instance: "nunes" } }, false), false);
	assert.equal(useOptimizedCentralMonitor({ ...base, session: { ...session, role: "ATIVO" } }, false), false);
	const cache = new Map<string, NodeModule | undefined>();
	const stub = (relative: string, value: unknown, plain = false) => {
		const id = require.resolve(relative); cache.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: plain ? value : { __esModule: true, default: value } } as NodeModule;
	};
	let tenantSql = false, local = false;
	const calls: string[] = [];
	const summary = { inProgress: 0, waitingAgent: 0, waitingCustomer: 0, unread: 0, overdue: 0, scheduled: 0, slaMinutes: 30 };
	try {
		stub("../../tenant-sql/registry", { tenantSqlEnabled: () => tenantSql }, true);
		for (const path of ["../chats.service", "../internal-chats.service", "../schedules.service", "../message-presentation.service", "../prisma.service"]) stub(path, {});
		stub("../instances.service", { executeQuery: () => { throw Error("unexpected CRM read"); } });
		stub("../parameters.service", { getSessionParams: async () => ({ "monitor:use_local_search": local ? "true" : "false", "monitor:sla_minutes": "30" }) });
		const originalReader = require("./monitor-reader") as typeof import("./monitor-reader");
		stub("./monitor-reader", { ...originalReader,
			monitorSources: () => [],
			monitorPage: async (_execute: unknown, _sources: unknown, request: { page: number; pageSize: number }) => { calls.push("generic-search"); return { rows: [], totalCount: 0, page: request.page, pageSize: request.pageSize }; },
			monitorSummary: async () => { calls.push("generic-summary"); return summary; }
		}, true);
		stub("./optimized-search", { readOptimizedCentralMonitorSearch: async (_context: unknown, request: { page: number; pageSize: number }) => { calls.push("optimized-search"); return { rows: [], totalCount: 0, page: request.page, pageSize: request.pageSize }; } }, true);
		stub("./optimized-summary", { readOptimizedCentralMonitorSummary: async () => { calls.push("optimized-summary"); return summary; } }, true);
		const serviceId = require.resolve("../monitor.service"); cache.set(serviceId, require.cache[serviceId]); delete require.cache[serviceId];
		const service = (require("../monitor.service") as typeof import("../monitor.service")).default;
		const run = async (actor: SessionData, expected: string) => {
			calls.length = 0;
			assert.deepEqual(await service.searchMonitorData(actor, { page: 2, pageSize: 5 }), { items: [], totalCount: 0, page: 2, pageSize: 5 });
			assert.deepEqual(await service.getMonitorSummary(actor, {}), summary);
			assert.deepEqual(calls, [`${expected}-search`, `${expected}-summary`]);
		};
		await run(session, "optimized");
		await run({ ...session, instance: "infotec" }, "optimized");
		await run({ ...session, instance: "nunes" }, "generic");
		local = true; await run(session, "generic");
		tenantSql = true; await run(session, "generic");
		local = false; await run(session, "generic");
		console.log("optimized monitor dispatch: central Odim/Infotec only; local, tenant SQL and other tenants preserved");
	} finally { for (const [id, value] of cache) { if (value) require.cache[id] = value; else delete require.cache[id]; } }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
