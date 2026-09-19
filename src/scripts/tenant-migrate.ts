import "dotenv/config";
import { createPool, RowDataPacket } from "mysql2/promise";
import { acquire, createManagedPool, databaseErrorCode, mysqlOptions, sql } from "../database/managed-mysql";
import { inspectTenantDatabase, probeTenantText } from "../tenant-migration/inspect";

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) { console.log("tenant:migrate --tenant NAME --phase inspect|probe\nUses INSTANCES_DATABASE_URL registry, or TENANT_DATABASE_URL for a directly managed destination. inspect is read-only; probe writes only synthetic data to a temporary connection-private table. No data cutover is available yet."); return; }
	let tenant = "", phase = "inspect";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--tenant") tenant = args[++i] || "";
		else if (args[i] === "--phase") phase = args[++i] || "";
		else throw new Error("Unknown argument");
	}
	if (!tenant || tenant.length > 191 || !["inspect", "probe"].includes(phase)) throw new Error("Tenant required; implemented phases: inspect, probe");
	let target;
	if (process.env["TENANT_DATABASE_URL"]) target = createManagedPool(process.env["TENANT_DATABASE_URL"], 1);
	else {
		if (!process.env["INSTANCES_DATABASE_URL"]) throw new Error("Registry configuration required");
		const registry = createManagedPool(process.env["INSTANCES_DATABASE_URL"], 1);
		try {
			const connection = await acquire(registry);
			try {
				const rows = await sql<RowDataPacket[]>(connection, "SELECT host, port, username, password, `database` FROM clients_servers WHERE instance_name = ?", [tenant]);
				if (rows.length !== 1) throw new Error("Tenant destination not found");
				const row = rows[0]!;
				target = createPool({ ...mysqlOptions("mysql://localhost/placeholder", 1), host: String(row["host"]), port: Number(row["port"]), user: String(row["username"]), password: String(row["password"]), database: String(row["database"]) });
			} finally { connection.destroy(); }
		} finally { await registry.end(); }
	}
	try {
		const connection = await acquire(target);
		try {
			const inspection = await inspectTenantDatabase(connection);
			if (phase === "probe") {
				if (!inspection.eligibleForNativeTextProbe) throw new Error("Native Unicode unavailable; legacy profile needs validation");
				await probeTenantText(connection);
			}
			console.log(JSON.stringify({ tenant, phase, ...inspection, textRoundTripPassed: phase === "probe" }, null, 2));
		} finally { connection.destroy(); }
	} finally { await target.end(); }
}

if (require.main === module) void main().catch(error => { console.error(JSON.stringify({ error: databaseErrorCode(error), detail: "Tenant preflight failed; no runtime routing was changed" })); process.exitCode = 1; });
