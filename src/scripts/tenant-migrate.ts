import "dotenv/config";
import { createPool, PoolOptions, RowDataPacket } from "mysql2/promise";
import { acquire, databaseErrorCode, mysqlOptions, sql } from "../database/managed-mysql";
import { inspectTenantDatabase, probeTenantText } from "../tenant-migration/inspect";
import { TextProfile } from "../tenant-migration/encoding";
import { prepareTenant, TenantPrepareError } from "../tenant-migration/prepare";

// Only fixed labels and boolean presence; never print URLs or driver messages/SQL.
const diagnostic = {
	component: "tenant-migration", diagnosticsVersion: 2, stage: "arguments",
	connectTimeoutMs: 10000,
	step: "",
	cwd: process.cwd(), module: __filename,
	configuration: {
		tenantDatabaseUrlPresent: Boolean(process.env["TENANT_DATABASE_URL"]),
		instancesDatabaseUrlPresent: Boolean(process.env["INSTANCES_DATABASE_URL"]),
	},
};

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) { console.log(`tenant:migrate --tenant NAME --phase inspect|probe|prepare
  [--text-profile utf8mb4-native-v1|percent-encoded-v1] [--connect-timeout-ms 10000]
prepare requires --text-profile percent-encoded-v1 --expected-hostname HOST --expected-database DB.
prepare defaults to --dry-run (metadata and planned DDL only).
Apply with --apply --writers-quiesced after pausing all writers of destination wpp_* including legacy sync.
  [--ddl-timeout-ms 600000] (1000..3600000, administrative DDL only)
Connection/acquisition timeout: 1000..30000 ms. Ordinary query deadlines are unchanged.
Uses INSTANCES_DATABASE_URL registry, or TENANT_DATABASE_URL for a directly managed destination.
inspect reads wpp_* metadata visible to the database user. Bootstrap uses utf8 for servers older than 5.5.3.
probe writes synthetic data only to a temporary private table. No silent text-profile fallback.
prepare validates the legacy core schema, widens contacts.name, allows NULL phone, adds nullable domain/epoch-ms fields,
and records resumable DDL in wpp_tenant_prepare. It can block table access on old MySQL; use a maintenance window.
No source database is opened, no existing business row is updated/deleted, and no copy or cutover is available yet.`); return; }
	let tenant = "", phase = "inspect";
	let profile: TextProfile = "utf8mb4-native-v1";
	let expectedHostname = "", expectedDatabase = "", apply = false, dryRun = false, writersQuiesced = false, ddlTimeoutMs = 600000;
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
		else if (args[i] === "--expected-hostname") expectedHostname = args[++i] || "";
		else if (args[i] === "--expected-database") expectedDatabase = args[++i] || "";
		else if (args[i] === "--apply") apply = true;
		else if (args[i] === "--dry-run") dryRun = true;
		else if (args[i] === "--writers-quiesced") writersQuiesced = true;
		else if (args[i] === "--ddl-timeout-ms") {
			const raw = args[++i] || "";
			ddlTimeoutMs = Number(raw);
			if (!/^\d+$/.test(raw) || !Number.isSafeInteger(ddlTimeoutMs) || ddlTimeoutMs < 1000 || ddlTimeoutMs > 3600000)
				throw new TenantPrepareError("TENANT_DDL_TIMEOUT_INVALID");
		}
		else throw new Error("Unknown argument");
	}
	if (!tenant || tenant.length > 191 || !["inspect", "probe", "prepare"].includes(phase) || (apply && dryRun)
		|| (phase !== "prepare" && (apply || dryRun || writersQuiesced || expectedHostname || expectedDatabase || args.includes("--ddl-timeout-ms"))))
		throw new TenantPrepareError("TENANT_ARGUMENTS_INVALID");
	if (phase === "prepare") {
		if (profile !== "percent-encoded-v1") throw new TenantPrepareError("TENANT_PREPARE_PROFILE_UNSUPPORTED");
		if (!expectedHostname || !expectedDatabase) throw new TenantPrepareError("TENANT_PREPARE_IDENTITY_REQUIRED");
		if (apply && !writersQuiesced) throw new TenantPrepareError("TENANT_PREPARE_QUIESCENCE_REQUIRED");
	}
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
			if (phase === "prepare") {
				const result = await prepareTenant(connection, {
					tenant, profile, expectedHostname, expectedDatabase, apply, writersQuiesced, ddlTimeoutMs,
					progress: (stage, step) => {
						diagnostic.stage = stage; diagnostic.step = step ?? "";
						if (apply) console.error(JSON.stringify({ component: diagnostic.component, stage, step: diagnostic.step }));
					},
				});
				console.log(JSON.stringify({ tenant, phase, connectTimeoutMs: diagnostic.connectTimeoutMs, ...result }, null, 2));
				return;
			}
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
	const code = error instanceof TenantPrepareError ? error.diagnosticCode : databaseErrorCode(error);
	const details: Record<string, string> = {
		TENANT_CONNECTION_CONFIG_MISSING: "Set TENANT_DATABASE_URL for the tenant destination, or INSTANCES_DATABASE_URL for the registry, in the command's effective environment.",
		TENANT_DESTINATION_NOT_FOUND: "No matching tenant was found in the configured registry.",
		TENANT_DESTINATION_AMBIGUOUS: "More than one destination matched the tenant; no destination was selected.",
		TENANT_ARGUMENTS_INVALID: "Use --tenant NAME --phase inspect|probe|prepare; see --help. Do not combine --dry-run with --apply.",
		TENANT_CONNECT_TIMEOUT_INVALID: "Use --connect-timeout-ms with an integer between 1000 and 30000 (default 10000).",
		TENANT_DDL_TIMEOUT_INVALID: "Use --ddl-timeout-ms between 1000 and 3600000 (default 600000).",
		TENANT_PREPARE_PROFILE_UNSUPPORTED: "This prepare version requires explicit --text-profile percent-encoded-v1.",
		TENANT_PREPARE_IDENTITY_REQUIRED: "Specify --expected-hostname and --expected-database from the reviewed destination inventory.",
		TENANT_PREPARE_IDENTITY_MISMATCH: "Connected destination differs from the expected identity; no schema change was applied.",
		TENANT_PREPARE_QUIESCENCE_REQUIRED: "Pause destination wpp_* writers including legacy sync, then pass --apply --writers-quiesced in the maintenance window.",
		TENANT_PREPARE_BUSY: "Another prepare owns the destination lock; no schema change was applied by this process.",
		TENANT_PREPARE_SCHEMA_CONFLICT: "Destination metadata differs from the supported contract; review the reported blockers before changing schema.",
		TENANT_PREPARE_JOURNAL_CONFLICT: "Journal belongs to another tenant, target or manifest, or has an unsupported state. No automatic overwrite.",
		TENANT_PREPARE_SCHEMA_DRIFT: "A previously prepared structure has changed. Review it before proceeding; no automatic repair.",
		TENANT_PREPARE_VERIFY_FAILED: "Schema verification failed after DDL. Some changes may already be committed; inspect before resuming.",
	};
	console.error(JSON.stringify({ ...diagnostic, error: code,
		...(error instanceof TenantPrepareError ? { blockers: error.blockers } : {}),
		detail: details[code] ?? "Tenant operation failed at the reported stage; no runtime routing was changed. For prepare, DDL may already have committed: inspect/dry-run before resuming, never assume rollback." }));
	process.exitCode = 1;
});
