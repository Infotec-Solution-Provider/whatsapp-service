import { readFileSync } from "node:fs";
import { createPool, type Pool } from "mysql2/promise";

export interface TenantSqlTarget {
	instance: string;
	database: string;
	autoIncrementOffset: number;
	prepared: boolean;
}
export interface TenantSqlRegistry {
	version: number;
	host: string;
	port: number;
	user: string;
	credentialFile: string;
	sourceDatabase: string;
	tablePrefix: string;
	autoIncrementIncrement: number;
	tenants: TenantSqlTarget[];
}

export function tenantSqlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const mode = env["WHATSAPP_STORAGE"] ?? "central";
	if (mode !== "central" && mode !== "tenant-sql") throw new Error("Invalid WHATSAPP_STORAGE");
	return mode === "tenant-sql";
}

export function validateRegistry(input: unknown): TenantSqlRegistry {
	const registry = input as TenantSqlRegistry;
	if (!registry || registry.version !== 1 || registry.host !== "127.0.0.1" || registry.port !== 3306 ||
		registry.user !== "homolog" || registry.sourceDatabase !== "homolog-whatsapp" ||
		registry.credentialFile !== "/home/inpulse/htdocs/homolog/.db-password" ||
		registry.tablePrefix !== "wpp_runtime_" || registry.autoIncrementIncrement !== 2 ||
		!Array.isArray(registry.tenants) || registry.tenants.length !== 2) {
		throw new Error("Tenant SQL registry is not a prepared homolog registry");
	}
	const targets: Record<string, string> = { homolog: "homolog-crm", suprimaxxi: "homolog-crm-suprimaxxi" };
	const names = new Set<string>();
	const slots = new Set<number>();
	for (const target of registry.tenants) {
		if (targets[target.instance] !== target.database || target.prepared !== true || names.has(target.instance) ||
			!Number.isInteger(target.autoIncrementOffset) || target.autoIncrementOffset < 1 || target.autoIncrementOffset > 2 ||
			slots.has(target.autoIncrementOffset)) throw new Error("Tenant SQL target identity or preparation is invalid");
		names.add(target.instance);
		slots.add(target.autoIncrementOffset);
	}
	return registry;
}

export function loadTenantPools(): Map<string, Pool> {
	const path = process.env["WHATSAPP_TENANT_SQL_REGISTRY"];
	if (!path) throw new Error("WHATSAPP_TENANT_SQL_REGISTRY is required");
	const registry = validateRegistry(JSON.parse(readFileSync(path, "utf8")));
	const password = readFileSync(registry.credentialFile, "utf8").trim();
	if (!password) throw new Error("Homolog tenant SQL credential is missing");
	return new Map(registry.tenants.map((target) => {
		const pool = createPool({
			host: registry.host, port: registry.port, user: registry.user, password, database: target.database,
			connectionLimit: 2, maxIdle: 2, idleTimeout: 60_000, waitForConnections: true, queueLimit: 8,
			connectTimeout: 10_000, timezone: "Z", charset: "utf8mb4", supportBigNumbers: true,
			bigNumberStrings: true, decimalNumbers: true, enableKeepAlive: true,
		});
		pool.on("connection", (connection) => {
			(connection as unknown as import("mysql2").PoolConnection).query(`SET time_zone = '+00:00', auto_increment_increment = 2, auto_increment_offset = ${target.autoIncrementOffset}, sql_mode = IF(FIND_IN_SET('STRICT_ALL_TABLES', @@sql_mode), @@sql_mode, CONCAT_WS(',', @@sql_mode, 'STRICT_ALL_TABLES'))`,
				(error: Error | null) => { if (error) connection.destroy(); });
		});
		return [target.instance, pool] as const;
	}));
}
