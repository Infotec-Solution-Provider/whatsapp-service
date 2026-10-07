import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Request, Response } from "express";
import isAdmin from "../../middlewares/is-admin.middleware";
import type { SessionData } from "../../sdk-local";
import { parseMonitorRequest, parseSlaMinutes } from "./monitor-contract";
import { buildMonitorQuery, monitorLike, type MonitorQueryContext } from "./monitor-query";
import {
	compareMonitorRows,
	mapMonitorRow,
	monitorPage,
	monitorSources,
	monitorSummary,
	type MonitorExecute,
	type MonitorRow
} from "./monitor-reader";
import { readMonitorMessages } from "./monitor-history";

// SQL semantics are exercised on disposable in-memory databases. Only MySQL's epoch
// function and charset conversion are adapted; no application database is contacted.
const now = new Date("2026-09-25T12:00:00.000Z");
const when = (minutes: number) => new Date(now.getTime() + minutes * 60000).toISOString();
const session: SessionData = { instance: "nunes", sectorId: 2, userId: 2, name: "Supervisor", role: "ADMIN" };
const central = new DatabaseSync(":memory:"),
	tenant = new DatabaseSync(":memory:");
function prepare(db: DatabaseSync, local: boolean) {
	db.function("TIMESTAMPDIFF", (_unit, start, end) =>
		end === null ? null : (Date.parse(String(end)) - Date.parse(String(start))) * 1000
	);
	db.function("CONCAT", { varargs: true }, (...values) => values.join(""));
	db.function("LEFT", (value, count) => (value === null ? null : String(value).slice(0, Number(count))));
	const prefix = local ? "wpp_" : "";
	db.exec(`
		CREATE TABLE ${prefix}chats (id INTEGER, original_id INTEGER, instance TEXT, contact_id INTEGER, user_id INTEGER, sector_id INTEGER, bot_id INTEGER, type TEXT, avatar_url TEXT, is_finished INTEGER, is_schedule INTEGER, started_at TEXT, finished_at TEXT, finished_by INTEGER, result_id INTEGER);
		CREATE TABLE ${prefix}contacts (id INTEGER, instance TEXT, name TEXT, phone TEXT, customer_id INTEGER);
		CREATE TABLE ${prefix}messages (id INTEGER, instance TEXT, chat_id INTEGER, contact_id INTEGER, "from" TEXT, "to" TEXT, body TEXT, type TEXT, timestamp TEXT, sent_at TEXT, status TEXT, client_id INTEGER, quoted_id INTEGER, file_name TEXT);
		CREATE TABLE ${prefix}schedules (id INTEGER, instance TEXT, chat_id INTEGER, contact_id INTEGER, description TEXT, scheduled_at TEXT, schedule_date TEXT, scheduled_by INTEGER, scheduled_for INTEGER, sector_id INTEGER);
		CREATE TABLE clientes (CODIGO INTEGER, RAZAO TEXT, FANTASIA TEXT, CPF_CNPJ TEXT, COD_ERP TEXT);
		CREATE TABLE internalchats (id INTEGER, instance TEXT, user_id INTEGER, sector_id INTEGER, is_finished INTEGER, started_at TEXT, finished_at TEXT, finished_by INTEGER, is_group INTEGER, group_name TEXT, group_description TEXT, group_image_file_id INTEGER, wpp_group_id TEXT);
		CREATE TABLE internalmessages (id INTEGER, instance TEXT, internalchat_id INTEGER, "from" TEXT, type TEXT, body TEXT, timestamp TEXT, status TEXT, client_id INTEGER, quoted_id INTEGER, file_name TEXT);
		CREATE TABLE internal_chat_members (internalchatId INTEGER, internalcontactId INTEGER, joined_at TEXT, last_read_at TEXT);
	`);
}
function insert(db: DatabaseSync, table: string, values: MonitorRow) {
	db.prepare(
		`INSERT INTO ${table} (${Object.keys(values)
			.map((key) => `"${key}"`)
			.join(",")}) VALUES (${Object.keys(values)
			.map(() => "?")
			.join(",")})`
	).run(...(Object.values(values) as (string | number | null)[]));
}
function seed(db: DatabaseSync, local: boolean) {
	const p = local ? "wpp_" : "";
	insert(db, `${p}contacts`, { id: 10, instance: "nunes", name: "Alice", phone: "5511999990000", customer_id: 100 });
	insert(db, "clientes", { CODIGO: 100, RAZAO: "Cliente Alfa", CPF_CNPJ: "12345678000199" });
	for (const id of [1, 2, 3, 4, 5, 6, 7, 8])
		insert(db, `${p}chats`, {
			id: local ? id + 100 : id,
			original_id: id,
			instance: id === 7 ? "other" : "nunes",
			sector_id: id === 6 ? 9 : 2,
			contact_id: 10,
			user_id: id === 5 ? null : 2,
			bot_id: id === 4 ? 8 : null,
			type: "DEFAULT",
			is_finished: id === 2 ? 1 : 0,
			is_schedule: id === 1 ? 1 : 0,
			started_at: when(-120),
			finished_at: id === 2 ? when(-100) : null
		});
	const message = (
		id: number,
		chat: number,
		from: string,
		minutes: number,
		status = "SENT",
		quoted: number | null = null
	) =>
		insert(db, `${p}messages`, {
			id,
			instance: "nunes",
			chat_id: chat,
			contact_id: 10,
			from,
			to: "customer",
			body: `message ${id}`,
			timestamp: String(now.getTime() + minutes * 60000),
			sent_at: when(minutes),
			status,
			client_id: 1,
			type: "chat",
			quoted_id: quoted
		});
	message(11, 1, "customer", -50);
	message(12, 1, "customer", -40, "SENT", 20);
	message(13, 1, "bot:1", -10);
	message(14, 1, "system:notice", -5);
	message(20, 2, "me:1", -110, "READ");
	message(30, 3, "user:2", -20);
	message(40, 4, "customer", -10);
	message(60, 6, "customer", -2);
	message(80, 8, "user:2", -1, "UNKNOWN");
	for (const [id, minutes] of [
		[1, 60],
		[2, 72 * 60],
		[3, -30],
		[4, 40]
	])
		insert(db, `${p}schedules`, {
			id,
			instance: "nunes",
			sector_id: 2,
			chat_id: id === 4 ? 1 : null,
			contact_id: 10,
			description: "Retorno da proposta",
			scheduled_at: when(-60),
			schedule_date: when(minutes!),
			scheduled_by: 2,
			scheduled_for: 3
		});
}
prepare(central, false);
prepare(tenant, true);
seed(central, false);
seed(tenant, true);
insert(central, "internalchats", {
	id: 1,
	instance: "nunes",
	user_id: 2,
	sector_id: 2,
	is_finished: 0,
	started_at: when(-100),
	is_group: 1,
	group_name: "Equipe"
});
insert(central, "internal_chat_members", { internalchatId: 1, internalcontactId: 2, last_read_at: when(-30) });
for (const [id, from, minutes] of [
	[1, "user:2", -20],
	[2, "user:3", -10]
] as const)
	insert(central, "internalmessages", {
		id,
		instance: "nunes",
		internalchat_id: 1,
		from,
		body: "Mensagem interna",
		timestamp: String(now.getTime() + minutes * 60000),
		status: "READ",
		type: "chat"
	});
const calls: Array<{ local: boolean; sql: string; params: unknown[] }> = [];
const execute: MonitorExecute = async (local, query) => {
	calls.push({ local, ...query });
	const sql = query.sql
		.replace(/TIMESTAMPDIFF\(MICROSECOND,/g, "TIMESTAMPDIFF('MICROSECOND',")
		.replace(/CONVERT\(/g, "(")
		.replace(/ USING utf8mb4\)/g, ")");
	const params = query.params.map((value) => (value instanceof Date ? value.toISOString() : value)) as (
		| string
		| number
		| null
	)[];
	return (local ? tenant : central).prepare(sql).all(...params) as MonitorRow[];
};
function context(local: boolean, filters: unknown = {}): MonitorQueryContext {
	return {
		local,
		session,
		now,
		slaMinutes: 30,
		customerIds: [100],
		localTimezoneOffsetMinutes: 0,
		filters: parseMonitorRequest({ filters }).filters
	};
}
let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
	await run();
	passed++;
	console.log(`ok ${passed} - ${name}`);
}

async function run() {
	await test("reject invalid pages, oversized limits, booleans and sort injection", () => {
		for (const input of [
			{ page: 0 },
			{ page: -1 },
			{ page: 1.5 },
			{ pageSize: 101 },
			{ filters: { sortOrder: "desc; DROP TABLE chats" } },
			{ filters: { showBots: "false" } },
			{ filters: { startedAt: { from: "bad" } } }
		])
			assert.throws(() => parseMonitorRequest(input));
		assert.equal(parseMonitorRequest({}).pageSize, 20);
		assert.equal(parseMonitorRequest({}).filters.sortBy, "urgency");
		assert.equal(monitorLike("50%_="), "%50=%=_==%");
		assert.equal(parseSlaMinutes(undefined), null);
		assert.equal(parseSlaMinutes("bad"), null);
		assert.equal(parseSlaMinutes("0"), null);
		assert.equal(parseSlaMinutes("30"), 30);
	});
	await test("monitor reads require authenticated ADMIN and keep the session tenant and sector", async () => {
		let allowed = false;
		assert.throws(() =>
			isAdmin({ session: { ...session, role: "USER" } } as Request, {} as Response, () => {
				allowed = true;
			})
		);
		assert.equal(allowed, false);
		isAdmin({ session } as Request, {} as Response, () => {
			allowed = true;
		});
		assert.equal(allowed, true);
		const controller = readFileSync(join(__dirname, "../../controllers/monitor.controller.ts"), "utf8").replace(
			/\r\n/g,
			"\n"
		);
		for (const route of [
			"/api/whatsapp/monitor/search",
			"/api/whatsapp/monitor/summary",
			"/api/whatsapp/monitor/chats/:type/:id/messages"
		]) {
			assert.ok(controller.includes(`"${route}",\n\t\t\tisAuthenticated,\n\t\t\tisAdmin,`));
		}
		const scoped = buildMonitorQuery("wpp", context(false, { instance: "other", sectorId: 9 }));
		assert.deepEqual(scoped.params.slice(0, 2), ["nunes", 2]);
		const rows = await execute(false, scoped);
		assert.ok(rows.every((row) => row["instance"] === "nunes" && Number(row["sector_id"]) === 2));
	});
	await test("date-only range covers the whole civil day and rejects rolled dates", () => {
		const filters = parseMonitorRequest({
			filters: { startedAt: { from: "2026-09-25", to: "2026-09-25" } }
		}).filters;
		const start = new Date(filters.startedAt.from!),
			end = new Date(filters.startedAt.to!);
		assert.equal(start.getHours(), 0);
		assert.equal(end.getHours(), 23);
		assert.equal(end.getMilliseconds(), 999);
		assert.equal(end.getTime() - start.getTime(), 86400000 - 1);
		assert.throws(() => parseMonitorRequest({ filters: { startedAt: { from: "2026-02-31" } } }));
	});
	for (const local of [false, true]) {
		await test(`${local ? "local" : "standard"}: last message and unread stay within chat; bot/system do not end human wait`, async () => {
			const ctx = context(local);
			const rows = await execute(local, buildMonitorQuery("wpp", ctx));
			assert.deepEqual(rows.map((row) => Number(row["id"])).sort(), [1, 2, 3, 5, 8]);
			const waiting = mapMonitorRow(rows.find((row) => Number(row["id"]) === 1)!);
			assert.equal(waiting.operational.status, "waiting_agent");
			assert.equal(waiting.operational.waitingSince, when(-50));
			assert.equal(waiting.operational.unreadCount, 2);
			assert.equal(waiting.operational.slaBreached, true);
			assert.equal(waiting.lastMessage?.id, 14);
			const historical = mapMonitorRow(rows.find((row) => Number(row["id"]) === 2)!);
			assert.equal(historical.lastMessage?.id, 20);
			assert.equal(historical.operational.unreadCount, 0);
			assert.equal(
				mapMonitorRow(rows.find((row) => Number(row["id"]) === 3)!).operational.status,
				"waiting_customer"
			);
			assert.equal(
				mapMonitorRow(rows.find((row) => Number(row["id"]) === 8)!).operational.deliveryStatus,
				"UNKNOWN"
			);
		});
		await test(`${local ? "local" : "standard"}: aggregate counts equal operational filters and preserve all other filters`, async () => {
			const ctx = context(local);
			const summary = await monitorSummary(execute, monitorSources(ctx), 30);
			assert.deepEqual(summary, {
				inProgress: 5,
				waitingAgent: 2,
				waitingCustomer: 1,
				unread: 2,
				overdue: 2,
				scheduled: 2,
				slaMinutes: 30
			});
			for (const [status, count] of [
				["in_progress", 5],
				["waiting_agent", 2],
				["waiting_customer", 1],
				["unread", 2],
				["overdue", 2],
				["scheduled", 2]
			] as const) {
				const request = parseMonitorRequest({ filters: { operationalStatus: status }, pageSize: 100 });
				const page = await monitorPage(execute, monitorSources({ ...ctx, filters: request.filters }), request);
				assert.equal(page.totalCount, count, status);
				assert.equal(page.rows.length, count, status);
			}
			const noSla = await monitorSummary(execute, monitorSources({ ...ctx, slaMinutes: null }), null);
			assert.equal(noSla.overdue, 0);
			assert.equal(noSla.slaMinutes, null);
		});
	}
	await test("failed, pending and ambiguous outbound attempts do not reset the customer's waiting time", async () => {
		for (const local of [false, true]) {
			const database = local ? tenant : central,
				table = local ? "wpp_messages" : "messages";
			for (const status of ["ERROR", "PENDING", "UNKNOWN"]) {
				insert(database, table, {
					id: 15,
					instance: "nunes",
					chat_id: 1,
					contact_id: 10,
					from: "user:2",
					body: "Tentativa de resposta",
					timestamp: String(now.getTime() - 60000),
					sent_at: when(-1),
					status,
					type: "chat"
				});
				const rows = await execute(local, buildMonitorQuery("wpp", context(local)));
				const item = mapMonitorRow(rows.find((row) => Number(row["id"]) === 1)!);
				assert.equal(item.operational.status, "waiting_agent", status);
				assert.equal(item.operational.waitingSince, when(-50), status);
				assert.equal(item.operational.slaBreached, true);
				assert.equal(item.operational.deliveryStatus, status);
				database.exec(`DELETE FROM ${table} WHERE id = 15`);
			}
		}
	});
	await test("local wall-clock dates and absolute message epochs give consistent UTC-3 SLA and schedule bounds", async () => {
		tenant.exec(
			"UPDATE wpp_chats SET started_at = datetime(started_at, '-3 hours'), finished_at = datetime(finished_at, '-3 hours'); UPDATE wpp_schedules SET scheduled_at = datetime(scheduled_at, '-3 hours'), schedule_date = datetime(schedule_date, '-3 hours'); UPDATE wpp_messages SET sent_at = datetime(sent_at, '-3 hours')"
		);
		const ctx = { ...context(true), localTimezoneOffsetMinutes: 180 };
		const rows = await execute(true, buildMonitorQuery("wpp", ctx));
		const item = mapMonitorRow(rows.find((row) => Number(row["id"]) === 1)!);
		assert.equal(item.startedAt, when(-120));
		assert.equal(item.operational.waitingSince, when(-50));
		assert.equal(item.operational.lastMessageAt, when(-5));
		const summary = await monitorSummary(execute, monitorSources(ctx), 30);
		assert.equal(summary.scheduled, 2);
		assert.equal(summary.overdue, 2);
		const ranged = buildMonitorQuery("schedule", {
			...ctx,
			filters: parseMonitorRequest({ filters: { scheduledTo: { from: when(0), to: when(120) } } }).filters
		});
		assert.ok(ranged.params.includes("2026-09-25 09:00:00.000"));
		assert.deepEqual(
			(await execute(true, ranged)).map((row) => Number(row["id"])),
			[1]
		);
		tenant.exec(
			"UPDATE wpp_chats SET started_at = datetime(started_at, '+3 hours'), finished_at = datetime(finished_at, '+3 hours'); UPDATE wpp_schedules SET scheduled_at = datetime(scheduled_at, '+3 hours'), schedule_date = datetime(schedule_date, '+3 hours'); UPDATE wpp_messages SET sent_at = datetime(sent_at, '+3 hours')"
		);
	});
	await test("category-specific filters apply without returning unrelated rows", async () => {
		const scenarios = [
			[{ showOngoing: false, showFinished: false }, ["schedule:1", "schedule:2", "schedule:3"]],
			[{ showOngoing: false, showFinished: true }, ["schedule:1", "schedule:2", "schedule:3", "wpp:2"]],
			[{ showOnlyScheduled: true }, ["schedule:1", "schedule:2", "schedule:3", "wpp:1"]],
			[{ scheduledFor: 3, scheduledBy: 2 }, ["schedule:1", "schedule:2", "schedule:3", "wpp:1"]],
			[{ user: 3 }, ["schedule:1", "schedule:2", "schedule:3"]],
			[{ searchText: "Equipe", searchColumn: "name" }, ["internal:1"]],
			[{ searchText: "Retorno", searchColumn: "message" }, ["schedule:1", "schedule:2", "schedule:3"]],
			[
				{
					showBots: true,
					categories: {
						showCustomerChats: true,
						showInternalChats: false,
						showInternalGroups: false,
						showSchedules: false
					}
				},
				["wpp:1", "wpp:2", "wpp:3", "wpp:4", "wpp:5", "wpp:8"]
			]
		] as const;
		for (const [filters, expected] of scenarios) {
			const request = parseMonitorRequest({ filters, pageSize: 100 });
			const page = await monitorPage(execute, monitorSources(context(true, filters)), request);
			assert.deepEqual(
				page.rows.map((row) => `${row["category"]}:${row["id"]}`).sort(),
				expected,
				JSON.stringify(filters)
			);
		}
	});
	await test("internal unread belongs to current member, excludes self, and never invents customer SLA", async () => {
		const ctx = context(false);
		const rows = await execute(false, buildMonitorQuery("internal", ctx));
		const item = mapMonitorRow(rows[0]!);
		assert.equal(item.operational.unreadCount, 1);
		assert.equal(item.operational.slaBreached, null);
		const nonmember = await execute(
			false,
			buildMonitorQuery("internal", { ...ctx, session: { ...session, userId: 9 } })
		);
		assert.equal(mapMonitorRow(nonmember[0]!).operational.unreadCount, null);
	});
	await test("all sort modes merge sources in the same order as full sorted reference", async () => {
		for (const sortBy of ["urgency", "startedAt", "finishedAt", "lastMessage", "scheduledAt", "name"] as const) {
			for (const sortOrder of ["asc", "desc"] as const) {
				const request = parseMonitorRequest({ filters: { sortBy, sortOrder }, pageSize: 3 });
				const sources = monitorSources(context(true, request.filters));
				const all = await monitorPage(execute, sources, { ...request, pageSize: 100 });
				assert.deepEqual(
					all.rows,
					[...all.rows].sort((a, b) => compareMonitorRows(a, b, request.filters))
				);
				const paged: MonitorRow[] = [];
				for (let page = 1; page <= 3; page++)
					paged.push(...(await monitorPage(execute, sources, { ...request, page })).rows);
				assert.deepEqual(paged, all.rows, `${sortBy} ${sortOrder}`);
			}
		}
	});
	await test("selected history validates scope before reading, limits rows, keeps quotes within chat, never marks read", async () => {
		calls.length = 0;
		const first = await readMonitorMessages(execute, session, true, { type: "wpp", id: "1", limit: "3" });
		assert.deepEqual(
			first.messages.map((message) => message["id"]),
			[12, 13, 14]
		);
		assert.equal(first.nextCursor, 12);
		assert.deepEqual(first.quotedMessages, []);
		const older = await readMonitorMessages(execute, session, true, {
			type: "wpp",
			id: 1,
			limit: 3,
			beforeId: first.nextCursor
		});
		assert.deepEqual(
			older.messages.map((message) => message["id"]),
			[11]
		);
		assert.equal(older.nextCursor, null);
		const before = calls.length;
		await assert.rejects(readMonitorMessages(execute, session, true, { type: "wpp", id: 6 }));
		assert.equal(calls.length, before + 1);
		await assert.rejects(readMonitorMessages(execute, session, true, { type: "wpp", id: 1, limit: 101 }));
		assert.ok(calls.every((call) => call.sql.startsWith("SELECT")));
		const internal = await readMonitorMessages(execute, session, true, { type: "internal", id: 1 });
		assert.equal(internal.messages[0]?.["internalChatId"], 1);
		assert.equal(calls.at(-1)?.local, false);
	});
	await test("large histories never enter list responses and cross-source batches stay bounded", async () => {
		for (let id = 1000; id < 1340; id++)
			insert(tenant, "wpp_schedules", {
				id,
				instance: "nunes",
				sector_id: 2,
				chat_id: null,
				contact_id: 10,
				scheduled_at: when(0),
				schedule_date: when(id),
				scheduled_by: 2,
				scheduled_for: 3
			});
		calls.length = 0;
		const request = parseMonitorRequest({
			page: 5,
			pageSize: 50,
			filters: { sortBy: "scheduledAt", sortOrder: "asc" }
		});
		const page = await monitorPage(execute, monitorSources(context(true, request.filters)), request);
		assert.equal(page.totalCount, 349);
		assert.equal(page.rows.length, 50);
		const pageCalls = calls.filter((call) => call.sql.includes("LIMIT ? OFFSET ?"));
		assert.ok(pageCalls.length >= 4 && pageCalls.length <= 24);
		assert.ok(pageCalls.every((call) => Number(call.params.at(-2)) <= 50));
		assert.ok(page.rows.every((row) => mapMonitorRow(row).messages.length === 0));
	});
	central.close();
	tenant.close();
	console.log(`${passed} monitor tests passed (in-memory SQL only).`);
}
void run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
