import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string | null>();

export function normalizeDatabaseTenant(value: unknown): string | null {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) ? value : null;
}

/** Store only the tenant identifier, never the session, payload or credentials. */
export function withDatabaseTenant<T>(instance: unknown, execute: () => T): T {
	return storage.run(normalizeDatabaseTenant(instance), execute);
}

export function currentDatabaseTenant(): string | null {
	return storage.getStore() ?? null;
}
