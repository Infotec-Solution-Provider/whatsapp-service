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
			getChatPayload: async (_: unknown, c: { id: number }, m: WppMessage) => {
				assert.equal(m.chatId, null, "o transbordo humano não dispara a IA");
				return {
					instance,
					sectorId,
					contactId: c.id,
					userId: 11
				};
			}
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
	const { lockReceivingSector } =
		require("../services/sectors.service") as typeof import("../services/sectors.service");
	const { listChatTransferSectors, transferChatToSectorQueue } =
		require("../services/chat-sector-transfer") as typeof import("../services/chat-sector-transfer");
	const { startTriggeredTriage, manualTriageAvailability } =
		require("./trigger-start") as typeof import("./trigger-start");
	const { enqueueTriageNotice, processTriageNotice } =
		require("./trigger-notices") as typeof import("./trigger-notices");
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
				const migrate = async (name: string) => {
					const file = native
						? "prisma/tenant-sql/" + name + ".sql"
						: "prisma/migrations/" + name + "/migration.sql";
					for (const query of readFileSync(file, "utf8")
						.split(";")
						.map((q) => q.trim())
						.filter(Boolean))
						await pool.query(query);
				};
				for (const migration of [
					"20261125150000_triage_authoring",
					"20261125151000_triage_runtime",
					"20261125193000_triage_trigger_sets",
					"20261125194000_triage_activation_runtime"
				])
					await migrate(migration);
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
					// The channels/versions above predate the multi-bot migration and must retain their references.
					await migrate("20261125220000_triage_multi_bot");
					await migrate("20261125221000_triage_notice_bot");
					const extraBotId = 21,
						extraVersionId = 31;
					await pool.query(
						"INSERT INTO " +
							prefix +
							"triage_bots(id,instance,channel_id,revision,name,definition,edited_by,active_version_id,paused) VALUES (?,'alpha',2,1,'Pedidos',?,1,?,0)",
						[extraBotId, JSON.stringify(definition), extraVersionId]
					);
					await pool.query(
						"INSERT INTO " +
							prefix +
							"triage_bot_versions(id,instance,channel_id,bot_id,number,name,definition,created_by) VALUES (?,'alpha',2,?,1,'Pedidos',?,1)",
						[extraVersionId, extraBotId, JSON.stringify(definition)]
					);
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
					const consume = async (
						m: WppMessage,
						chat: Awaited<ReturnType<typeof database.wppChat.findFirst>>
					) => {
						const reply = await consumeTriage("alpha", m.clientId!, contact, m, chat);
						if (reply?.handled || (chat && !reply)) return reply;
						const began = await startTriggeredTriage({
							instance: "alpha",
							channelId: m.clientId!,
							type: "flow",
							sectorId: 5,
							contact,
							message: m,
							botId: m.clientId!,
							eventKey: String(m.id)
						});
						return began ? { handled: true, ...began } : reply;
					};
					assert.equal(
						await consumeTriage("alpha", 1, contact, first, null),
						null,
						"publicar um bot sozinho não abre atendimento"
					);
					const pair = await Promise.all([consume(first, null), consume(first, null)]);
					assert.equal(pair[0]?.chat?.id, pair[1]?.chat?.id);
					const chat = pair[0]!.chat!;
					assert.equal(await database.triageEvent.count({ where: { chatId: chat.id } }), 1);
					assert.equal(await database.triageEffect.count({ where: { chatId: chat.id } }), 1);
					const secondChannel = await consume(await incoming("outro canal", 2), chat);
					assert(secondChannel?.opened && secondChannel.chat && secondChannel.chat.id !== chat.id);
					await pool.query("UPDATE " + prefix + "triage_bots SET paused=1 WHERE id=1");
					const repeat = await startTriggeredTriage({
						instance: "alpha",
						channelId: 1,
						type: "flow",
						sectorId: 5,
						contact,
						message: first,
						botId: 1,
						eventKey: String(first.id)
					});
					assert(
						repeat && !repeat.started && repeat.ref.version === 1,
						"replay usa versão original mesmo pausada"
					);
					await pool.query(
						"INSERT INTO " +
							prefix +
							"triage_bot_versions(id,instance,channel_id,bot_id,number,name,definition,created_by) VALUES(32,'alpha',1,1,2,'Nova versão',?,1)",
						[JSON.stringify(definition)]
					);
					await pool.query("UPDATE " + prefix + "triage_bots SET active_version_id=32,paused=0 WHERE id=1");
					const afterPublish = await startTriggeredTriage({
						instance: "alpha",
						channelId: 1,
						type: "flow",
						sectorId: 5,
						contact,
						message: first,
						botId: 1,
						eventKey: String(first.id)
					});
					assert.deepEqual(afterPublish?.ref, { id: 1, name: "Teste", version: 1 });
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
					await database.wppChat.updateMany({ where: { instance: "alpha" }, data: { isFinished: true } });
					const rules = [
						{ type: "keyword", botId: 2, keywords: ["ajuda", "comum"] },
						{ type: "keyword", botId: extraBotId, keywords: ["pedidos", "comum"] },
						{ type: "manual", botId: extraBotId },
						{ type: "manual", botId: 2 },
						{ type: "transfer", botId: 2 },
						{ type: "closed", botId: extraBotId }
					];
					await pool.query(
						"INSERT INTO " +
							prefix +
							"triage_trigger_sets(instance,sector_id,revision,rules,edited_by) VALUES ('alpha',5,1,?,1)",
						[JSON.stringify(rules)]
					);
					const duplicateKeyword = await incoming("comum", 2);
					assert.equal(
						await startTriggeredTriage({
							instance: "alpha",
							channelId: 2,
							type: "keyword",
							message: duplicateKeyword,
							contact,
							eventKey: String(duplicateKeyword.id)
						}),
						null
					);
					const secondBotContact = await database.wppContact.create({
						data: { instance: "alpha", phone: "551188", name: "Outro contato" }
					});
					const order = await database.wppMessage.create({
						data: {
							instance: "alpha",
							from: secondBotContact.phone!,
							to: "me:100",
							clientId: 2,
							body: "pedidos",
							type: "chat",
							sentAt: new Date(),
							status: "RECEIVED",
							timestamp: String(Date.now())
						}
					});
					const orderHit = await startTriggeredTriage({
						instance: "alpha",
						channelId: 2,
						type: "keyword",
						contact: secondBotContact,
						message: order,
						eventKey: String(order.id)
					});
					assert.equal(orderHit?.ref.id, extraBotId);
					assert.equal(
						(await database.triageSession.findUniqueOrThrow({ where: { chatId: orderHit!.chat.id } }))
							.versionId,
						extraVersionId
					);
					const keyMsg = await incoming("AJUDA", 2);
					const kw = {
						instance: "alpha",
						channelId: 2,
						type: "keyword" as const,
						message: keyMsg,
						contact,
						eventKey: String(keyMsg.id)
					};
					const opened = await startTriggeredTriage(kw);
					assert(opened?.started);
					assert.equal(opened.ref.id, 2);
					await takeOverTriage("alpha", opened.chat.id, 17, undefined, 2);
					assert.deepEqual(await manualTriageAvailability("alpha", 2, opened.chat.id, 99), []);
					assert.deepEqual(
						(await manualTriageAvailability("alpha", 2, opened.chat.id, 17))
							.map((x) => x.botId)
							.sort((a, b) => a - b),
						[2, extraBotId]
					);
					const manual = {
						instance: "alpha",
						channelId: 2,
						chatId: opened.chat.id,
						type: "manual" as const,
						botId: extraBotId,
						eventKey: "button-1",
						actorId: 17
					};
					const twice = await Promise.all([startTriggeredTriage(manual), startTriggeredTriage(manual)]);
					assert.equal(twice[0]?.ref.id, extraBotId);
					assert.equal(
						await startTriggeredTriage({ ...manual, botId: 2 }),
						null,
						"não redireciona comando idempotente a outro bot"
					);
					assert.equal(
						(await database.triageSession.findUniqueOrThrow({ where: { chatId: opened.chat.id } }))
							.versionId,
						extraVersionId
					);
					assert.equal(twice.filter((x) => x?.started).length, 1);
					assert.equal(await database.triageRun.count({ where: { chatId: opened.chat.id } }), 2);
					await takeOverTriage("alpha", opened.chat.id, 17, undefined, 2);
					const closed = await database.$transaction(async (tx) => {
						const changed = await tx.wppChat.update({
							where: { id: opened.chat.id },
							data: { isFinished: true }
						});
						await enqueueTriageNotice(tx, changed, "closed");
						return changed;
					});
					const notice = await database.triageTriggerNotice.findFirstOrThrow({
						where: { chatId: closed.id }
					});
					await Promise.all([processTriageNotice(notice), processTriageNotice(notice)]);
					const follow = await database.triageRun.findFirstOrThrow({
						where: { originChatId: closed.id, kind: "closed" }
					});
					assert.notEqual(follow.chatId, closed.id);
					assert.equal(follow.botId, extraBotId);
					assert.equal(notice.botId, extraBotId);
					assert((await database.wppChat.findUniqueOrThrow({ where: { id: closed.id } })).isFinished);
					const firstOutbound = await database.triageEffect.findFirstOrThrow({
						where: { chatId: follow.chatId }
					});
					const delivered = sends;
					await serviceTriageEffect(firstOutbound);
					assert.equal(sends, delivered + 1);
					await database.$transaction(async (tx) => {
						const final = await tx.wppChat.update({
							where: { id: follow.chatId },
							data: { isFinished: true }
						});
						await enqueueTriageNotice(tx, final, "closed");
					});
					assert.equal(
						await database.triageTriggerNotice.count({ where: { chatId: follow.chatId } }),
						0,
						"fechar acompanhamento não volta a disparar"
					);
					await database.wppSector.create({
						data: { id: 6, name: "Comercial", instance: "alpha", startChats: true, receiveChats: true }
					});
					await pool.query("INSERT INTO " + prefix + "_sector_clients(A,B) VALUES (2,6)");
					await pool.query(
						"INSERT INTO " +
							prefix +
							"triage_trigger_sets(instance,sector_id,revision,rules,edited_by) VALUES ('alpha',6,1,?,1)",
						[JSON.stringify([{ type: "transfer", botId: 2 }])]
					);
					const foreign = await database.wppSector.create({
						data: {
							id: 12,
							name: "Somente outro número",
							instance: "alpha",
							startChats: true,
							receiveChats: true
						}
					});
					await pool.query("INSERT INTO " + prefix + "_sector_clients(A,B) VALUES(1,12)");
					await database.$transaction(async (tx) => {
						assert.equal(await lockReceivingSector(tx, "alpha", 2, 6), true);
						assert.equal(await lockReceivingSector(tx, "alpha", 2, foreign.id), false);
					});
					const queue = await database.wppChat.create({
						data: { instance: "alpha", sectorId: 5, contactId: contact.id, type: "RECEPTIVE", userId: 17 }
					});
					const received = await incoming("Prioridade", 2);
					await database.wppMessage.update({
						where: { id: received.id },
						data: { chatId: queue.id, contactId: contact.id }
					});
					const operator = { instance: "alpha", userId: 17, name: "Operador", sectorId: 5, role: "ATIVO" };
					assert.deepEqual(await listChatTransferSectors(operator, queue.id), [{ id: 6, name: "Comercial" }]);
					await assert.rejects(() => transferChatToSectorQueue({ ...operator, userId: 18 }, queue.id, 6));
					await assert.rejects(() => transferChatToSectorQueue(operator, queue.id, 123));
					const transfer = await transferChatToSectorQueue(operator, queue.id, 6);
					assert.equal(transfer.chat.userId, -1);
					await processTriageNotice(
						await database.triageTriggerNotice.findFirstOrThrow({ where: { chatId: queue.id } })
					);
					assert.equal(
						(await database.triageSession.findUniqueOrThrow({ where: { chatId: queue.id } })).status,
						"waiting"
					);
					const { verifySharedSectorRouting } =
						require("./shared-sector-routing.mysql-cases") as typeof import("./shared-sector-routing.mysql-cases");
					const shared = await verifySharedSectorRouting(database);
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
					const { findChatForContactChannel } =
						require("../services/chat-channel-scope") as typeof import("../services/chat-channel-scope");
					assert.equal(
						(await findChatForContactChannel(database, 8, shared.contact))?.id,
						shared.otherId,
						"canal correto mesmo sem tabelas de triagem"
					);
					const legacy = await database.wppChat.create({
						data: { instance: "alpha", type: "RECEPTIVE", sectorId: 5, contactId: contact.id }
					});
					const old = await incoming("Retentativa");
					assert.equal(await consume({ ...old, chatId: legacy.id }, legacy), null);
					assert.equal(
						await consumeTriage("alpha", 1, contact, await incoming("Primeiro contato"), null),
						null
					);
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
