import type { SessionData } from "../../sdk-local";
import type { MonitorQueryContext } from "./monitor-query";

/** Optimized SQL targets central tables only; callers keep tenant SQL/local readers. */
export function hasOptimizedCentralScope(session: Pick<SessionData, "instance" | "role">): boolean {
	return (session.instance === "odim" || session.instance === "infotec") && session.role === "ADMIN";
}

export function useOptimizedCentralMonitor(context: MonitorQueryContext, tenantSql: boolean): boolean {
	return !tenantSql && !context.local && hasOptimizedCentralScope(context.session);
}
