import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import mysql, { type Connection } from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { buildOdimInboundFlow } from "../message-flow/configurations/odim-inbound";
import type { DatabaseClient } from "./prisma.service";

// Integration fixture uses generated schemas on loopback. It never reads application credentials.
const port = Number(process.env["FLOW_STUDIO_TEST_MYSQL_PORT"] || "13418");
assert(Number.isSafeInteger(port) && port > 1024 && port < 65536);
const connection = { host: "127.0.0.1", port, user: "root", password: "" };
const read = (file: string) => readFileSync(resolve("prisma/migrations", file, "migration.sql"), "utf8");
const original = read("20260129172344_v2026_01_29");
const centralMigration = read("20261125160000_message_flow_studio");
const runtimeMigration = execFileSync(process.execPath, [resolve("scripts/render-tenant-flow-studio.cjs")], { encoding: "utf8" });

require.cache[require.resolve("./prisma.service")] = { exports: { __esModule: true, default: {} } } as NodeModule;
const { registerAllSteps } = require("../message-flow/register-steps") as typeof import("../message-flow/register-steps");
const { MessageFlowStudioService, StudioError } = require("./message-flow-studio.service") as typeof import("./message-flow-studio.service");
registerAllSteps();

async function prepare(db: Connection, schema: string, prefix: string) {
	assert.match(schema, /^flow_studio_qa_[a-f0-9]{12}_(central|a|b)$/);
	await db.query(`CREATE DATABASE \`${schema}\``);
	await db.changeUser({ database: schema });
	for (const table of ["sectors", "wallets", "message_flows", "message_flows_steps"]) {
		const start = original.indexOf("CREATE TABLE `" + table + "` (");
		assert(start >= 0);
		const ddl = original.slice(start, original.indexOf(";", start) + 1);
		await db.query(ddl.replace("CREATE TABLE `" + table + "`", "CREATE TABLE `" + prefix + table + "`"));
	}
	for (const ddl of (prefix ? runtimeMigration : centralMigration).split(";").filter(text => text.trim())) await db.query(ddl);
	const grantBotStep = readFileSync(resolve(prefix ? "prisma/tenant-sql/20261125211000_start_bot_step.sql"
		: "prisma/migrations/20261125211000_start_bot_step/migration.sql"), "utf8");
	for (const ddl of grantBotStep.split(";").filter(text => text.trim())) await db.query(ddl);
}
async function run() {
	const admin = await mysql.createConnection(connection);
	const base = "flow_studio_qa_" + randomBytes(6).toString("hex");
	const schemas: string[] = [];
	for (const native of [false, true]) {
		const prefix = native ? "wpp_runtime_" : "";
		const owners = native ? ["a", "b"] : ["central"];
		let db: DatabaseClient | undefined;
		try {
			for (const owner of owners) {
				const schema = base + "_" + owner;
				await prepare(admin, schema, prefix);
				schemas.push(schema);
				if (owner !== "b") {
					await admin.execute(`INSERT INTO ${prefix}sectors(id,name,instance,start_chats,receive_chats) VALUES(1,'A','a',1,1),(3,'A3','a',1,1)`);
				}
				if (owner !== "a") {
					await admin.execute(`INSERT INTO ${prefix}sectors(id,name,instance,start_chats,receive_chats) VALUES(?,'B','b',1,1)`, [native ? 1 : 2]);
					await admin.execute(`INSERT INTO ${prefix}wallets(id,name,instance) VALUES(90,'B','b')`);
				}
			}
			db = native ? createTenantSqlRouter(new Map(["a", "b"].map(tenant =>
				[tenant, mysql.createPool({ ...connection, database: base + "_" + tenant, connectionLimit: 4, timezone: "Z" })]))) as DatabaseClient :
				new PrismaClient({ datasources: { db: { url: `mysql://root@127.0.0.1:${port}/${base}_central` } } });
			const target = db;
			const a = <T>(fn: () => Promise<T>) => withDatabaseTenant("a", fn);
			const b = <T>(fn: () => Promise<T>) => withDatabaseTenant("b", fn);
			const sectorB = native ? 1 : 2;
			let invalidations = 0;
			const operatorReads: string[] = [];
			const service = new MessageFlowStudioService(target, () => { invalidations++; }, async (instance, ids) => {
				operatorReads.push(instance);
				return ids.filter(id => instance === "a" && [5, 12, 13].includes(id)).map(CODIGO => ({
					CODIGO, SETOR: CODIGO === 5 ? 1 : 3, ATIVO: "SIM", NIVEL: CODIGO === 13 ? "ADMIN" : "OPERADOR"
				}));
			}, async (instance, sector) => instance === "a" && sector === 1 ? [
				{ botId: 9, channelId: 9, name: "Recepção", channelName: "Atendimento", version: 2, versionId: 21 }
			] : []);
			const state = () => a(() => service.list("a", 1));
			const create = (name: string, steps: unknown) => a(() => service.create("a", 1, { name, steps }));
			const activate = (id: number, revision: number, activeFingerprint: string) => a(() => service.activate("a", 1, id, { revision, activeFingerprint }));
			const status = (value: number) => (err: unknown) => err instanceof StudioError && err.status === value;
			const originalState = await state();
			assert.equal(originalState.active.source, "default");
			assert.equal(originalState.active.steps.length, 4);
			assert.equal(originalState.flows.length, 0);
			assert(!originalState.stepTypes.includes("CHECK_CUSTOMER_CAMPAIGN_TYPE"));
			const steps = [{ type: "ASSIGN", stepNumber: 1, config: { userId: 5 } }];
			const first = await create("Triagem", steps);
			const second = await a(() => service.duplicate("a", 1, first.id, { revision: first.revision }));
			assert.notEqual(first.id, second.id);
			assert.equal((await state()).active.fingerprint, originalState.active.fingerprint);
			const cross = await b(() => service.create("b", sectorB, { name: "Setor B", steps }));
			if (native) assert.equal(cross.id, first.id, "the two native runtimes deliberately have overlapping IDs");
			await assert.rejects(b(() => service.update("b", sectorB, second.id, { name: "fora", steps, revision: 1 })), status(404));
			await assert.rejects(a(() => service.update("a", 3, first.id, { name: "fora", steps, revision: 1 })), status(404));
			const invalidDraft = await create("Em edição", []);
			await assert.rejects(activate(invalidDraft.id, 1, originalState.active.fingerprint), status(422));
			for (const config of [{ userId: 999 }, { walletId: 90 }, { userId: 5, validateUser: true, fallbackUserId: 4, fallbackRequireAdmin: true }]) {
				const other = await create("Destino externo", [{ type: "ASSIGN", stepNumber: 1, config }]);
				await assert.rejects(activate(other.id, 1, originalState.active.fingerprint), status(422));
			}
			assert(operatorReads.every(instance => instance === "a"));
			for (const userId of [12, 999]) {
				const outside = await create("Operador fora do setor", [
					{ type: "CHECK_USER_ONLINE", stepNumber: 1, config: { userId }, nextStepId: 2 },
					{ type: "SEND_TO_ADMIN", stepNumber: 2 }
				]);
				await assert.rejects(activate(outside.id, 1, originalState.active.fingerprint), status(422));
			}
			assert.equal(invalidations, 0);
			const concurrent = await Promise.allSettled([first, second].map(flow => activate(flow.id, flow.revision, originalState.active.fingerprint)));
			assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
			assert(concurrent.some(row => row.status === "rejected" && status(409)(row.reason)));
			const activated = await state();
			assert.equal(activated.active.source, "library");
			assert(activated.flows.some(flow => flow.name === "Fluxo padrão"));
			const activeId = activated.active.flowId!;
			const updated = await a(() => service.update("a", 1, activeId, { name: "Novo rascunho", steps, revision: 1 }));
			assert.equal(updated.revision, 2);
			assert.equal((await state()).active.revision, 1);
			assert.equal((await state()).active.fingerprint, activated.active.fingerprint);
			await assert.rejects(a(() => service.update("a", 1, activeId, { name: "Conflito", steps, revision: 1 })), status(409));

			// Emulate technical maintenance in the database after the editor loaded the active definition.
			await admin.changeUser({ database: base + (native ? "_a" : "_central") });
			const sqlConfig = { query: "SELECT NOME FROM clientes WHERE CODIGO=?", params: ["${contact.customerId}"], storeAs: "cliente", single: true };
			await admin.execute(`UPDATE ${prefix}message_flows_steps SET type='QUERY', config=?, next_step_id=2 WHERE step_number=1`, [JSON.stringify(sqlConfig)]);
			await admin.execute(`INSERT INTO ${prefix}message_flows_steps(type,message_flow_id,step_number,updated_at) SELECT 'SEND_TO_ADMIN',id,2,NOW(3) FROM ${prefix}message_flows`);
			await assert.rejects(activate(activeId, 2, activated.active.fingerprint), status(409));
			const drift = await state();
			assert.equal(drift.active.source, "legacy");
			assert.equal(drift.flows.find(flow => flow.id === activeId)!.revision, 2);
			const legacyCopy = await create("Legado preservado", drift.active.steps);
			const altered = structuredClone(drift.active.steps);
			altered[0]!.config = { ...sqlConfig, params: [100] };
			await assert.rejects(create("Parâmetros adulterados", altered), status(422));
			await assert.rejects(b(() => service.create("b", sectorB, { name: "Consulta de A", steps: drift.active.steps })), status(422));
			await assert.rejects(a(() => service.update("a", 1, legacyCopy.id, { name: "SQL alterado", steps: altered, revision: 1 })), status(422));
			assert(!(await a(() => service.validate("a", 1, { steps: altered }))).valid);
			// Fail the final write after the active steps have been replaced; all changes must roll back.
			await admin.query(`CREATE TRIGGER studio_injected_failure BEFORE UPDATE ON ${prefix}message_flow_publications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='QA rollback'`);
			const beforeFailure = invalidations;
			const beforeFailedWrite = await state();
			await assert.rejects(activate(activeId, 2, drift.active.fingerprint));
			assert.deepEqual(await state(), beforeFailedWrite);
			assert.equal(invalidations, beforeFailure);
			await admin.query("DROP TRIGGER studio_injected_failure");
			const recovered = await activate(legacyCopy.id, 1, drift.active.fingerprint);
			assert(recovered.flows.some(flow => flow.name === drift.active.name && flow.steps[0]?.type === "QUERY"));
			assert.equal(recovered.active.flowId, legacyCopy.id);
			assert.deepEqual(recovered.active.steps[0]?.config, sqlConfig);
			const odim = buildOdimInboundFlow({ instance: "a", sectorId: 3, clientId: 1, assigneeId: 12, fallbackUserId: 13 });
			await admin.execute(`INSERT INTO ${prefix}message_flows(instance,sector_id,description,updated_at) VALUES('a',3,?,NOW(3))`, [odim.description]);
			for (const step of odim.steps) {
				await admin.execute(`INSERT INTO ${prefix}message_flows_steps(message_flow_id,type,step_number,next_step_id,fallback_step_id,config,connections,updated_at)
					SELECT id,?,?,?,?,?,?,NOW(3) FROM ${prefix}message_flows WHERE instance='a' AND sector_id=3`,
				[step.type, step.stepNumber, step.nextStepId ?? null, step.fallbackStepId ?? null, JSON.stringify(step.config ?? null), JSON.stringify(step.connections ?? null)]);
			}
			const odimBefore = await a(() => service.list("a", 3));
			assert.deepEqual(odimBefore.active.steps.map(s => s.stepNumber), [1, 2, 3, 4, 5, 6, 10, 11, 12]);
			const odimDraft = await a(() => service.create("a", 3, { name: "Triagem revisada", steps: odimBefore.active.steps }));
			const odimPublished = await a(() => service.activate("a", 3, odimDraft.id, { revision: odimDraft.revision, activeFingerprint: odimBefore.active.fingerprint }));
			assert.deepEqual(odimPublished.active.steps, odimBefore.active.steps);
			assert(odimPublished.flows.some(flow => flow.name === odim.description));
			const botSteps = [{ type: "START_BOT", stepNumber: 1, config: { botId: 9 }, fallbackStepId: 2 },
				{ type: "SEND_TO_ADMIN", stepNumber: 2 }];
			const draftBot = await create("Recepção pelo gestor", botSteps);
			const publishedBot = await activate(draftBot.id, draftBot.revision, recovered.active.fingerprint);
			assert.equal(publishedBot.active.steps[0]?.type, "START_BOT");
			assert.equal((await state()).active.steps[0]?.fallbackStepId, 2);
			const foreign = await b(() => service.create("b", sectorB, { name: "Bot alheio", steps: botSteps }));
			const foreignLibrary = await b(() => service.list("b", sectorB));
			await assert.rejects(b(() => service.activate("b", sectorB, foreign.id,
				{ revision: foreign.revision, activeFingerprint: foreignLibrary.active.fingerprint })), status(422));
			console.log(`Studio integration passed: ${native ? "tenant-sql with overlapping IDs" : "central Prisma"}`);
		} finally {
			await db?.$disconnect();
			for (const schema of schemas.splice(0)) {
				assert.match(schema, /^flow_studio_qa_[a-f0-9]{12}_(central|a|b)$/);
				await admin.query(`DROP DATABASE \`${schema}\``);
			}
		}
	}
	await admin.end();
}
void run().catch(error => { console.error(error); process.exit(1); });
