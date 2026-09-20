import "dotenv/config";
import { createPool, PoolOptions, RowDataPacket } from "mysql2/promise";
import { acquire, databaseErrorCode, mysqlOptions, sql } from "../database/managed-mysql";
import { inspectTenantDatabase, probeTenantText } from "../tenant-migration/inspect";
import { TextProfile } from "../tenant-migration/encoding";

// Only fixed labels and boolean presence; never print URLs or driver messages/SQL.
const diagnostic = {
	component: "tenant-migration", diagnosticsVersion: 2, stage: "arguments",
	connectTimeoutMs: 10000,
	cwd: process.cwd(), module: __filename,
	configuration: {
		tenantDatabaseUrlPresent: Boolean(process.env["TENANT_DATABASE_URL"]),
		instancesDatabaseUrlPresent: Boolean(process.env["INSTANCES_DATABASE_URL"]),
	},
};

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) { console.log("tenant:migrate --tenant NAME --phase inspect|probe [--text-profile utf8mb4-native-v1|percent-encoded-v1] [--connect-timeout-ms 10000]\nConnection and acquisition timeout: 1000..30000 ms, default 10000; administrative CLI only. Query deadlines are unchanged.\nUses INSTANCES_DATABASE_URL registry, or TENANT_DATABASE_URL for a directly managed destination. inspect reads metadata of existing wpp_* tables, columns, indexes, foreign keys and triggers visible to the database user, without reading payloads. Inspection starts with utf8 for servers older than 5.5.3. probe writes synthetic data only to a temporary connection-private table; native utf8mb4 is the default and never falls back silently. No data copy or cutover is available yet."); return; }
	let tenant = "", phase = "inspect";
	let profile: TextProfile = "utf8mb4-native-v1";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--tenant") tenant = args[++i] || "";
		else if (args[i] === "--phase") phase = args[++i] || "";
		else if (args[i] === "--text-profile") {
			const value = args[++i];
			if (value !== "utf8mb4-native-v1" && value !== "percent-encoded-v1") throw new Error("Unknown text storage profile");
			profile = value;
		}
		else if (args[i] === "--connect-timeout-ms") {
			const raw = args[++i] || "";
			const value = Number(raw);
			if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1000 || value > 30000)
				throw new Error("Invalid tenant connection timeout");
			diagnostic.connectTimeoutMs = value;
		}
		else throw new Error("Unknown argument");
	}
	if (!tenant || tenant.length > 191 || !["inspect", "probe"].includes(phase)) throw new Error("Tenant required; implemented phases: inspect, probe");
	diagnostic.stage = "configuration";
	let targetOptions: PoolOptions;
	// Metadata is inspected through utf8 before attempting a native utf8mb4 probe.
	// This bootstrap is private to the administrative CLI, not a runtime pool fallback.
	if (process.env["TENANT_DATABASE_URL"]) targetOptions = { ...mysqlOptions(process.env["TENANT_DATABASE_URL"], 1), charset: "utf8_general_ci" };
	else {
		if (!process.env["INSTANCES_DATABASE_URL"]) throw new Error("Registry configuration required");
		diagnostic.stage = "registry-configuration";
		const registry = createPool({ ...mysqlOptions(process.env["INSTANCES_DATABASE_URL"], 1), connectTimeout: diagnostic.connectTimeoutMs });
		try {
			diagnostic.stage = "registry-connect";
			const connection = await acquire(registry, diagnostic.connectTimeoutMs);
			try {
				diagnostic.stage = "registry-lookup";
				const rows = await sql<RowDataPacket[]>(connection, "SELECT host, port, username, password, `database` FROM clients_servers WHERE instance_name = ?", [tenant]);
				if (rows.length === 0) throw new Error("Tenant destination not found");
				if (rows.length !== 1) throw new Error("Tenant destination is ambiguous");
				const row = rows[0]!;
				targetOptions = { ...mysqlOptions("mysql://localhost/placeholder", 1), charset: "utf8_general_ci", host: String(row["host"]), port: Number(row["port"]), user: String(row["username"]), password: String(row["password"]), database: String(row["database"]) };
			} finally { connection.destroy(); }
		} finally { await registry.end(); }
	}
	diagnostic.stage = "target-configuration";
	targetOptions.connectTimeout = diagnostic.connectTimeoutMs;
	const target = createPool(targetOptions);
	try {
		diagnostic.stage = "target-connect";
		const connection = await acquire(target, diagnostic.connectTimeoutMs);
		try {
			diagnostic.stage = "target-inspect";
			const inspection = await inspectTenantDatabase(connection);
			if (phase === "probe") {
				diagnostic.stage = "text-profile-validation";
				if (profile === "utf8mb4-native-v1") {
					if (!inspection.eligibleForNativeTextProbe) throw new Error("Native Unicode unavailable; legacy profile needs validation");
					// Reconnect with the matching client codec too: SET NAMES alone leaves mysql2's
					// utf8/cesu8 encoder unchanged and can corrupt supplementary characters.
					connection.destroy();
					const nativePool = createPool({ ...targetOptions, charset: "utf8mb4_unicode_ci" });
					try {
						diagnostic.stage = "native-probe-connect";
						const native = await acquire(nativePool, diagnostic.connectTimeoutMs);
						diagnostic.stage = "text-probe";
						try { await probeTenantText(native, profile); } finally { native.destroy(); }
					} finally { await nativePool.end(); }
				} else {
					diagnostic.stage = "text-probe";
					await probeTenantText(connection, profile);
				}
			}
			diagnostic.stage = "report";
			console.log(JSON.stringify({ tenant, phase, connectTimeoutMs: diagnostic.connectTimeoutMs, ...inspection, settingsCollectedBeforeProbe: true,
				textProfileTested: phase === "probe" ? profile : null, textRoundTripPassed: phase === "probe" }, null, 2));
		} finally { connection.destroy(); }
	} finally { await target.end(); }
}

if (require.main === module) void main().catch(error => {
	const code = databaseErrorCode(error);
	const details: Record<string, string> = {
		TENANT_CONNECTION_CONFIG_MISSING: "Set TENANT_DATABASE_URL for the tenant destination, or INSTANCES_DATABASE_URL for the registry, in the command's effective environment.",
		TENANT_DESTINATION_NOT_FOUND: "No matching tenant was found in the configured registry.",
		TENANT_DESTINATION_AMBIGUOUS: "More than one destination matched the tenant; no destination was selected.",
		TENANT_ARGUMENTS_INVALID: "Use --tenant NAME --phase inspect|probe; see --help.",
		TENANT_CONNECT_TIMEOUT_INVALID: "Use --connect-timeout-ms with an integer between 1000 and 30000 (default 10000).",
	};
	console.error(JSON.stringify({ ...diagnostic, error: code,
		detail: details[code] ?? "Tenant preflight failed at the reported stage; no runtime routing was changed" }));
	process.exitCode = 1;
});
