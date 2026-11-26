import type { MonitorQueryContext } from "./monitor-query";

/** The tenant SQL compiler resolves logical tables inside the requested tenant's runtime. */
export function useOptimizedMonitor(context: MonitorQueryContext, tenantSql: boolean): boolean {
	const { instance, role } = context.session;
	if (context.local || role !== "ADMIN") return false;
	return tenantSql ? instance === "suprimaxxi" : instance === "odim" || instance === "infotec";
}
