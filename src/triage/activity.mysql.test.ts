import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createConnection, createPool } from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { getTriageActivity } from "./activity";
import { TRIAGE_CHAT_MARKER } from "./constants";

const reference = new Date("2026-11-25T16:00:00Z");
const earlier = (minutes: number) => new Date(reference.getTime() - minutes * 60_000);

for (const mode of ["central", "tenant"] as const) {
	test(`atividade por canal em MySQL (${mode})`, async () => {
		const schema = `triage_activity_${mode}_${randomBytes(5).toString("hex")}`;
		const host = "127.0.0.1", port = Number(process.env["TRIAGE_TEST_MYSQL_PORT"] ?? 56829), user = "root";
		const password = process.env["TRIAGE_TEST_MYSQL_PASSWORD"] ?? "";
		const prefix = mode === "central" ? "" : "wpp_runtime_";
		const connection = await createConnection({ host, port, user, password, timezone: "Z", multipleStatements: true });
		const pool = createPool({ host, port, user, password, database: schema, timezone: "Z" });
		const prisma = new PrismaClient({datasourceUrl: `mysql://root:${encodeURIComponent(password)}@${host}:${port}/${schema}`});
		try {
			await connection.query(`CREATE DATABASE ${schema}`);
			await connection.query(`USE ${schema}`);
			const migration = mode === "central" ? "prisma/migrations/20261125151000_triage_runtime/migration.sql" :
				"prisma/tenant-sql/20261125151000_triage_runtime.sql";
			await connection.query(await readFile(migration, "utf8"));
			await connection.query(`CREATE TABLE ${prefix}sectors (id INT PRIMARY KEY, instance VARCHAR(191), name VARCHAR(255));
				CREATE TABLE ${prefix}chats (id INT PRIMARY KEY, instance VARCHAR(191), is_finished INT, bot_id INT);
				INSERT INTO ${prefix}sectors VALUES (11,'empresa','Vendas'),(12,'empresa','Suporte'),(13,'outra','Setor privativo')`);
			const db = mode === "central" ? prisma :
				createTenantSqlRouter(new Map([["empresa", pool]])) as Parameters<typeof getTriageActivity>[2];
			const activity = () => getTriageActivity("empresa", 1, db, reference);
			const empty = await activity();
			assert.deepEqual(empty, {started: 0, handedOff: 0, averageSeconds: null, failed: 0, pendingIntervention: 0, byReason: [], bySector: [], chats: []});

			async function session(id: number, status: string, age: number, channel = 1, instance = "empresa", closed = 0) {
				await connection.execute(`INSERT INTO ${prefix}chats VALUES(?,?,?,?)`, [id, instance, closed, TRIAGE_CHAT_MARKER]);
				await connection.execute(`INSERT INTO ${prefix}triage_sessions
					(chat_id,instance,channel_id,contact_id,bot_id,version_id,definition,state,status,last_message_id,created_at,updated_at)
					VALUES(?,?,?,1,1,1,'{}','{}',?,1,?,?)`, [id, instance, channel, status, earlier(age), earlier(age)]);
			}
			let event = 0;
			async function effect(chat: number, status: string, reason: string, sectorId: number, age: number, kind = "handoff", instance = "empresa") {
				await connection.execute(`INSERT INTO ${prefix}triage_effects
					(instance,chat_id,event_id,position,kind,payload,status,updated_at) VALUES(?,?,?,0,?,?,?,?)`,
					[instance, chat, ++event, kind, JSON.stringify({sectorId, reason}), status, earlier(age)]);
			}
			await session(1, "waiting", 10);
			await session(2, "handed_off", 60);
			await effect(2, "done", "configured", 11, 20);
			await effect(2, "done", "requested", 13, 10, "handoff", "outra"); // same chat id, different tenant
			await session(3, "handed_off", 1500);
			await effect(3, "done", "timeout", 12, 1380); // started yesterday, completed within window
			await session(4, "handoff", 3000);
			await effect(4, "failed", "unavailable", 13, 2000); // still blocked, outside 24h
			await session(5, "taken", 360);
			await effect(5, "unknown", "delivery", 13, 60, "message");
			await effect(5, "failed", "delivery", 13, 61);
			await session(6, "handoff", 60);
			await effect(6, "failed", "configured", 11, 30);
			await effect(6, "pending", "unavailable", 12, 29); // automatic fallback still queued
			await session(7, "handed_off", 3000);
			await effect(7, "done", "configured", 11, 2500);
			await session(8, "handed_off", 50, 2);
			await effect(8, "done", "configured", 11, 49); // different channel
			await session(9, "handoff", 3000, 1, "empresa", 1);
			await effect(9, "failed", "delivery", 12, 2000); // cannot take over a closed chat
			await session(10, "handed_off", 30, 1, "outra");
			await effect(10, "done", "configured", 13, 20, "handoff", "outra");
			await session(11, "handed_off", 45);
			await effect(11, "done", "configured", 13, 25); // stale sector id belongs to another instance
			const snapshot = await activity();
			assert.equal(snapshot.started, 5);
			assert.equal(snapshot.handedOff, 3);
			assert.equal(snapshot.averageSeconds, 3600); // weighted (40 + 120 + 20) minutes / 3
			assert.equal(snapshot.failed, 2);
			assert.equal(snapshot.pendingIntervention, 1);
			assert.deepEqual(snapshot.byReason, [{label:"Fluxo concluído", count:2}, {label:"Tempo de espera esgotado", count:1}]);
			assert.deepEqual(snapshot.bySector, [{label:"Setor #13", count:1}, {label:"Suporte", count:1}, {label:"Vendas", count:1}]);
			assert.deepEqual(snapshot.chats, [{chatId:4, status:"intervention"}, {chatId:6, status:"handoff"}, {chatId:1, status:"waiting"}]);
			for (let id = 80; id < 132; id++) {
				await session(id, "handoff", 2000);
				await effect(id, "failed", "delivery", 11, 1900);
			}
			const capped = await activity();
			assert.equal(capped.chats.length, 50);
			assert.equal(capped.pendingIntervention, 53);
			assert.ok(capped.chats.every(chat => chat.status === "intervention"));
		} finally {
			await prisma.$disconnect();
			await pool.end();
			await connection.query(`DROP DATABASE IF EXISTS ${schema}`);
			await connection.end();
		}
	});
}
