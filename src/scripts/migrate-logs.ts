import "dotenv/config";
import { acquire, createManagedPool, databaseErrorCode, sql } from "../database/managed-mysql";
import { assertSeparateDatabases, copyLogStore, CopyOptions, lockLogStore, prepareLogStore, rollbackLogStore, verifyLogStore } from "../logs/migrate";
import { cleanProcessLogs } from "../logs/cleanup";
import { readLogsConfig } from "../logs/config";

export function parseLogsMigrationArgs(args: string[]) {
	let phase = "inspect", quiesced = false, allQuiesced = false;
	const limits: CopyOptions = { batchSize: 100, maxBatches: 1000, maxBytes: 4 * 1024 * 1024, full: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--phase") phase = args[++i] || "";
		else if (arg === "--source-quiesced") quiesced = true;
		else if (arg === "--writers-quiesced") allQuiesced = true;
		else if (arg === "--full") limits.full = true;
		else if (["--batch-size", "--max-batches", "--max-bytes"].includes(arg || "")) {
			const raw = args[++i] || "";
			if (!/^\d+$/.test(raw)) throw new Error("Invalid migration limit");
			if (arg === "--batch-size") limits.batchSize = Number(raw);
			if (arg === "--max-batches") limits.maxBatches = Number(raw);
			if (arg === "--max-bytes") limits.maxBytes = Number(raw);
		} else throw new Error("Unknown logs migration argument");
	}
	if (!["inspect", "prepare", "copy", "verify", "activate", "rollback", "cleanup-preview"].includes(phase)) throw new Error("Unknown logs migration phase");
	if (["verify", "activate"].includes(phase) && !quiesced) throw new Error("Stop and drain ALL source log writers, then use --source-quiesced");
	if (phase === "rollback" && !allQuiesced) throw new Error("Stop and drain BOTH source and dedicated writers, then use --writers-quiesced");
	return { phase, quiesced, limits };
}

async function main() {
	if (process.argv.includes("--help")) {
		console.log("logs:migrate --phase inspect|prepare|copy|verify|activate|rollback|cleanup-preview [--full] [--source-quiesced] [--writers-quiesced] [--batch-size 100] [--max-batches 1000] [--max-bytes 4194304]\nUses WHATSAPP_DATABASE_URL and LOGS_DATABASE_URL; never deletes source rows. verify/activate require all source writers stopped. rollback requires BOTH writers stopped. Flags are operator attestations, not automatic process fencing. No live cutover is performed."); return;
	}
	const options = parseLogsMigrationArgs(process.argv.slice(2));
	if (!process.env["WHATSAPP_DATABASE_URL"] || !process.env["LOGS_DATABASE_URL"]) throw new Error("Database configuration required");
	const sourcePool = createManagedPool(process.env["WHATSAPP_DATABASE_URL"], 1);
	const targetPool = createManagedPool(process.env["LOGS_DATABASE_URL"], 1);
	try {
		const source = await acquire(sourcePool), target = await acquire(targetPool);
		try {
			const identity = await assertSeparateDatabases(source, target);
			if (options.phase === "inspect") { console.log(JSON.stringify(identity)); return; }
			if (options.phase === "cleanup-preview") {
				target.release();
				const config = readLogsConfig({ ...process.env, PROCESS_LOG_STORAGE: "dedicated" });
				console.log(JSON.stringify(await cleanProcessLogs(targetPool, config, { dryRun: true }))); return;
			}
			await lockLogStore(target);
			if (options.phase === "prepare") { await prepareLogStore(source, target); console.log('{"prepared":true}'); }
			if (options.phase === "copy") console.log(JSON.stringify(await copyLogStore(source, target, options.limits)));
			if (options.phase === "rollback") console.log(JSON.stringify(await rollbackLogStore(source, target, options.limits)));
			if (["verify", "activate"].includes(options.phase)) {
				console.log(JSON.stringify(await verifyLogStore(source, target, options.limits)));
				if (options.phase === "activate") {
					await sql(target, "UPDATE process_log_store SET state = 'ACTIVE' WHERE id = 1 AND state = 'COPYING'");
					console.log('{"activated":true,"next":"Start application with PROCESS_LOG_STORAGE=dedicated; keep all legacy writers stopped"}');
				}
			}
		} finally { source.destroy(); target.destroy(); }
	} finally { await sourcePool.end(); await targetPool.end(); }
}

if (require.main === module) void main().catch(error => {
	// Only controlled validation messages; never print driver SQL/stack/config.
	console.error(JSON.stringify({ error: databaseErrorCode(error), detail: error instanceof Error && !((error as { code?: unknown }).code) ? error.message.replace(/mysql:\/\/\S+/g, "[REDACTED]").slice(0, 180) : "Migration failed; credentials and SQL omitted" }));
	process.exitCode = 1;
});
