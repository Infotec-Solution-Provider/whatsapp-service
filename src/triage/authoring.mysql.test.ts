import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import "express-async-errors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import mysql, { type Pool } from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import type { SessionData } from "../sdk-local";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { createTriageRouter } from "../controllers/triage.controller";
import { TriageAuthoring } from "./authoring";
import { type TriageDefinition } from "./engine";
import { TRIAGE_FLAG } from "../parameters/triage-feature";
import { createBotTriggerSettingsRouter } from "../controllers/bot-trigger-settings.controller";
import { TriageTriggers, TriggerError } from "./triggers";
import { exerciseBotTriggers } from "./triggers.mysql-cases";
import positiveResourceId from "../utils/positive-resource-id";

const testUrl = process.env["TRIAGE_API_TEST_MYSQL_URL"];
const tenants = ["alpha", "beta"] as const;
const admin: SessionData = { role: "ADMIN", name: "Ana", instance: "alpha", userId: 1, sectorId: 10 };
const sessions: Record<string, SessionData> = {
	admin,
	supervisor: { ...admin, role: "ATIVO", userId: 2 },
	outsider: { ...admin, instance: "beta", userId: 8 },
	external: { ...admin, role: "EXTERNO", userId: 9 },
	stranger: { ...admin, role: "RECEP", userId: 4 }
};

async function ddl(pool: Pool, sql: string) {
	for (const stmt of sql
		.split(";")
		.map((item) => item.trim())
		.filter(Boolean))
		await pool.query(stmt);
}
async function seed(pool: Pool, prefix: string, owners: readonly string[]) {
	await ddl(
		pool,
		`
		CREATE TABLE ${prefix}clients (id INT PRIMARY KEY, instance VARCHAR(128), name VARCHAR(191), phone VARCHAR(30), is_active BOOLEAN);
		CREATE TABLE ${prefix}sectors (id INT PRIMARY KEY, instance VARCHAR(128),name VARCHAR(191),receive_chats BOOLEAN);
		CREATE TABLE ${prefix}_sector_clients (A INT,B INT,PRIMARY KEY(A,B));
		CREATE TABLE ${prefix}parameters (id INT AUTO_INCREMENT PRIMARY KEY, instance VARCHAR(128),scope VARCHAR(10), \`key\` VARCHAR(128),value VARCHAR(10),userId INT NULL,sectorId INT NULL)`
	);
	for (const instance of owners) {
		const channel = instance === "alpha" ? 1 : 3,
			offset = channel * 10;
		await pool.query(`INSERT INTO ${prefix}clients VALUES (?,?,?,'5511',1)`, [channel, instance, "Principal"]);
		await pool.query(
			`INSERT INTO ${prefix}parameters(instance,scope,\`key\`,value) VALUES (?,'INSTANCE',?,'true')`,
			[instance, TRIAGE_FLAG]
		);
		for (const [index, name] of ["Vendas", "Suporte", "Atendimento", "Arquivado"].entries()) {
			await pool.query(`INSERT INTO ${prefix}sectors VALUES(?,?,?,?)`, [
				offset + index,
				instance,
				name,
				index === 3 ? 0 : 1
			]);
			await pool.query(`INSERT INTO ${prefix}_sector_clients VALUES(?,?)`, [channel, offset + index]);
		}
	}
	if (owners.includes("alpha"))
		await pool.query(`INSERT INTO ${prefix}clients VALUES(2,'alpha','Secundário',NULL,1)`);
	const migration = prefix
		? "prisma/tenant-sql/20261125150000_triage_authoring.sql"
		: "prisma/migrations/20261125150000_triage_authoring/migration.sql";
	await ddl(pool, await readFile(resolve(migration), "utf8"));
	const runtime = prefix
		? "prisma/tenant-sql/20261125151000_triage_runtime.sql"
		: "prisma/migrations/20261125151000_triage_runtime/migration.sql";
	await ddl(pool, await readFile(resolve(runtime), "utf8"));
	const triggers = prefix
		? "prisma/tenant-sql/20261125193000_triage_trigger_sets.sql"
		: "prisma/migrations/20261125193000_triage_trigger_sets/migration.sql";
	await ddl(pool, await readFile(resolve(triggers), "utf8"));
}

async function exercise(
	service: TriageAuthoring,
	triggers: TriageTriggers,
	changeFlag: (on: boolean) => Promise<void>,
	renameTable: (table: "triage_channels" | "triage_versions" | "triage_trigger_sets") => Promise<void>
) {
	const app = express();
	const manualRequestId = "6c90513c-8b4a-47cb-b559-6e4b5a63d036";
	app.use(
		"/rules",
		express.json(),
		(req, res, next) => {
			const user = sessions[String(req.headers.authorization)];
			if (!user) {
				res.sendStatus(401);
				return;
			}
			req.session = user;
			next();
		},
		createBotTriggerSettingsRouter(positiveResourceId, triggers)
	);
	app.use(((error, _req, res, next) => {
		if (error instanceof TriggerError) res.status(error.status).json({ code: error.code, message: error.message });
		else next(error);
	}) as express.ErrorRequestHandler);
	app.use(
		"/api/whatsapp/triage",
		createTriageRouter(
			service,
			(req, res, next) => {
				const session = sessions[String(req.headers.authorization)];
				if (!session) {
					res.sendStatus(401);
					return;
				}
				req.session = session;
				next();
			},
			async () => {
				throw new Error("Activity must not be called without channel access.");
			},
			async () => {
				throw new Error("Takeover must not be called without channel access.");
			},
			async (instance, channelId, chatId, actorId) => {
				assert.deepEqual([instance, channelId, actorId], ["alpha", 1, 2]);
				return chatId === 7 ? { botId: 1, name: "Recepção" } : null;
			},
			async (input) => {
				assert.deepEqual(
					[input.instance, input.channelId, input.actorId, input.eventKey, input.type],
					["alpha", 1, 2, manualRequestId, "manual"]
				);
				assert.ok(input.authorizeTx, "Revalidação da delegação dentro da transação de início");
				return input.chatId === 7 ? { started: true, chat: { id: 7 } } : null;
			}
		)
	);
	app.use(handleRequestError as unknown as express.ErrorRequestHandler);
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/whatsapp/triage";
	async function api(method: string, path: string, body?: unknown, who = "supervisor", status = 200) {
		const response = await fetch(base + path, {
			method,
			headers: { authorization: who, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		const raw = await response.text();
		assert.equal(response.status, status, method + " " + path + " (" + who + ") " + raw.slice(0, 240));
		return raw.startsWith("{") ? JSON.parse(raw).data : null;
	}
	try {
		await api("GET", "/context", undefined, "missing", 401);
		await api("GET", "/context", undefined, "external", 403);
		assert.deepEqual((await api("GET", "/context")).channels, []);
		assert.equal((await api("GET", "/context", undefined, "admin")).channels.length, 2);
		assert.deepEqual(
			(await api("GET", "/context", undefined, "outsider")).channels.map((v: { id: number }) => v.id),
			[3]
		);
		await api("GET", "/channels/3", undefined, "admin", 404);
		await api("GET", "/channels/1", undefined, "supervisor", 403);
		await api("GET", "/channels/1/activity", undefined, "supervisor", 403);
		await api("POST", "/channels/1/chats/7/takeover", {}, "supervisor", 403);
		await api("POST", "/channels/1/chats/7/start", {}, "supervisor", 403);
		await api("GET", "/channels/1/chats/7/start", undefined, "supervisor", 403);
		assert.deepEqual((await api("GET", "/operators?search=Deleg", undefined, "admin")).users, [
			{ id: 2, name: "Delegado" }
		]);
		await api("PUT", "/channels/1/grants/6", { enabled: true }, "admin", 400);
		await api("PUT", "/channels/1/grants/9", { enabled: true }, "admin", 400);
		await api("PUT", "/channels/1/grants/2", { enabled: true }, "admin");
		await api("PUT", "/channels/1/grants/2", { enabled: true }, "admin");
		await api("PUT", "/channels/1/grants/4", { enabled: true }, "supervisor", 403);
		assert.equal((await api("GET", "/channels/1/grants", undefined, "admin")).users.length, 1);
		await api("POST", "/channels/1/chats/7/start", { requestId: "invalid" }, "supervisor", 400);
		assert.deepEqual(await api("GET", "/channels/1/chats/7/start"), {
			available: true,
			botId: 1,
			name: "Recepção"
		});
		assert.deepEqual(await api("GET", "/channels/1/chats/8/start"), { available: false, botId: null, name: null });
		assert.deepEqual(await api("POST", "/channels/1/chats/7/start", { requestId: manualRequestId }), {
			chatId: 7,
			started: true
		});
		await api("POST", "/channels/1/chats/8/start", { requestId: manualRequestId }, "supervisor", 409);
		assert.deepEqual(
			(await api("GET", "/context")).channels.map((v: { id: number }) => v.id),
			[1]
		);
		await api("GET", "/channels/2", undefined, "supervisor", 403);
		const empty = await api("GET", "/channels/1");
		assert.equal(empty.revision, 0);
		assert.equal(empty.activeVersionId, null);
		assert.deepEqual(empty.sectors.map((v: { id: number }) => v.id).sort(), [10, 11, 12]);
		const definition = empty.definition as TriageDefinition;
		for (const malformed of [
			{},
			{ ...definition, nodes: [{ id: "a", title: "bad", type: "code" }] },
			{ ...definition, nodes: [{ ...definition.nodes[0], text: { payload: "bad" } }] },
			{ ...definition, schedule: { timezone: "UTC", days: [null] } }
		]) {
			await api(
				"PUT",
				"/channels/1/draft",
				{ revision: 0, name: "Forma inválida", definition: malformed },
				"supervisor",
				400
			);
		}
		const broken = { ...definition, fallbackSectorId: 30 };
		assert.ok((await api("POST", "/channels/1/validate", { definition: broken })).issues.length);
		await api("PUT", "/channels/1/draft", { revision: 0, name: "Incompleto", definition: broken });
		assert.equal((await api("GET", "/context")).channels[0].hasDraft, true);
		await api("POST", "/channels/1/publish", { revision: 1 }, "supervisor", 400);
		assert.equal((await api("GET", "/channels/1")).versions.length, 0);
		const req = () =>
			fetch(base + "/channels/1/draft", {
				method: "PUT",
				headers: { authorization: "supervisor", "Content-Type": "application/json" },
				body: JSON.stringify({ revision: 1, name: "Recepção", definition })
			});
		const race = await Promise.all([req(), req()]);
		assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
		await Promise.all(race.map((r) => r.text()));
		const simulation = await api("POST", "/channels/1/simulate", {
			definition,
			startTime: "2026-01-05T15:00:00Z",
			events: [
				{ type: "reply", text: "2" },
				{ type: "reply", text: "Preciso de suporte" }
			]
		});
		assert.ok(
			simulation.turns.some((turn: { handoff: { sectorId: number } | null }) => turn.handoff?.sectorId === 11)
		);
		assert.equal((await api("GET", "/channels/1")).revision, 2);
		await api("POST", "/channels/1/simulate", { definition, startTime: "invalid", events: [] }, "supervisor", 400);
		const publish = () =>
			fetch(base + "/channels/1/publish", {
				method: "POST",
				headers: { authorization: "supervisor", "Content-Type": "application/json" },
				body: JSON.stringify({ revision: 2 })
			});
		const publications = await Promise.all([publish(), publish()]);
		assert.deepEqual(publications.map((result) => result.status).sort(), [200, 409]);
		await Promise.all(publications.map((result) => result.text()));
		const v1 = await api("GET", "/channels/1");
		assert.equal(v1.versions.length, 1);
		assert.equal((await api("GET", "/context")).channels[0].hasDraft, false);
		assert.equal(v1.versions[0].createdBy, 2);
		assert.equal(v1.history.filter((e: { action: string }) => e.action === "GRANTED").length, 1);
		assert.equal((await service.activeForChannel("alpha", 1))?.versionId, v1.activeVersionId);
		await exerciseBotTriggers(new URL("/rules", base).toString(), triggers, v1.activeVersionId);
		assert.equal(await service.getRuntimeVersion("beta", v1.activeVersionId), null);
		const updated = structuredClone(definition);
		updated.nodes[0]!.text = "Bem-vindo à nova triagem";
		const draft = await api("PUT", "/channels/1/draft", { revision: 3, name: "Nova", definition: updated });
		assert.deepEqual(draft.activeDefinition, definition);
		await api("POST", "/channels/1/publish", { revision: 3 }, "supervisor", 409);
		const v2 = await api("POST", "/channels/1/publish", { revision: 4 });
		assert.equal(v2.versions.length, 2);
		await api("POST", "/channels/3/rollback", { revision: 0, versionId: v1.activeVersionId }, "outsider", 400);
		const rolled = await api("POST", "/channels/1/rollback", { revision: 5, versionId: v1.activeVersionId });
		assert.deepEqual(rolled.activeDefinition, definition);
		assert.deepEqual(rolled.definition, updated);
		const paused = await api("POST", "/channels/1/pause", { revision: 6 });
		assert.equal(paused.paused, true);
		assert.equal(await service.activeForChannel("alpha", 1), null);
		assert.equal(await triggers.match("alpha", 1, { type: "manual", sectorId: 10 }), null);
		assert.deepEqual((await service.getRuntimeVersion("alpha", v2.activeVersionId))?.definition, updated);
		await api("PUT", "/channels/1/grants/2", { enabled: false }, "admin");
		await api("POST", "/channels/1/rollback", { revision: 7, versionId: v1.activeVersionId }, "supervisor", 403);
		await api("POST", "/channels/1/chats/7/start", {}, "supervisor", 403);
		await changeFlag(false);
		await api("GET", "/context", undefined, "admin", 403);
		assert.equal(await service.activeForChannel("alpha", 1), null);
		assert.deepEqual((await service.getRuntimeVersion("alpha", v1.activeVersionId))?.definition, definition);
		const previous = ["INPULSE_ENVIRONMENT", "TRIAGE_HOMOLOG_ENABLED", "name"].map(
			(key) => [key, process.env[key]] as const
		);
		try {
			Object.assign(process.env, {
				INPULSE_ENVIRONMENT: "homolog",
				TRIAGE_HOMOLOG_ENABLED: "true",
				name: "homolog-whatsapp"
			});
			assert.equal((await api("GET", "/context", undefined, "admin")).channels.length, 2);
			await api("POST", "/channels/1/rollback", { revision: 7, versionId: v1.activeVersionId }, "admin");
			assert.equal((await service.activeForChannel("alpha", 1))?.versionId, v1.activeVersionId);
			await api("GET", "/channels/1", undefined, "supervisor", 403);
			await renameTable("triage_trigger_sets");
			assert.equal(await triggers.match("alpha", 1, { type: "keyword", text: "vendas" }), null);
			await assert.rejects(
				triggers.settings(admin, 10),
				(err: unknown) => err instanceof TriggerError && err.status === 503
			);
			await renameTable("triage_versions");
			await api("GET", "/context", undefined, "admin", 503);
			assert.equal(
				await service.activeForChannel("alpha", 2),
				null,
				"unlinked channel must ignore missing versions"
			);
			await assert.rejects(
				service.activeForChannel("alpha", 1),
				"published channel must not fall through to legacy"
			);
			await assert.rejects(service.getRuntimeVersion("alpha", v1.activeVersionId));
			await renameTable("triage_channels");
			assert.equal(
				await service.activeForChannel("alpha", 2),
				null,
				"new chats keep the legacy path while tables are absent"
			);
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	} finally {
		await new Promise<void>((resolveClose, reject) => server.close((err) => (err ? reject(err) : resolveClose())));
	}
}

test(
	"HTTP de triagem, isolamento, publicação e conflitos em MySQL central e tenant-sql",
	{ skip: !testUrl },
	async () => {
		const url = new URL(testUrl!);
		if (url.hostname !== "127.0.0.1" || url.protocol !== "mysql:")
			throw new Error("Use uma instância MySQL local descartável.");
		const config = {
			host: url.hostname,
			port: Number(url.port),
			user: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
			timezone: "Z"
		};
		const root = mysql.createPool({ ...config, connectionLimit: 1 });
		const databases: string[] = [],
			pools: Pool[] = [];
		let prisma: PrismaClient | undefined;
		const testId = randomBytes(5).toString("hex");
		async function allocate(suffix: string) {
			const db = "triage_api_" + testId + "_" + suffix;
			if (!/^triage_api_[a-f0-9]{10}_(central|alpha|beta)$/.test(db)) throw new Error("Nome de base inválido.");
			await root.query("CREATE DATABASE \`" + db + "\` CHARACTER SET utf8mb4");
			databases.push(db);
			const pool = mysql.createPool({ ...config, database: db, connectionLimit: 5 });
			pools.push(pool);
			return { db, pool };
		}
		try {
			const central = await allocate("central");
			await seed(central.pool, "", tenants);
			const shards: Map<string, Pool> = new Map();
			for (const tenant of tenants) {
				const shard = await allocate(tenant);
				shards.set(tenant, shard.pool);
				await seed(shard.pool, "wpp_runtime_", [tenant]);
				await ddl(
					shard.pool,
					"CREATE TABLE operadores(CODIGO INT PRIMARY KEY,NOME VARCHAR(191),ATIVO VARCHAR(4),NIVEL VARCHAR(16))"
				);
				await shard.pool.query(
					"INSERT INTO operadores VALUES(2,'Delegado','SIM','ATIVO'),(6,'Inativo','NAO','ATIVO'),(9,'Externo','SIM','EXTERNO')"
				);
			}
			const crm = {
				executeQuery: async <T>(instance: string, sql: string, params: unknown[]) =>
					(await shards.get(instance)!.query(sql, params))[0] as T
			};
			url.pathname = "/" + central.db;
			prisma = new PrismaClient({ datasourceUrl: url.toString() });
			const native = createTenantSqlRouter(shards);
			await exercise(
				new TriageAuthoring(prisma, crm),
				new TriageTriggers(prisma),
				async (on) => {
					await central.pool.query("UPDATE parameters SET value=? WHERE instance='alpha'", [String(on)]);
				},
				async (table) => {
					await central.pool.query("RENAME TABLE " + table + " TO missing_" + table);
				}
			);
			await exercise(
				new TriageAuthoring(native as unknown as PrismaClient, crm),
				new TriageTriggers(native as unknown as PrismaClient),
				async (on) => {
					await shards
						.get("alpha")!
						.query("UPDATE wpp_runtime_parameters SET value=? WHERE instance='alpha'", [String(on)]);
				},
				async (table) => {
					await shards.get("alpha")!.query("RENAME TABLE wpp_runtime_" + table + " TO missing_" + table);
				}
			);
		} finally {
			await prisma?.$disconnect();
			await Promise.all(pools.map((p) => p.end()));
			for (const db of databases) await root.query("DROP DATABASE \`" + db + "\`");
			await root.end();
		}
	}
);
