import { readFile, stat, writeFile, rename, chmod } from "node:fs/promises";
import { createConnection, Connection } from "mysql2/promise";
import {
	applyNativeTenantMigration, confirmHomologCatalog, HOMOLOG_TENANTS, NativeMigrationError,
	NativeMigrationPlan, planNativeTenantMigration, SOURCE_DATABASE, TABLE_PREFIX, TableVerification, TenantMigrationIdentity
} from "../tenant-sql/migration";

const CREDENTIAL_FILE = "/home/inpulse/htdocs/homolog/.db-password";
const REGISTRY_FILE = "/home/inpulse/htdocs/homolog/whatsapp/tenant-sql-registry.json";
type RegistryTenant = {
	instance: string; database: string; slot: number; autoIncrementOffset: number; idFloor: number;
	prepared: boolean; verifiedAt: string; tables: Record<string, TableVerification>;
	omittedForeignKeys: { table: string; constraint: string; referencedTable: string; invalidRows: number; reason: string }[];
};
type Registry = {
	version: 1; runtimeVersion: 1; host: "127.0.0.1"; port: 3306; user: "homolog";
	credentialFile: string; sourceDatabase: string; tablePrefix: string; autoIncrementIncrement: 2; tenants: RegistryTenant[];
};

function parseArguments(args: string[]): { apply: boolean; batchSize: number; tenants: readonly TenantMigrationIdentity[] } {
	let apply = false, dryRun = false, writersQuiesced = false, tenant = "", database = "", batchSize = 500;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--apply") apply = true;
		else if (argument === "--dry-run") dryRun = true;
		else if (argument === "--writers-quiesced") writersQuiesced = true;
		else if (argument === "--tenant") tenant = args[++index] || "";
		else if (argument === "--database") database = args[++index] || "";
		else if (argument === "--batch-size") {
			const raw = args[++index] || "";
			batchSize = Number(raw);
			if (!/^\d+$/.test(raw) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new NativeMigrationError("INVALID_BATCH_SIZE");
		} else throw new NativeMigrationError("INVALID_ARGUMENT");
	}
	if (apply && dryRun) throw new NativeMigrationError("CONFLICTING_MODE");
	if (apply && !writersQuiesced) throw new NativeMigrationError("WRITERS_QUIESCENCE_REQUIRED");
	if (Boolean(tenant) !== Boolean(database)) throw new NativeMigrationError("TENANT_DATABASE_PAIR_REQUIRED");
	const tenants = tenant ? HOMOLOG_TENANTS.filter(identity => identity.instance === tenant && identity.database === database) : HOMOLOG_TENANTS;
	if (!tenants.length) throw new NativeMigrationError("HOMOLOG_IDENTITY_REQUIRED");
	return { apply, batchSize, tenants };
}

async function readRegistry(): Promise<Registry> {
	const fresh: Registry = {
		version: 1, runtimeVersion: 1, host: "127.0.0.1", port: 3306, user: "homolog",
		credentialFile: CREDENTIAL_FILE, sourceDatabase: SOURCE_DATABASE, tablePrefix: TABLE_PREFIX, autoIncrementIncrement: 2, tenants: []
	};
	try {
		const previous: unknown = JSON.parse(await readFile(REGISTRY_FILE, "utf8"));
		if (typeof previous !== "object" || !previous) throw new NativeMigrationError("REGISTRY_FORMAT_INVALID");
		const candidate = previous as Registry;
		if (candidate.version !== 1 || candidate.runtimeVersion !== 1 || candidate.host !== fresh.host || candidate.port !== fresh.port || candidate.user !== fresh.user || candidate.credentialFile !== CREDENTIAL_FILE || candidate.sourceDatabase !== SOURCE_DATABASE || candidate.tablePrefix !== TABLE_PREFIX || candidate.autoIncrementIncrement !== 2 || !Array.isArray(candidate.tenants)) throw new NativeMigrationError("REGISTRY_IDENTITY_MISMATCH");
		for (const tenant of candidate.tenants)
			if (!HOMOLOG_TENANTS.some(identity => identity.instance === tenant.instance && identity.database === tenant.database && identity.slot === tenant.slot && identity.autoIncrementOffset === tenant.autoIncrementOffset)) throw new NativeMigrationError("REGISTRY_TENANT_INVALID");
		return candidate;
	} catch (error) {
		if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return fresh;
		throw error;
	}
}

async function saveRegistry(registry: Registry): Promise<void> {
	const temporary = `${REGISTRY_FILE}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await chmod(temporary, 0o600);
	await rename(temporary, REGISTRY_FILE);
	await chmod(REGISTRY_FILE, 0o600);
}

function printPlan(plan: NativeMigrationPlan, apply: boolean): void {
	console.log(JSON.stringify({
		component: "tenant-sql-homolog", mode: apply ? "apply" : "dry-run", tenant: plan.tenant.instance,
		sourceDatabase: SOURCE_DATABASE, database: plan.tenant.database, idFloor: plan.idFloor,
		autoIncrementIncrement: 2, autoIncrementOffset: plan.tenant.autoIncrementOffset,
		legacySectorParameters: plan.sharedParameters, excludedUnownedParameters: plan.unownedParameters,
		tables: plan.tables.map(table => ({ model: table.model, source: table.source, destination: table.destination, count: table.count, checksum: table.checksum, omittedForeignKeys: table.omittedForeignKeys }))
	}));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log("tenant-sql-homolog [--dry-run] [--tenant homolog --database homolog-crm | --tenant suprimaxxi --database homolog-crm-suprimaxxi] [--batch-size 500]\nApply requires --apply --writers-quiesced. Only homolog databases on 127.0.0.1:3306 are allowed.\nSource homolog-whatsapp is read-only; active tables and implicit joins are cloned into wpp_runtime_* native tables.\nHistorical orphan foreign keys are reported and omitted from the new tables. Existing legacy wpp_* tables are untouched.\nResumptions require unchanged source checksums and compare each existing row before inserting only missing rows.\nCredentials are read privately from the fixed homolog server file; the mode-600 registry is published after verification.\nKeep source and destination writers stopped throughout planning, copying, and verification.");
		return;
	}
	const options = parseArguments(args);
	if (process.platform !== "linux") throw new NativeMigrationError("HOMOLOG_SERVER_ONLY");
	const credentialMetadata = await stat(CREDENTIAL_FILE);
	if (!credentialMetadata.isFile() || (credentialMetadata.mode & 0o077) !== 0) throw new NativeMigrationError("CREDENTIAL_FILE_PERMISSIONS_INVALID");
	const password = (await readFile(CREDENTIAL_FILE, "utf8")).replace(/\r?\n$/, "");
	if (!password || password.includes("\n") || password.includes("\r")) throw new NativeMigrationError("CREDENTIAL_FILE_FORMAT_INVALID");
	let source: Connection | null = null;
	let target: Connection | null = null;
	try {
		const connectionOptions = {
			host: "127.0.0.1", port: 3306, user: "homolog", password, database: SOURCE_DATABASE,
			charset: "utf8mb4", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true,
			timezone: "Z", connectTimeout: 10_000, multipleStatements: false
		} as const;
		source = await createConnection(connectionOptions);
		await source.query("SET SESSION time_zone = '+00:00'");
		await source.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
		await source.query("START TRANSACTION READ ONLY");
		await confirmHomologCatalog(source, options.tenants);
		const plans: NativeMigrationPlan[] = [];
		for (const tenant of options.tenants) {
			const plan = await planNativeTenantMigration(source, tenant, options.batchSize);
			plans.push(plan);
			printPlan(plan, options.apply);
		}
		if (!options.apply) return;
		const registry = await readRegistry();
		target = await createConnection(connectionOptions);
		await target.query("SET SESSION time_zone = '+00:00'");
		for (const plan of plans) {
			const verified = await applyNativeTenantMigration(source, target, plan, options.batchSize, (table, copied, total) => {
				if (copied === total || copied % 5000 === 0) console.log(JSON.stringify({ component: "tenant-sql-homolog", stage: "copy", tenant: plan.tenant.instance, table, copied, total }));
			});
			const entry: RegistryTenant = {
				...plan.tenant, idFloor: plan.idFloor, prepared: true, verifiedAt: new Date().toISOString(), tables: verified,
				omittedForeignKeys: plan.tables.flatMap(table => table.omittedForeignKeys.map(constraint => ({ table: table.source, ...constraint })))
			};
			registry.tenants = registry.tenants.filter(tenant => tenant.instance !== entry.instance).concat(entry).sort((a, b) => a.slot - b.slot);
		}
		await saveRegistry(registry);
		console.log(JSON.stringify({ component: "tenant-sql-homolog", stage: "verified", registry: REGISTRY_FILE, tenants: plans.map(plan => plan.tenant.instance), prepared: true }));
	} finally {
		if (source) { await source.rollback().catch(() => undefined); await source.end(); }
		if (target) await target.end();
	}
}

main().catch(error => {
	const code = error instanceof NativeMigrationError ? error.code : typeof error === "object" && error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "MIGRATION_FAILED";
	console.error(JSON.stringify({ component: "tenant-sql-homolog", code, table: error instanceof NativeMigrationError ? error.table : "" }));
	process.exitCode = 1;
});
