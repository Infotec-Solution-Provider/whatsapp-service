import { createHash } from "node:crypto";
import mysql, { Pool, PoolConnection, PoolOptions, RowDataPacket } from "mysql2/promise";

/** Never pass driver errors/URLs to a logger: they can contain SQL and secrets. */
export function databaseErrorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && /^(ER_[A-Z0-9_]+|E[A-Z]+|PROTOCOL_[A-Z_]+|P\d{4})$/.test(code)) return code;
	// Only recognize controlled messages; never print the driver's message or configuration.
	const message = error instanceof Error ? error.message : "";
	const known: Record<string, string> = {
		"Log store not active": "LOG_STORE_NOT_ACTIVE",
		"Log write verification failed": "LOG_WRITE_VERIFICATION_FAILED",
		"Log queue full": "LOG_QUEUE_FULL",
		"Log writer stopped": "LOG_WRITER_STOPPED",
		"Database acquisition timeout": "DATABASE_ACQUIRE_TIMEOUT",
		"Database query timeout": "DATABASE_QUERY_TIMEOUT",
		"Invalid database configuration": "DATABASE_CONFIG_INVALID",
		"Unsupported database URL option": "DATABASE_URL_OPTION_UNSUPPORTED",
		"Unsupported database TLS mode": "DATABASE_TLS_MODE_UNSUPPORTED",
		"URI malformed": "DATABASE_URL_ENCODING_INVALID",
		"LOGS_DATABASE_URL is required": "LOGS_DATABASE_URL_MISSING",
		"Invalid PROCESS_LOG_POOL_SIZE": "LOG_POOL_SIZE_INVALID",
		"Invalid PROCESS_LOG_MAX_PENDING": "LOG_MAX_PENDING_INVALID",
		"Cleanup requires dedicated log storage": "LOG_CLEANUP_REQUIRES_DEDICATED",
		"Invalid daily log cleanup schedule": "LOG_CLEANUP_SCHEDULE_INVALID",
		"Invalid log cleanup timezone": "LOG_CLEANUP_TIMEZONE_INVALID",
		"No connections available.": "DATABASE_POOL_BUSY",
		"Queue limit reached.": "DATABASE_POOL_QUEUE_FULL",
		"Pool is closed.": "DATABASE_POOL_CLOSED",
	};
	if (Object.prototype.hasOwnProperty.call(known, message)) return known[message]!;
	if (/^Invalid PROCESS_LOG_[A-Z_]+$/.test(message)) return "LOG_CONFIG_INVALID";
	return "DATABASE_OPERATION_FAILED";
}

export function mysqlOptions(raw: string, connectionLimit = 2): PoolOptions {
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error("Invalid database configuration"); }
	if (url.protocol !== "mysql:" || !url.hostname || url.pathname.length < 2 || url.hash) throw new Error("Invalid database configuration");
	const supported = new Set(["connection_limit", "pool_timeout", "connect_timeout", "sslmode"]);
	for (const key of url.searchParams.keys()) if (!supported.has(key)) throw new Error("Unsupported database URL option");
	const tls = url.searchParams.get("sslmode");
	if (tls && !["disable", "require", "verify-full"].includes(tls)) throw new Error("Unsupported database TLS mode");
	return {
		host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 3306),
		user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
		database: decodeURIComponent(url.pathname.slice(1)), charset: "utf8mb4_unicode_ci",
		timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
		multipleStatements: false, connectTimeout: 3000, connectionLimit,
		waitForConnections: false, maxIdle: 0, idleTimeout: 30000, maxPreparedStatements: 50,
		...(tls && tls !== "disable" ? { ssl: { rejectUnauthorized: true } } : {}),
	};
}

export function createManagedPool(raw: string, limit = 2, queueLimit = 0): Pool {
	return mysql.createPool({ ...mysqlOptions(raw, limit), waitForConnections: queueLimit > 0, queueLimit });
}

/** Finite acquisition and query deadlines. A timed-out session is never reused. */
export async function acquire(pool: Pool, timeoutMs = 3000): Promise<PoolConnection> {
	const connection = await new Promise<PoolConnection>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; reject(new Error("Database acquisition timeout")); }, timeoutMs);
		void pool.getConnection().then(connection => {
			if (settled) { connection.destroy(); return; }
			settled = true; clearTimeout(timer); resolve(connection);
		}, error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
	});
	// Enforce failure instead of silent truncation, independently of server defaults.
	await sql(connection, "SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES')");
	await sql(connection, "SET SESSION time_zone = '+00:00'");
	return connection;
}

export async function sql<T>(connection: PoolConnection, statement: string, values: unknown[] = [], timeoutMs = 3000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(values.length
				? connection.execute({ sql: statement, values, timeout: timeoutMs })
				: connection.query({ sql: statement, timeout: timeoutMs })).then(([rows]) => rows as T),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => { connection.destroy(); reject(new Error("Database query timeout")); }, timeoutMs);
			}),
		]);
	} catch (error) { connection.destroy(); throw error; }
	finally { if (timer) clearTimeout(timer); }
}

export async function databaseIdentity(connection: PoolConnection): Promise<{ hostname: string; port: number; database_name: string; version: string }> {
	const rows = await sql<RowDataPacket[]>(connection, "SELECT @@hostname AS hostname, @@port AS port, DATABASE() AS database_name, @@version AS version");
	const row = rows[0]!;
	if (!row["database_name"]) throw new Error("No database selected");
	return { hostname: String(row["hostname"]), port: Number(row["port"]), database_name: String(row["database_name"]), version: String(row["version"]) };
}

export function scopedLock(database: string, purpose: string): string {
	return `inpulse:${purpose}:${createHash("sha256").update(database).digest("hex").slice(0, 32)}`;
}
