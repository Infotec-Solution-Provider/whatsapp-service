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

function allocationIncrement(registry: TenantSqlRegistry, target: TenantSqlTarget): number {
	// Keep the even series for Suprimaxxi. With three targets split the odd series.
	return registry.tenants.some(item => item.instance === "infotec") && target.instance !== "suprimaxxi" ? 4 : 2;
}

export function tenantSqlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const mode = env["WHATSAPP_STORAGE"] ?? "central";
	if (mode !== "tenant-sql" && (env["WHATSAPP_TENANT_SQL_REGISTRY"] || env["INPULSE_ENVIRONMENT"] === "homolog"))
		throw new Error("Homolog WhatsApp requires tenant-sql");
	if (mode !== "central" && mode !== "tenant-sql") throw new Error("Invalid WHATSAPP_STORAGE");
	return mode === "tenant-sql";
}

export function validateRegistry(input: unknown): TenantSqlRegistry {
	const registry = input as TenantSqlRegistry;
	if (!registry || registry.version !== 1 || registry.host !== "127.0.0.1" || registry.port !== 3306 ||
		registry.user !== "homolog" || registry.sourceDatabase !== "homolog-whatsapp" ||
		registry.credentialFile !== "/home/inpulse/htdocs/homolog/.db-password" ||
		registry.tablePrefix !== "wpp_runtime_" || registry.autoIncrementIncrement !== 2 ||
		!Array.isArray(registry.tenants) || ![2, 3].includes(registry.tenants.length)) {
		throw new Error("Tenant SQL registry is not a prepared homolog registry");
	}
	const targets: Record<string, { database: string; offset: number }> = {
		homolog: { database: "homolog-crm", offset: 1 },
		suprimaxxi: { database: "homolog-crm-suprimaxxi", offset: 2 },
		infotec: { database: "homolog-infotec-whatsapp-runtime", offset: 3 },
	};
	const names = new Set<string>();
	const slots = new Set<number>();
	for (const target of registry.tenants) {
		const identity = targets[target.instance];
		if (identity?.database !== target.database || identity.offset !== target.autoIncrementOffset || target.prepared !== true || names.has(target.instance) ||
			slots.has(target.autoIncrementOffset)) throw new Error("Tenant SQL target identity or preparation is invalid");
		names.add(target.instance);
		slots.add(target.autoIncrementOffset);
	}
	if (!names.has("suprimaxxi")) throw new Error("Tenant SQL target set is invalid");
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
			(connection as unknown as import("mysql2").PoolConnection).query(`SET time_zone = '+00:00', auto_increment_increment = ${allocationIncrement(registry, target)}, auto_increment_offset = ${target.autoIncrementOffset}, sql_mode = IF(FIND_IN_SET('STRICT_ALL_TABLES', @@sql_mode), @@sql_mode, CONCAT_WS(',', @@sql_mode, 'STRICT_ALL_TABLES'))`,
				(error: Error | null) => { if (error) connection.destroy(); });
		});
		return [target.instance, pool] as const;
	}));
}
