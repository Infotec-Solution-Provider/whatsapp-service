import assert from "node:assert/strict";
import type { SessionData } from "../../sdk-local";
import { useOptimizedMonitor } from "./optimized-access";
import { parseMonitorRequest } from "./monitor-contract";
import { readOptimizedMonitorSearch } from "./optimized-search";
import { readOptimizedMonitorSummary } from "./optimized-summary";

async function main() {
	const session: SessionData = { instance: "odim", role: "ADMIN", userId: 9, sectorId: 138, name: "Fixture" };
	const base = { session, filters: parseMonitorRequest({}).filters, local: false, slaMinutes: 30, now: new Date(), customerIds: [] };
	const nativeSession = { ...session, instance: "suprimaxxi" };
	const native = { ...base, session: nativeSession };
	assert.equal(useOptimizedMonitor(base, false), true);
	assert.equal(useOptimizedMonitor({ ...base, local: true }, false), false);
	assert.equal(useOptimizedMonitor(base, true), false);
	assert.equal(useOptimizedMonitor({ ...base, session: { ...session, instance: "nunes" } }, false), false);
	assert.equal(useOptimizedMonitor({ ...base, session: { ...session, role: "ATIVO" } }, false), false);
	assert.equal(useOptimizedMonitor(native, true), true);
	assert.equal(useOptimizedMonitor(native, false), false);
	assert.equal(useOptimizedMonitor({ ...native, local: true }, true), false);
	const operator = { ...native, session: { ...nativeSession, role: "ATIVO" as const } };
	assert.equal(useOptimizedMonitor(operator, true), false);

	const empty = parseMonitorRequest({ filters: { categories: {
		showCustomerChats: false, showInternalChats: false, showInternalGroups: false, showSchedules: false
	} } });
	const emptyNative = { ...native, filters: empty.filters };
	const doNotQuery = async () => { throw Error("unexpected optimized query"); };
	await readOptimizedMonitorSearch(emptyNative, empty, true, doNotQuery);
	await readOptimizedMonitorSummary(emptyNative, true, doNotQuery);
	await assert.rejects(readOptimizedMonitorSearch(emptyNative, empty, false, doNotQuery), /Modern monitor scope unavailable/);
	await assert.rejects(readOptimizedMonitorSummary(emptyNative, false, doNotQuery), /MODERN_SUMMARY_SCOPE_REQUIRED/);
	await assert.rejects(readOptimizedMonitorSearch(operator, empty, true, doNotQuery), /Modern monitor scope unavailable/);
	await assert.rejects(readOptimizedMonitorSummary(operator, true, doNotQuery), /MODERN_SUMMARY_SCOPE_REQUIRED/);
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
		stub("./optimized-search", {
			readOptimizedMonitorSearch: async (_context: unknown, request: { page: number; pageSize: number }, useTenantSql: boolean) => {
				assert.equal(useTenantSql, tenantSql);
				calls.push("optimized-search");
				return { rows: [], totalCount: 0, page: request.page, pageSize: request.pageSize };
			}
		}, true);
		stub("./optimized-summary", {
			readOptimizedMonitorSummary: async (_context: unknown, useTenantSql: boolean) => {
				assert.equal(useTenantSql, tenantSql);
				calls.push("optimized-summary");
				return summary;
			}
		}, true);
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
		await run(nativeSession, "generic");
		local = true; await run(session, "generic");
		tenantSql = true; await run(session, "generic");
		local = false; await run(session, "generic");
		await run({ ...session, instance: "infotec" }, "generic");
		await run(nativeSession, "optimized");
		await run(operator.session, "generic");
		console.log("optimized monitor dispatch: central Odim/Infotec and tenant SQL Suprimaxxi ADMIN");
	} finally { for (const [id, value] of cache) { if (value) require.cache[id] = value; else delete require.cache[id]; } }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
