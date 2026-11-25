import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PrismaClient, type WppMessage } from "@prisma/client";
import mysql from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import type { TriageDefinition } from "./definition";

const url = process.env["TRIAGE_RUNTIME_TEST_MYSQL_URL"];
const definition: TriageDefinition = {
	entry: "question",
	fallbackSectorId: 5,
	timeoutMinutes: 30,
	maxInvalid: 2,
	schedule: { timezone: "America/Sao_Paulo", days: [] },
	nodes: [
		{ id: "question", type: "question", title: "Motivo", text: "Qual o motivo?", next: "human" },
		{ id: "human", type: "handoff", title: "Suporte", sectorId: 5 }
	]
};

test("ingresso, persistência, efeitos e intervenção da triagem nos dois modos MySQL", { skip: !url }, async () => {
	const server = new URL(url!);
	assert(["localhost", "127.0.0.1"].includes(server.hostname));
	const admin = await mysql.createConnection({
		host: server.hostname,
		port: Number(server.port) || 3306,
		user: decodeURIComponent(server.username),
		password: decodeURIComponent(server.password)
	});
	const sql = execFileSync(
		process.execPath,
		[
			resolve("node_modules/prisma/build/index.js"),
			"migrate",
			"diff",
			"--from-empty",
			"--to-schema-datamodel",
			"prisma/schema.prisma",
			"--script"
		],
		{ encoding: "utf8" }
	);
	const saved = new Map<string, NodeModule | undefined>();
	function stub(path: string, value: unknown) {
		const id = require.resolve(path);
		saved.set(id, require.cache[id]);
		require.cache[id] = {
			id,
			filename: id,
			loaded: true,
			exports: { __esModule: true, default: value }
		} as NodeModule;
	}
	let database: PrismaClient;
	const liveDb = new Proxy(
		{},
		{
			get: (_, key) => {
				const value = (database as any)[key];
				return typeof value === "function" ? value.bind(database) : value;
			}
		}
	);
	let sends = 0;
	let unknown = false;
	stub("../services/prisma.service", liveDb);
	stub("../services/instances.service", {});
	stub("../services/chats.service", { syncChatToLocal: async () => {} });
	stub("../services/messages.service", { syncMessageToLocal: async () => {} });
	stub("../services/messages-distribution.service", {
		notifyMessage: async () => {},
		notifyChatStarted: async () => {},
		getFlow: async (instance: string, sectorId: number) => ({
			getChatPayload: async (_: unknown, c: { id: number }) => ({
				instance,
				sectorId,
				contactId: c.id,
				userId: 11
			})
		})
	});
	stub("../services/whatsapp.service", {
		getClient: (id: number) => ({
			id,
			instance: "alpha",
			sendMessage: async () => {
				sends++;
				if (unknown) throw Error("ambiguous provider outcome");
				return { status: "SENT", wabaId: "out-" + sends };
			}
		})
	});
	const { consumeTriage, expireTriage, acceptsTriageMessage } = require("./runtime") as typeof import("./runtime");
	const { serviceTriageEffect, takeOverTriage, drainTriage } = require("./dispatch") as typeof import("./dispatch");
	const { resolveTriageWabaChannel } = require("./waba-channel") as typeof import("./waba-channel");
	const previousMode = process.env["WHATSAPP_STORAGE"];
	try {
		for (const native of [false, true]) {
			const name = "triage_runtime_" + randomBytes(7).toString("hex");
			await admin.query("CREATE DATABASE " + name);
			const target = new URL(server);
			target.pathname = "/" + name;
			const pool = mysql.createPool(target.toString());
			const prefix = native ? "wpp_runtime_" : "";
			const client = new PrismaClient({ datasources: { db: { url: target.toString() } } });
			database = native ? (createTenantSqlRouter(new Map([["alpha", pool]])) as PrismaClient) : client;
			process.env["WHATSAPP_STORAGE"] = native ? "tenant-sql" : "central";
			try {
				for (const statement of sql.split(";")) {
					const ddl = statement.replace(/^\s*--[^\n]*\n/gm, "").trim();
					if (/^CREATE TABLE (?!`triage_)/.test(ddl))
						await pool.query(ddl.replace(/^CREATE TABLE `/, "CREATE TABLE `" + prefix));
				}
				for (const migration of ["20261125150000_triage_authoring", "20261125151000_triage_runtime"]) {
					const file = native
						? "prisma/tenant-sql/" + migration + ".sql"
						: "prisma/migrations/" + migration + "/migration.sql";
					for (const query of readFileSync(file, "utf8")
						.split(";")
						.map((s) => s.trim())
						.filter(Boolean))
						await pool.query(query);
				}
				await withDatabaseTenant("alpha", async () => {
					await database.parameter.create({
						data: { scope: "INSTANCE", key: "enable_whatsapp_triage", value: "true", instance: "alpha" }
					});
					await database.wppSector.create({
						data: { id: 5, name: "Atendimento", instance: "alpha", startChats: true, receiveChats: true }
					});
					for (const id of [1, 2]) {
						await database.wppClient.create({
							data: {
								id,
								instance: "alpha",
								name: "Canal " + id,
								isActive: true,
								type: "WABA",
								WABAPhoneId: "phone-" + id,
								WABAAccountId: "account"
							}
						});
						await pool.query("INSERT INTO " + prefix + "_sector_clients (A,B) VALUES (?,5)", [id]);
						await pool.query(
							"INSERT INTO " +
								prefix +
								"triage_channels (instance,channel_id,revision,name,definition,edited_by,active_version_id,paused) VALUES ('alpha',?,1,'Teste',?,1,?,0)",
							[id, JSON.stringify(definition), id]
						);
						await pool.query(
							"INSERT INTO " +
								prefix +
								"triage_versions (id,instance,channel_id,number,name,definition,created_by) VALUES (?,'alpha',?,1,'Teste',?,1)",
							[id, id, JSON.stringify(definition)]
						);
					}
					const contact = await database.wppContact.create({
						data: { instance: "alpha", phone: "5511001", name: "Contato" }
					});
					const primary = await database.wppClient.findFirstOrThrow({ where: { instance: "alpha", id: 1 } });
					assert.equal((await resolveTriageWabaChannel(primary, "phone-2", "account")).id, 2);
					await assert.rejects(
						() => resolveTriageWabaChannel(primary, "phone-2", "wrong-account"),
						/CHANNEL_MISMATCH/
					);
					const incoming = (body: string, clientId = 1) =>
						database.wppMessage.create({
							data: {
								instance: "alpha",
								from: contact.phone!,
								to: "me:100",
								clientId,
								body,
								type: "chat",
								sentAt: new Date(),
								status: "RECEIVED",
								timestamp: String(Date.now())
							}
						});
					const first = await incoming("Olá");
					for (const from of ["me:1", "bot:1", "system", "thirdparty:meta", "user:1", "123@g.us"])
						assert.equal(acceptsTriageMessage({ ...first, from }), false);
					const consume = (m: WppMessage, chat: Awaited<ReturnType<typeof database.wppChat.findFirst>>) =>
						consumeTriage("alpha", m.clientId!, contact, m, chat);
					const pair = await Promise.all([consume(first, null), consume(first, null)]);
					assert.equal(pair[0]?.chat?.id, pair[1]?.chat?.id);
					const chat = pair[0]!.chat!;
					assert.equal(await database.triageEvent.count({ where: { chatId: chat.id } }), 1);
					assert.equal(await database.triageEffect.count({ where: { chatId: chat.id } }), 1);
					const secondChannel = await consume(await incoming("outro canal", 2), chat);
					assert(secondChannel?.opened && secondChannel.chat && secondChannel.chat.id !== chat.id);
					await pool.query("UPDATE " + prefix + "triage_channels SET paused=1 WHERE channel_id=1");
					const before = sends;
					const prompt = await database.triageEffect.findFirstOrThrow({ where: { chatId: chat.id } });
					await Promise.all([serviceTriageEffect(prompt), serviceTriageEffect(prompt)]);
					assert.equal(sends - before, 1);
					const reply = await incoming("Garantia");
					await consume(reply, chat);
					await serviceTriageEffect(
						await database.triageEffect.findFirstOrThrow({ where: { chatId: chat.id, kind: "handoff" } })
					);
					assert.equal(
						(await database.triageSession.findUniqueOrThrow({ where: { chatId: chat.id } })).status,
						"handed_off"
					);
					const human = await database.wppChat.findUniqueOrThrow({ where: { id: chat.id } });
					assert.equal(human.userId, 11);
					assert.match(
						(await database.wppMessage.findFirstOrThrow({ where: { chatId: chat.id, from: "system" } }))
							.body,
						/Motivo: Garantia/
					);
					const replay = await consume(
						await database.wppMessage.findUniqueOrThrow({ where: { id: reply.id } }),
						human
					);
					assert(replay?.handled);
					const other = secondChannel.chat;
					await assert.rejects(() => takeOverTriage("alpha", other.id, 42, undefined, 1));
					await takeOverTriage("alpha", other.id, 42, undefined, 2);
					await expireTriage("alpha", other.id, new Date(Date.now() + 600_000_000));
					assert.equal(
						await database.triageEffect.count({ where: { chatId: other.id, status: "pending" } }),
						0
					);
					assert.equal(
						(await database.triageSession.findUniqueOrThrow({ where: { chatId: other.id } })).status,
						"taken"
					);
					await database.wppChat.updateMany({ where: { instance: "alpha" }, data: { isFinished: true } });
					const late = await consume(await incoming("Olá", 2), null);
					const lateId = late!.chat!.id;
					unknown = true;
					const ambiguous = await database.triageEffect.findFirstOrThrow({ where: { chatId: lateId } });
					const atRisk = sends;
					await serviceTriageEffect(ambiguous);
					await serviceTriageEffect(ambiguous);
					assert.equal(sends, atRisk + 1);
					assert.equal(
						(await database.triageEffect.findUniqueOrThrow({ where: { id: ambiguous.id } })).status,
						"unknown"
					);
					assert.equal(
						await database.triageEffect.count({
							where: { chatId: lateId, kind: "handoff", status: "pending" }
						}),
						1
					);
					unknown = false;
					await database.wppChat.updateMany({ where: { instance: "alpha" }, data: { isFinished: true } });
					const idle = await consume(await incoming("Oi", 2), null);
					const future = new Date(Date.now() + 7200_000);
					await Promise.all([
						expireTriage("alpha", idle!.chat!.id, future),
						expireTriage("alpha", idle!.chat!.id, future)
					]);
					assert.equal(
						await database.triageEvent.count({ where: { chatId: idle!.chat!.id, kind: "timeout" } }),
						1
					);
					await database.wppChat.updateMany({ where: { instance: "alpha" }, data: { isFinished: true } });
					const crashed = await consume(await incoming("Oi", 2), null);
					const stranded = await database.triageEffect.findFirstOrThrow({
						where: { chatId: crashed!.chat!.id, kind: "message" }
					});
					await database.triageEffect.update({
						where: { id: stranded.id },
						data: { status: "sending", attempts: 1, retryAt: new Date(0) }
					});
					await drainTriage();
					assert.equal(
						(await database.triageEffect.findUniqueOrThrow({ where: { id: stranded.id } })).status,
						"unknown"
					);
					assert.equal(
						await database.triageEffect.count({ where: { chatId: stranded.chatId, kind: "message" } }),
						1
					);
					// A process upgraded ahead of a disabled tenant must leave its current conversations usable.
					await database.parameter.updateMany({
						where: { instance: "alpha", key: "enable_whatsapp_triage" },
						data: { value: "false" }
					});
					await pool.query(
						"DROP TABLE " +
							prefix +
							"triage_events, " +
							prefix +
							"triage_sessions, " +
							prefix +
							"triage_effects"
					);
					const legacy = await database.wppChat.create({
						data: { instance: "alpha", type: "RECEPTIVE", sectorId: 5, contactId: contact.id }
					});
					const old = await incoming("Retentativa");
					assert.equal(await consume({ ...old, chatId: legacy.id }, legacy), null);
					assert.equal(await consume(await incoming("Primeiro contato"), null), null);
				});
			} finally {
				await client.$disconnect();
				await pool.end();
				await admin.query("DROP DATABASE " + name);
			}
		}
	} finally {
		await admin.end();
		if (previousMode === undefined) delete process.env["WHATSAPP_STORAGE"];
		else process.env["WHATSAPP_STORAGE"] = previousMode;
		for (const [id, module] of saved) {
			if (module) require.cache[id] = module;
			else delete require.cache[id];
		}
	}
});
