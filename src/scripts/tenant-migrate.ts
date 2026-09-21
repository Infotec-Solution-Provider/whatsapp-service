import "dotenv/config";
import { createPool, PoolOptions, RowDataPacket } from "mysql2/promise";
import { acquire, databaseErrorCode, mysqlOptions, sql } from "../database/managed-mysql";
import { inspectTenantDatabase, probeTenantText } from "../tenant-migration/inspect";
import { TextProfile } from "../tenant-migration/encoding";
import { prepareTenant, TenantPrepareError } from "../tenant-migration/prepare";
import { migrateTenantData } from "../tenant-migration/data-migrate";
import { TenantDataError } from "../tenant-migration/data-contract";

// Only fixed labels and boolean presence; never print URLs or driver messages/SQL.
const diagnostic = {
	component: "tenant-migration", diagnosticsVersion: 3, stage: "arguments",
	connectTimeoutMs: 10000,
	queryTimeoutMs: 3000, ddlTimeoutMs: 600000,
	query: "",
	step: "",
	cwd: process.cwd(), module: __filename,
	configuration: {
		tenantDatabaseUrlPresent: Boolean(process.env["TENANT_DATABASE_URL"]),
		instancesDatabaseUrlPresent: Boolean(process.env["INSTANCES_DATABASE_URL"]),
		sourceDatabaseUrlPresent: Boolean(process.env["TENANT_MIGRATION_SOURCE_URL"] || process.env["WHATSAPP_DATABASE_URL"]),
	},
};

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) { console.log(`tenant:migrate --tenant NAME --phase inspect|probe|prepare|copy|verify
  [--text-profile utf8mb4-native-v1|percent-encoded-v1] [--connect-timeout-ms 10000]
prepare requires --text-profile percent-encoded-v1 --expected-hostname HOST --expected-database DB.
prepare defaults to --dry-run (metadata and planned DDL only).
Apply with --apply --writers-quiesced after pausing all writers of destination wpp_* including legacy sync.
  [--ddl-timeout-ms 600000] (1000..3600000, administrative DDL only)
  [--query-timeout-ms 30000] (1000..120000, prepare queries including verification/journal)
Connection/acquisition timeout: 1000..30000 ms. Runtime query deadlines are unchanged.
Uses INSTANCES_DATABASE_URL registry, or TENANT_DATABASE_URL for a directly managed destination.
inspect reads wpp_* metadata visible to the database user. Bootstrap uses utf8 for servers older than 5.5.3.
probe writes synthetic data only to a temporary private table. No silent text-profile fallback.
prepare validates the legacy core schema, widens contacts.name, allows NULL phone, adds nullable domain/epoch-ms fields,
and records resumable DDL in wpp_tenant_prepare. It can block table access on old MySQL; use a maintenance window.
copy defaults to dry-run; source content wins. --apply --writers-quiesced inserts missing rows and audits/reconciles changed destination fields.
verify defaults to persistent checkpoints (business data read-only); use --dry-run for a nonpersistent preview.
copy/verify use TENANT_MIGRATION_SOURCE_URL, falling back to WHATSAPP_DATABASE_URL (source SELECT only).
  --run-id NAME --legacy-timezone auto|UTC|America/Sao_Paulo
  --expected-source-hostname HOST --expected-source-database DB (required for persistent runs)
  --batch-size 100 --max-batches 1000 --max-duration-seconds 300
Queries use --query-timeout-ms 30000. Both phases require the prepared destination identity/profile.
Keep source and target writers paused throughout a run, including between resumptions. Use a NEW run-id after writes resume.
Identity/unique-key collisions still block. Use a new run-id after upgrading from the conflict-only copy contract.
No row deletion, provider send, or runtime cutover is implemented.`); return; }
	let tenant = "", phase = "inspect";
	let profile: TextProfile = "utf8mb4-native-v1";
	let expectedHostname = "", expectedDatabase = "", apply = false, dryRun = false, writersQuiesced = false, ddlTimeoutMs = 600000, queryTimeoutMs = 30000;
	let runId = "preview", legacyTimezone = "auto", expectedSourceHostname = "", expectedSourceDatabase = "", batchSize = 100, maxBatches = 1000, maxDurationSeconds = 300;
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
		else if (args[i] === "--run-id") runId = args[++i] || "";
		else if (args[i] === "--legacy-timezone") legacyTimezone = args[++i] || "";
		else if (args[i] === "--expected-source-hostname") expectedSourceHostname = args[++i] || "";
		else if (args[i] === "--expected-source-database") expectedSourceDatabase = args[++i] || "";
		else if (["--batch-size", "--max-batches", "--max-duration-seconds"].includes(args[i]!)) {
			const flag = args[i], raw = args[++i] || "";
			if (!/^\d+$/.test(raw)) throw new TenantDataError("TENANT_DATA_LIMIT_INVALID");
			if (flag === "--batch-size") batchSize = Number(raw);
			else if (flag === "--max-batches") maxBatches = Number(raw);
			else maxDurationSeconds = Number(raw);
		}
		else if (args[i] === "--ddl-timeout-ms") {
			const raw = args[++i] || "";
			ddlTimeoutMs = Number(raw);
			if (!/^\d+$/.test(raw) || !Number.isSafeInteger(ddlTimeoutMs) || ddlTimeoutMs < 1000 || ddlTimeoutMs > 3600000)
				throw new TenantPrepareError("TENANT_DDL_TIMEOUT_INVALID");
		}
		else if (args[i] === "--query-timeout-ms") {
			const raw = args[++i] || "";
			queryTimeoutMs = Number(raw);
			if (!/^\d+$/.test(raw) || !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1000 || queryTimeoutMs > 120000)
				throw new TenantPrepareError("TENANT_QUERY_TIMEOUT_INVALID");
		}
		else throw new Error("Unknown argument");
	}
	const dataPhase = phase === "copy" || phase === "verify";
	if (!tenant || tenant.length > 191 || !["inspect", "probe", "prepare", "copy", "verify"].includes(phase) || (apply && dryRun)
		|| (phase !== "prepare" && !dataPhase && (apply || dryRun || writersQuiesced || expectedHostname || expectedDatabase || args.includes("--ddl-timeout-ms") || args.includes("--query-timeout-ms")))
		|| (!dataPhase && ["--run-id", "--legacy-timezone", "--expected-source-hostname", "--expected-source-database", "--batch-size", "--max-batches", "--max-duration-seconds"].some(flag => args.includes(flag))))
		throw new TenantPrepareError("TENANT_ARGUMENTS_INVALID");
	if (phase === "verify" && !dryRun) apply = true;
	if (phase === "prepare" || dataPhase) {
		diagnostic.queryTimeoutMs = queryTimeoutMs;
		diagnostic.ddlTimeoutMs = ddlTimeoutMs;
		if (profile !== "percent-encoded-v1") throw new TenantPrepareError("TENANT_PREPARE_PROFILE_UNSUPPORTED");
		if (!expectedHostname || !expectedDatabase) throw new TenantPrepareError("TENANT_PREPARE_IDENTITY_REQUIRED");
		if (apply && !writersQuiesced) throw new TenantPrepareError("TENANT_PREPARE_QUIESCENCE_REQUIRED");
	}
	if (dataPhase && apply && (!args.includes("--run-id") || !expectedSourceHostname || !expectedSourceDatabase)) throw new TenantDataError("TENANT_DATA_CONFIRMATION_REQUIRED");
	if (dataPhase && !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new TenantDataError("TENANT_RUN_ID_INVALID");
	if (dataPhase && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500 || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 10000 || !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 3600)) throw new TenantDataError("TENANT_DATA_LIMIT_INVALID");
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
			const connection = await acquire(registry, diagnostic.connectTimeoutMs, diagnostic.queryTimeoutMs);
			try {
				diagnostic.stage = "registry-lookup";
				const rows = await sql<RowDataPacket[]>(connection, "SELECT host, port, username, password, `database` FROM clients_servers WHERE instance_name = ?", [tenant], diagnostic.queryTimeoutMs);
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
		const connection = await acquire(target, diagnostic.connectTimeoutMs, diagnostic.queryTimeoutMs);
		try {
			if (phase === "copy" || phase === "verify") {
				const rawSource = process.env["TENANT_MIGRATION_SOURCE_URL"] || process.env["WHATSAPP_DATABASE_URL"];
				if (!rawSource) throw new TenantDataError("TENANT_SOURCE_URL_MISSING");
				let sourceUrl: URL;
				try { sourceUrl = new URL(rawSource); } catch { throw new TenantDataError("TENANT_SOURCE_URL_INVALID"); }
				// Prisma's schema query option does not select a MySQL database; the URL path does.
				sourceUrl.searchParams.delete("schema");
				const sourcePool = createPool({ ...mysqlOptions(sourceUrl.toString(), 1), connectTimeout: diagnostic.connectTimeoutMs });
				try {
					diagnostic.stage = "source-connect";
					const source = await acquire(sourcePool, diagnostic.connectTimeoutMs, diagnostic.queryTimeoutMs);
					try {
						const result = await migrateTenantData(source, connection, { tenant, profile, expectedHostname, expectedDatabase, apply, writersQuiesced, ddlTimeoutMs, queryTimeoutMs,
							phase, runId, legacyTimezone, expectedSourceHostname, expectedSourceDatabase, batchSize, maxBatches, maxDurationSeconds,
							progress: (stage, step, query) => {
								diagnostic.stage = stage; diagnostic.step = step ?? ""; diagnostic.query = query ?? "";
								if (stage === "data-page-complete") console.error(JSON.stringify({ component: diagnostic.component, stage, entity: step }));
							},
						});
						console.log(JSON.stringify({ tenant, ...result }, null, 2));
						if (result.status === "CONFLICT") process.exitCode = 2;
					} finally { source.destroy(); }
				} finally { await sourcePool.end(); }
				return;
			}
			if (phase === "prepare") {
				const result = await prepareTenant(connection, {
					tenant, profile, expectedHostname, expectedDatabase, apply, writersQuiesced, ddlTimeoutMs, queryTimeoutMs,
					progress: (stage, step, query) => {
						diagnostic.stage = stage; diagnostic.step = step ?? ""; diagnostic.query = query ?? "";
						if (apply) console.error(JSON.stringify({ component: diagnostic.component, stage, step: diagnostic.step, query: diagnostic.query }));
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
	const code = error instanceof TenantPrepareError || error instanceof TenantDataError ? error.diagnosticCode : databaseErrorCode(error);
	const details: Record<string, string> = {
		TENANT_CONNECTION_CONFIG_MISSING: "Set TENANT_DATABASE_URL for the tenant destination, or INSTANCES_DATABASE_URL for the registry, in the command's effective environment.",
		TENANT_DESTINATION_NOT_FOUND: "No matching tenant was found in the configured registry.",
		TENANT_DESTINATION_AMBIGUOUS: "More than one destination matched the tenant; no destination was selected.",
		TENANT_ARGUMENTS_INVALID: "Use --tenant NAME --phase inspect|probe|prepare|copy|verify; see --help. Do not combine --dry-run with --apply.",
		TENANT_CONNECT_TIMEOUT_INVALID: "Use --connect-timeout-ms with an integer between 1000 and 30000 (default 10000).",
		TENANT_DDL_TIMEOUT_INVALID: "Use --ddl-timeout-ms between 1000 and 3600000 (default 600000).",
		TENANT_QUERY_TIMEOUT_INVALID: "Use --query-timeout-ms between 1000 and 120000 (default 30000, prepare only).",
		TENANT_PREPARE_PROFILE_UNSUPPORTED: "This prepare version requires explicit --text-profile percent-encoded-v1.",
		TENANT_PREPARE_IDENTITY_REQUIRED: "Specify --expected-hostname and --expected-database from the reviewed destination inventory.",
		TENANT_PREPARE_IDENTITY_MISMATCH: "Connected destination differs from the expected identity; no schema change was applied.",
		TENANT_PREPARE_QUIESCENCE_REQUIRED: "Pause destination wpp_* writers including legacy sync, then pass --apply --writers-quiesced in the maintenance window.",
		TENANT_PREPARE_BUSY: "Another prepare owns the destination lock; no schema change was applied by this process.",
		TENANT_PREPARE_SCHEMA_CONFLICT: "Destination metadata differs from the supported contract; review the reported blockers before changing schema.",
		TENANT_PREPARE_JOURNAL_CONFLICT: "Journal belongs to another tenant, target or manifest, or has an unsupported state. No automatic overwrite.",
		TENANT_PREPARE_SCHEMA_DRIFT: "A previously prepared structure has changed. Review it before proceeding; no automatic repair.",
		TENANT_PREPARE_VERIFY_FAILED: "Schema verification failed after DDL. Some changes may already be committed; inspect before resuming.",
		TENANT_DATA_CONFIRMATION_REQUIRED: "Persistent copy/verify requires --run-id, expected source identity and --writers-quiesced for BOTH databases. Run a dry-run first.",
		TENANT_SOURCE_URL_MISSING: "Set TENANT_MIGRATION_SOURCE_URL (prefer a SELECT-only account) or WHATSAPP_DATABASE_URL for the central source.",
		TENANT_DATA_NOT_PREPARED: "Destination must have a matching PREPARED journal and complete core structure.",
		TENANT_LEGACY_TIMEZONE_UNRESOLVED: "No timezone was selected; inspect sample overlap, date scores and database identities. Confirm the legacy writer timezone before using an explicit override.",
		TENANT_COPY_BINDING_CONFLICT: "Run-id belongs to a different source/target/tenant/timezone/contract. Do not overwrite its journal.",
		TENANT_COPY_AUDIT_SCHEMA_CONFLICT: "Destination audit table differs from the required transactional structure. Inspect before resuming; do not discard previous audit records.",
		TENANT_DATA_BUSY: "Prepare/copy/verify is already holding the destination lock. Wait for that operation to finish.",
		TENANT_UNIQUE_KEY_CONFLICT: "Incoming IDs collide with a destination unique key; review the reported IDs/columns. No automatic overwrite.",
		TENANT_DATA_LIMIT_INVALID: "Use batch-size 1..500, max-batches 1..10000 and max-duration-seconds 1..3600.",
		TENANT_ROW_EXCEEDS_PACKET_BUDGET: "An encoded row exceeds the conservative packet budget. No truncation; review its size and the destination configuration.",
		TENANT_ROW_NOT_REPRESENTABLE: "A source field cannot be represented by the prepared target column without loss. Review the reported row/column.",
		TENANT_SOURCE_REFERENCE_CONFLICT: "A referenced source row is missing or belongs to another tenant. No relationship remapping was attempted.",
		ER_DUP_ENTRY: "A destination unique key conflicts with this page. No automatic overwrite; the page transaction is discarded.",
	};
	console.error(JSON.stringify({ ...diagnostic, error: code,
		...(error instanceof TenantPrepareError ? { blockers: error.blockers } : {}),
		...(error instanceof TenantDataError ? { context: error.context } : {}),
		detail: details[code] ?? "Tenant operation failed at the reported stage; no runtime routing was changed. DDL/COMMIT may have completed: inspect the journal before resuming; never assume rollback or replay writes automatically." }));
	process.exitCode = 1;
});
