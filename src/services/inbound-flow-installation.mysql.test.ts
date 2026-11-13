import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createConnection } from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildOdimInboundFlow } from "../message-flow/configurations/odim-inbound";
import { installAbsentInboundFlow, removeUnchangedInstalledFlow } from "./inbound-flow-installation";

async function main() {
	// Fixed loopback port and generated QA schema; application connection settings are never read.
	const schema = `odim_flow_install_qa_${randomBytes(5).toString("hex")}`;
	assert.match(schema, /^odim_flow_install_qa_[a-f0-9]+$/);
	const connection = await createConnection({ host: "127.0.0.1", port: 13418, user: "root", password: "" });
	let db: PrismaClient | undefined;
	let temporary: string | undefined;
	try {
		await connection.query(`CREATE DATABASE ${schema}`); await connection.query(`USE ${schema}`);
		for (const sql of [
			"CREATE TABLE sectors(id INT PRIMARY KEY,instance VARCHAR(191))",
			"CREATE TABLE clients(id INT PRIMARY KEY,instance VARCHAR(191),is_active TINYINT NOT NULL)",
			"CREATE TABLE _sector_clients(A INT NOT NULL,B INT NOT NULL,UNIQUE(A,B))",
			"CREATE TABLE message_flows(id INT PRIMARY KEY AUTO_INCREMENT,instance VARCHAR(191),sector_id INT,description VARCHAR(191),created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,UNIQUE(instance,sector_id))",
			"CREATE TABLE message_flows_steps(id INT PRIMARY KEY AUTO_INCREMENT,type VARCHAR(40),message_flow_id INT NOT NULL,step_number INT,next_step_id INT,fallback_step_id INT,config JSON,connections JSON,enabled TINYINT,description VARCHAR(191),created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,UNIQUE(message_flow_id,step_number),FOREIGN KEY(message_flow_id) REFERENCES message_flows(id))",
			"INSERT INTO sectors VALUES(138,'odim'),(139,'other')",
			"INSERT INTO clients VALUES(13,'odim',1),(14,'other',1)",
			"INSERT INTO _sector_clients VALUES(13,138),(14,139)"
		]) await connection.query(sql);
		db = new PrismaClient({ datasources: { db: { url: `mysql://root@127.0.0.1:13418/${schema}` } } });
		const config = buildOdimInboundFlow({ instance: "odim", sectorId: 138, clientId: 13, assigneeId: 510, fallbackUserId: 9 });
		const evidence = { instance: "odim", sectorId: 138, clientId: 13, clientActive: true, clientSectorIds: [138], operators: [
			{ id: 510, active: true, sectorId: 138, role: "AMBOS", accessibleToSupervision: true },
			{ id: 9, active: true, sectorId: 138, role: "ADMIN", accessibleToSupervision: true }
		] };
		await assert.rejects(installAbsentInboundFlow(db, { ...config, clientId: 14 }, { ...evidence, clientId: 14 }), /CHANNEL_SCOPE_CHANGED/);
		const changedTarget = structuredClone(config);
		const changedAssign = changedTarget.steps.find(step => step.stepNumber === 10)!;
		changedAssign.config = { ...(changedAssign.config as Record<string, unknown>), userId: 529 };
		await assert.rejects(installAbsentInboundFlow(db, changedTarget, evidence), /STEPS_DIFFER_FROM_REVIEWED_TARGETS/);
		await assert.rejects(installAbsentInboundFlow(db, config, evidence, async receipt => {
			assert(receipt.flowId > 0); assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/); throw Error("RECEIPT_WRITE_FAILED");
		}), /RECEIPT_WRITE_FAILED/);
		assert.equal(await db.wppMessageFlow.count(), 0); assert.equal(await db.wppMessageFlowStep.count(), 0);
		const receipt = await installAbsentInboundFlow(db, config, evidence);
		assert.equal(await db.wppMessageFlow.count(), 1); assert.equal(await db.wppMessageFlowStep.count(), 9);
		await assert.rejects(installAbsentInboundFlow(db, config, evidence), /ALREADY_EXISTS/);
		const route = await db.wppMessageFlowStep.findFirstOrThrow({ where: { messageFlowId: receipt.flowId, stepNumber: 3 } });
		assert.deepEqual(route.connections, config.steps.find(step => step.stepNumber === 3)!.connections);
		await db.wppMessageFlowStep.update({ where: { id: route.id }, data: { config: { field: "other" } } });
		await assert.rejects(removeUnchangedInstalledFlow(db, receipt), /CHANGED_SINCE_INSTALL/);
		assert.equal(await db.wppMessageFlow.count(), 1);
		await db.wppMessageFlowStep.update({ where: { id: route.id }, data: { config: route.config! } });
		await removeUnchangedInstalledFlow(db, receipt);
		assert.equal(await db.wppMessageFlow.count(), 0); assert.equal(await db.wppMessageFlowStep.count(), 0);
		// Simulate a failure halfway through the nested insert: the parent must roll back too.
		const faulty = { $transaction: (run: (tx: any) => Promise<unknown>) => db!.$transaction(async tx => run({ ...tx,
			wppMessageFlow: { ...tx.wppMessageFlow, create: async (query: any) => { await tx.wppMessageFlow.create(query); throw Error("SIMULATED_INSTALL_FAILURE"); } }
		})) };
		await assert.rejects(installAbsentInboundFlow(faulty, config, evidence), /SIMULATED_INSTALL_FAILURE/);
		assert.equal(await db.wppMessageFlow.count(), 0); assert.equal(await db.wppMessageFlowStep.count(), 0);
		// Exercise the actual operator CLI, including prepared-wrapper compatibility and database-bound receipts.
		temporary = await mkdtemp(join(tmpdir(), "odim-flow-install-qa-"));
		const configPath = join(temporary, "config.json"), evidencePath = join(temporary, "evidence.json"), receiptPath = join(temporary, "receipt.json");
		const bytes = JSON.stringify({ mode: "prepare-only", configuration: config });
		await writeFile(configPath, bytes); await writeFile(evidencePath, JSON.stringify(evidence));
		const [identities] = await connection.query("SELECT @@server_uuid AS uuid");
		const uuid = (identities as Array<{ uuid: string }>)[0]!.uuid;
		const cli = (mode: string, additional: string[] = []) => spawnSync(process.execPath, ["-r", "ts-node/register", "src/scripts/install-inbound-message-flow.ts", mode,
			"--database", schema, "--server-uuid", uuid, "--config", configPath, "--evidence", evidencePath, ...additional], {
			encoding: "utf8", windowsHide: true, env: { ...process.env, WHATSAPP_DATABASE_URL: `mysql://root@127.0.0.1:13418/${schema}` }
		});
		const check = cli("check"); assert.equal(check.status, 0, check.stderr); assert.equal(JSON.parse(check.stdout).writes, 0);
		assert.equal(await db.wppMessageFlow.count(), 0);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const invalid = cli("apply", ["--sha256", "invalid", "--receipt", receiptPath]); assert.notEqual(invalid.status, 0);
		const apply = cli("apply", ["--sha256", hash, "--receipt", receiptPath]); assert.equal(apply.status, 0, apply.stderr);
		const envelope = JSON.parse(await readFile(receiptPath, "utf8")); assert.equal(envelope.database, schema); assert.equal(envelope.serverUuid, uuid);
		await writeFile(receiptPath, JSON.stringify({ ...envelope, database: "other" }));
		const wrong = cli("rollback", ["--receipt", receiptPath]); assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /RECEIPT_DATABASE_MISMATCH/);
		assert.equal(await db.wppMessageFlow.count(), 1);
		await writeFile(receiptPath, JSON.stringify(envelope));
		const rollback = cli("rollback", ["--receipt", receiptPath]); assert.equal(rollback.status, 0, rollback.stderr);
		assert.equal(await db.wppMessageFlow.count(), 0);
		console.log("inbound-flow-installation mysql: PASS atomic install, channel scope, existing-flow refusal, guarded rollback and failed-transaction rollback");
	} finally {
		await db?.$disconnect(); await connection.query(`DROP DATABASE ${schema}`); await connection.end();
		if (temporary) { for (const name of ["config.json", "evidence.json", "receipt.json"]) await unlink(join(temporary, name)).catch(() => undefined); await rmdir(temporary); }
	}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
