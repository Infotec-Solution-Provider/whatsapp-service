import "dotenv/config";
import { createPool, PoolOptions, RowDataPacket } from "mysql2/promise";
import { acquire, createManagedPool, databaseErrorCode, mysqlOptions, sql } from "../database/managed-mysql";
import { inspectTenantDatabase, probeTenantText } from "../tenant-migration/inspect";
import { TextProfile } from "../tenant-migration/encoding";

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) { console.log("tenant:migrate --tenant NAME --phase inspect|probe [--text-profile utf8mb4-native-v1|percent-encoded-v1]\nUses INSTANCES_DATABASE_URL registry, or TENANT_DATABASE_URL for a directly managed destination. inspect reads metadata of existing wpp_* tables, columns, indexes, foreign keys and triggers visible to the database user, without reading payloads. Inspection starts with utf8 for servers older than 5.5.3. probe writes synthetic data only to a temporary connection-private table; native utf8mb4 is the default and never falls back silently. No data copy or cutover is available yet."); return; }
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
		else throw new Error("Unknown argument");
	}
	if (!tenant || tenant.length > 191 || !["inspect", "probe"].includes(phase)) throw new Error("Tenant required; implemented phases: inspect, probe");
	let targetOptions: PoolOptions;
	// Metadata is inspected through utf8 before attempting a native utf8mb4 probe.
	// This bootstrap is private to the administrative CLI, not a runtime pool fallback.
	if (process.env["TENANT_DATABASE_URL"]) targetOptions = { ...mysqlOptions(process.env["TENANT_DATABASE_URL"], 1), charset: "utf8_general_ci" };
	else {
		if (!process.env["INSTANCES_DATABASE_URL"]) throw new Error("Registry configuration required");
		const registry = createManagedPool(process.env["INSTANCES_DATABASE_URL"], 1);
		try {
			const connection = await acquire(registry);
			try {
				const rows = await sql<RowDataPacket[]>(connection, "SELECT host, port, username, password, `database` FROM clients_servers WHERE instance_name = ?", [tenant]);
				if (rows.length !== 1) throw new Error("Tenant destination not found");
				const row = rows[0]!;
				targetOptions = { ...mysqlOptions("mysql://localhost/placeholder", 1), charset: "utf8_general_ci", host: String(row["host"]), port: Number(row["port"]), user: String(row["username"]), password: String(row["password"]), database: String(row["database"]) };
			} finally { connection.destroy(); }
		} finally { await registry.end(); }
	}
	const target = createPool(targetOptions);
	try {
		const connection = await acquire(target);
		try {
			const inspection = await inspectTenantDatabase(connection);
			if (phase === "probe") {
				if (profile === "utf8mb4-native-v1") {
					if (!inspection.eligibleForNativeTextProbe) throw new Error("Native Unicode unavailable; legacy profile needs validation");
					// Reconnect with the matching client codec too: SET NAMES alone leaves mysql2's
					// utf8/cesu8 encoder unchanged and can corrupt supplementary characters.
					connection.destroy();
					const nativePool = createPool({ ...targetOptions, charset: "utf8mb4_unicode_ci" });
					try {
						const native = await acquire(nativePool);
						try { await probeTenantText(native, profile); } finally { native.destroy(); }
					} finally { await nativePool.end(); }
				} else await probeTenantText(connection, profile);
			}
			console.log(JSON.stringify({ tenant, phase, ...inspection, settingsCollectedBeforeProbe: true,
				textProfileTested: phase === "probe" ? profile : null, textRoundTripPassed: phase === "probe" }, null, 2));
		} finally { connection.destroy(); }
	} finally { await target.end(); }
}

if (require.main === module) void main().catch(error => { console.error(JSON.stringify({ error: databaseErrorCode(error), detail: "Tenant preflight failed; no runtime routing was changed" })); process.exitCode = 1; });
