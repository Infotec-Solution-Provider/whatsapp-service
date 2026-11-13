import { open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertInboundFlowPreflight, type InboundFlowConfiguration, type FlowDeploymentPreflight } from "../message-flow/configurations/odim-inbound";
import { assertFlowDefinition } from "../message-flow/flow-definition";
import { assertInboundFlowCentralScope, assertPreparedInboundConfiguration, installAbsentInboundFlow, removeUnchangedInstalledFlow, type InstalledFlowReceipt } from "../services/inbound-flow-installation";

/** Explicit operator command. No dotenv, hidden connection fallback, schema creation or process restart. */
async function main() {
	const args = process.argv.slice(2), mode = args.shift();
	if (!["check", "apply", "rollback"].includes(mode ?? "")) throw Error("Usage: install-inbound-message-flow check|apply|rollback --config file --evidence file --database name --server-uuid uuid [--sha256 hash --receipt file]");
	const options = new Map<string, string>();
	while (args.length) { const flag = args.shift(), value = args.shift(); if (!flag?.startsWith("--") || !value || options.has(flag)) throw Error("INVALID_ARGUMENTS"); options.set(flag, value); }
	for (const flag of options.keys()) if (!["--config", "--evidence", "--database", "--server-uuid", "--sha256", "--receipt"].includes(flag)) throw Error("INVALID_ARGUMENTS");
	const required = (flag: string) => { const value = options.get(flag); if (!value) throw Error(`Missing ${flag}`); return value; };
	const database = required("--database"), uuid = required("--server-uuid");
	if (!["inpulse-whatsapp", "homolog-whatsapp"].includes(database) && !/^odim_flow_install_qa_[a-z0-9_]+$/.test(database)) throw Error("DATABASE_NOT_ALLOWED");
	const connection = process.env["WHATSAPP_DATABASE_URL"];
	if (!connection || decodeURIComponent(new URL(connection).pathname.slice(1)) !== database) throw Error("DATABASE_CONNECTION_MISMATCH");
	const db = new PrismaClient({ datasources: { db: { url: connection } } });
	try {
		const [identity] = await db.$queryRawUnsafe<Array<{ db: string; uuid: string }>>("SELECT DATABASE() AS db,@@server_uuid AS uuid");
		if (identity?.db !== database || identity.uuid !== uuid) throw Error("SERVER_IDENTITY_MISMATCH");
		const receiptPath = options.get("--receipt");
		if (mode === "rollback") {
			const receipt = JSON.parse(await readFile(required("--receipt"), "utf8")) as { database: string; serverUuid: string; installation: InstalledFlowReceipt };
			if (receipt.database !== database || receipt.serverUuid !== uuid) throw Error("FLOW_RECEIPT_DATABASE_MISMATCH");
			await removeUnchangedInstalledFlow(db, receipt.installation);
			console.log(JSON.stringify({ status: "ROLLED_BACK_UNCHANGED_FLOW", database, flowId: receipt.installation.flowId, externalProcessReloadRequired: true }));
			return;
		}
		const bytes = await readFile(required("--config"));
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const prepared = JSON.parse(bytes.toString("utf8"));
		const config = (prepared.configuration ?? prepared) as InboundFlowConfiguration;
		const evidence = JSON.parse(await readFile(required("--evidence"), "utf8")) as FlowDeploymentPreflight;
		assertInboundFlowPreflight(config, evidence); assertFlowDefinition(config.steps);
		assertPreparedInboundConfiguration(config);
		await assertInboundFlowCentralScope(db, config);
		const existing = await db.wppMessageFlow.findUnique({ where: { instance_sectorId: { instance: config.instance, sectorId: config.sectorId } }, select: { id: true } });
		if (existing) throw Error("FLOW_ALREADY_EXISTS");
		if (mode === "check") { console.log(JSON.stringify({ status: "CHECKED_ABSENT_FLOW", database, instance: config.instance, sectorId: config.sectorId, steps: config.steps.length, sha256, writes: 0 })); return; }
		if (required("--sha256") !== sha256 || !receiptPath) throw Error("CONFIG_HASH_OR_RECEIPT_REQUIRED");
		// Reserve a new receipt before committing: no existing audit file can be overwritten.
		await writeFile(receiptPath, JSON.stringify({ status: "PREPARED", database, sha256 }) + "\n", { flag: "wx", mode: 0o600 });
		const receipt = await installAbsentInboundFlow(db, config, evidence, async preparedReceipt => {
			const file = await open(receiptPath, "r+");
			try {
				await file.truncate(0);
				await file.writeFile(JSON.stringify({ status: "PREPARED_BEFORE_COMMIT", database, serverUuid: uuid, configSha256: sha256, installation: preparedReceipt }, null, 2) + "\n");
				await file.sync();
			} finally { await file.close(); }
		});
		// The durable full receipt already exists. No fallible filesystem write follows COMMIT.
		console.log(JSON.stringify({ status: "INSTALLED_ATOMICALLY", database, flowId: receipt.flowId, sha256, receiptRecordedBeforeCommit: true, externalProcessReloadRequired: true }));
	} finally { await db.$disconnect(); }
}
if (require.main === module) void main().catch(error => {
	const code = error instanceof Error && /^[A-Z_]{3,70}$/.test(error.message) ? error.message : "INBOUND_FLOW_COMMAND_FAILED";
	console.error(code); process.exitCode = 1;
});
