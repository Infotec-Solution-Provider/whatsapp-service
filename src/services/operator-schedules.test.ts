import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionData } from "../sdk-local";
import { parseScheduleQuery, scheduleCivilDate, schedulePeriod } from "./operator-schedules.contract";

const saved = new Map<string, NodeModule | undefined>();
for (const path of [
	"./prisma.service",
	"./instances.service",
	"./parameters.service",
	"./customer-profile-tags.service"
]) {
	const filename = require.resolve(path);
	saved.set(filename, require.cache[filename]);
	require.cache[filename] = {
		id: filename,
		filename,
		loaded: true,
		exports: { __esModule: true, default: {} }
	} as NodeModule;
}
const { UnifiedSchedulesService } =
	require("./unified-schedules.service") as typeof import("./unified-schedules.service");
for (const [filename, previous] of saved) {
	if (previous) require.cache[filename] = previous;
	else delete require.cache[filename];
}

type Row = Record<string, any> & {
	instance?: any;
	scheduledFor?: any;
	chatId?: any;
	sectorId?: any;
	id?: any;
	scheduleDate?: any;
	contact?: any;
	orderBy?: any;
	skip?: any;
	take?: any;
	OPERADOR?: any;
	date?: any;
	CODIGO?: any;
	where?: any;
	sql?: any;
};
const actor: SessionData = { instance: "fixture", userId: 7, sectorId: 3, role: "ATIVO", name: "Fixture" };
const now = new Date("2026-11-13T15:00:00.000Z");
const status = (error: any) => error.status ?? error.statusCode;
function customer(id: number, changes: Row = {}) {
	return {
		CODIGO: id,
		RAZAO: `Cliente ${id}`,
		FANTASIA: `Fantasia ${id}`,
		COD_CAMPANHA: 1,
		ORIGEM: 1,
		BLOCK_COMPRAS: "NAO",
		CUSTOMER_CAMPAIGN_NAME: "Campanha Árvore",
		CUSTOMER_ORIGIN_DESCRIPTION: "Origem indicação",
		...changes
	};
}
function schedule(id: number, changes: Row = {}) {
	return {
		id,
		instance: "fixture",
		scheduledFor: 7,
		scheduledBy: 7,
		sectorId: 3,
		chatId: null,
		scheduleDate: new Date(
			`2026-11-${String(13 + Math.floor(id / 24)).padStart(2, "0")}T${String(id % 24).padStart(2, "0")}:00:00Z`
		),
		description: null,
		contactId: id,
		contact: {
			name: `Contato ${id}`,
			phone: `555190000${String(id).padStart(4, "0")}`,
			customerId: id,
			isDeleted: false,
			isOnlyAdmin: false
		},
		...changes
	};
}
function profile(id: number) {
	return {
		customerId: id,
		profileLevel: "potencial_de_compra",
		label: "Potencial de compra",
		purchaseInterest: { level: "alto_interesse", label: "Alto interesse" },
		tags: {
			interaction: { tagValue: "interacao_alta", label: "Interação alta" },
			purchase: { tagValue: "muitas_compras", label: "Muitas compras" },
			age: { tagValue: "cliente_novo", label: "Cliente novo" }
		}
	};
}
function fixture(changes: Row = {}) {
	const state = {
		schedules: Array.from({ length: 45 }, (_, i) => schedule(i + 1)),
		customers: Array.from({ length: 45 }, (_, i) => customer(i + 1)),
		telephony: [] as Row[],
		profileCalls: [] as number[][],
		crmCalls: [] as Row[],
		reads: [] as Row[],
		financial: true,
		active: "SIM" as string | null,
		failFinancial: false,
		old: false,
		failProfile: false,
		failCrm: false,
		failChannel: false,
		invalid: 0,
		customerMatches: null as number[] | null,
		businessResponse: null as number[] | null,
		failBusiness: false,
		...changes
	};
	const database = {
		wppSchedule: {
			findMany: async (args: Row) => {
				state.reads.push(structuredClone(args));
				if (state.failChannel) throw new Error("channel failed");
				const w = args["where"],
					range = w.scheduleDate ?? {};
				return state.schedules
					.filter(
						(row: Row) =>
							row.instance === w.instance &&
							row.scheduledFor === w.scheduledFor &&
							row.chatId === null &&
							(!("sectorId" in w) || row.sectorId === w.sectorId) &&
							(!w.id || w.id.in.includes(row.id)) &&
							(!range.gte || row.scheduleDate >= range.gte) &&
							(!range.lt || row.scheduleDate < range.lt) &&
							!row.contact.isDeleted &&
							(!Object.hasOwn(w.contact, "isOnlyAdmin") ||
								row.contact.isOnlyAdmin === w.contact.isOnlyAdmin)
					)
					.sort(
						(a: Row, b: Row) =>
							(a.scheduleDate - b.scheduleDate) * (args.orderBy[0].scheduleDate === "asc" ? 1 : -1) ||
							a.id - b.id
					)
					.slice(args.skip, args.skip + args.take);
			}
		}
	};
	const crm = {
		executeQuery: async (instance: string, sql: string, values: any[]) => {
			assert.equal(instance, "fixture");
			state.crmCalls.push({ sql, values });
			if (sql.includes("SELECT VISUALIZA_COMPRAS")) {
				if (state.failFinancial) throw new Error("permission lookup failed");
				assert.match(sql, /ATIVO IS NULL OR ATIVO<>'NAO'/);
				if (state.active === "NAO") return [];
				return [{ VISUALIZA_COMPRAS: state.financial ? "SIM" : "NAO" }];
			}
			if (sql.includes("SELECT COUNT(*) AS total FROM campanhas_clientes")) return [{ total: state.invalid }];
			if (sql.includes("FROM campanhas_clientes cc")) {
				if (state.failChannel) throw new Error("channel failed");
				let rows = state.telephony.filter((row: Row) => row.OPERADOR === values[0]);
				let cursor = 1;
				if (sql.includes("cc.DT_AGENDAMENTO>=?")) {
					const bound = values[cursor++];
					rows = rows.filter((row: Row) => row.date >= bound);
				}
				if (sql.includes("cc.DT_AGENDAMENTO<?")) {
					const bound = values[cursor++];
					rows = rows.filter((row: Row) => row.date < bound);
				}
				if (sql.includes("cc.CODIGO IN (?)")) {
					const ids = values[cursor++];
					rows = rows.filter((row: Row) => ids.includes(row.CODIGO));
				}
				rows = rows.sort(
					(a: Row, b: Row) =>
						a.date.localeCompare(b.date) * (sql.includes("DT_AGENDAMENTO DESC") ? -1 : 1) ||
						a.CODIGO - b.CODIGO
				);
				return rows.slice(values.at(-1), values.at(-1) + values.at(-2));
			}
			if (state.failCrm) throw new Error("crm failed");
			if (sql.includes("clientes.CODIGO FROM clientes WHERE")) {
				if (state.failBusiness) throw new Error("business query failed");
				const count = /clientes\.CODIGO IN \(([^)]+)\)/.exec(sql)?.[1]?.split(",").length ?? 0;
				const ids = values.slice(0, count);
				return state.businessResponse
					? state.businessResponse.map((CODIGO) => ({ CODIGO }))
					: state.customers
							.filter(
								(row: Row) =>
									ids.includes(row.CODIGO) &&
									(state.customerMatches === null || state.customerMatches.includes(row.CODIGO))
							)
							.map((row: Row) => ({ CODIGO: row.CODIGO }));
			}
			if (sql.includes("FROM clientes c"))
				return state.customers.filter((row: Row) => values[0].includes(row.CODIGO));
			if (sql.includes("ordered.CLIENTE"))
				return values[0].map((id: number) => ({
					customerId: id,
					averageDays: 30,
					lastAt: "2026-10-01 12:00:00"
				}));
			throw new Error("Unexpected SQL");
		}
	};
	const profiles = {
		getCustomerProfileSummariesReadOnly: async (_instance: string, ids: number[]) => {
			state.profileCalls.push(ids);
			if (state.failProfile) throw new Error("profiles failed");
			return ids.map(profile);
		}
	};
	const service = new UnifiedSchedulesService(
		database as any,
		crm as any,
		{ getSessionParams: async () => ({ use_old_crm_schedule: String(state.old) }) } as any,
		profiles as any,
		() => now,
		() => undefined
	);
	return { state, service };
}

test("personal scope derives user and includes legitimately assigned schedules in another sector", async () => {
	const { service, state } = fixture();
	state.schedules = [
		schedule(1, { sectorId: 4 }),
		schedule(2, { scheduledFor: 8 }),
		schedule(3, { instance: "other" })
	];
	const result = await service.getMySchedules(actor, {});
	assert.deepEqual(
		result.data.map((row) => row.scheduleId),
		[1]
	);
	assert.equal("sectorId" in state.reads[0]!.where, false);
	assert.equal(result.referenceAt, now.toISOString());
});
for (const query of [
	{ userId: "7" },
	{ sectorId: "3" },
	{ channels: ["WHATSAPP"] },
	{ search: {} },
	{ other: "x" },
	{ perPage: "101" },
	{ page: "9007199254740993" },
	{ channels: "SMS" },
	{ repurchaseStatuses: "pink" },
	{ customerCampaignIds: "1,,2" },
	{ customerCampaignIds: "1.2" },
	{ search: "a".repeat(201) },
	{ period: "custom", scheduledFrom: "2026-02-31T00:00:00Z", scheduledTo: "2026-03-04T00:00:00Z" },
	{ period: "custom", scheduledFrom: "2026-11-14T00:00:00Z", scheduledTo: "2026-11-13T00:00:00Z" },
	{ scheduledFrom: "2026-11-13T00:00:00Z" }
])
	test("query rejects malformed/overriding value " + JSON.stringify(query), () => {
		assert.throws(
			() => parseScheduleQuery(query, actor, true),
			(error) => status(error) === 400
		);
	});
test("operator agenda excludes deleted and administrator-only contacts", async () => {
	const { service, state } = fixture();
	state.schedules = [
		schedule(1),
		schedule(2, { contact: { ...schedule(2).contact, isDeleted: true } }),
		schedule(3, { contact: { ...schedule(3).contact, isOnlyAdmin: true } })
	];
	assert.deepEqual(
		(await service.getMySchedules(actor, {})).data.map((row) => row.scheduleId),
		[1]
	);
	assert.deepEqual(
		(await service.getMySchedules({ ...actor, role: "ADMIN" }, {})).data.map((row) => row.scheduleId),
		[1, 3]
	);
});
test("unavailable financial authorization is a recoverable error for dependent filters", async () => {
	const { service, state } = fixture({ failFinancial: true });
	const result = await service.getMySchedules(actor, {});
	assert.equal(result.capabilities?.commercial, false);
	assert.ok(result.warnings?.some((warning) => warning.code === "COMMERCIAL_ACCESS_UNAVAILABLE"));
	await assert.rejects(
		() => service.getMySchedules(actor, { purchaseLevel: "muitas_compras" }),
		(error) => status(error) === 500
	);
	assert.equal(state.profileCalls.length, 0);
	assert.equal(
		state.crmCalls.some((call: Row) => call.sql.includes("FROM compras")),
		false
	);
});
test("legacy NULL active state retains explicit commercial permission while inactive users are denied", async () => {
	const { service, state } = fixture({ active: null });
	assert.equal((await service.getMySchedules(actor, {})).capabilities?.commercial, true);
	assert.equal((await service.getMySchedules(actor, { purchaseLevel: "muitas_compras" })).pagination.totalRows, 45);
	state.active = "NAO";
	assert.equal((await service.getMySchedules(actor, {})).capabilities?.commercial, false);
	await assert.rejects(
		() => service.getMySchedules(actor, { purchaseLevel: "muitas_compras" }),
		(error) => status(error) === 403
	);
});
test("legacy administrative override is preserved and operators cannot impersonate", async () => {
	const { service, state } = fixture();
	state.schedules = [schedule(1, { scheduledFor: 8 })];
	await assert.rejects(
		() => service.getUnifiedSchedules(actor, { userId: "8" }),
		(error) => status(error) === 403
	);
	assert.equal(state.crmCalls.length, 0);
	const result = await service.getUnifiedSchedules({ ...actor, role: "ADMIN" }, { userId: "8", perPage: "100" });
	assert.equal(result.data.length, 1);
	assert.equal(result.pagination.perPage, 100);
});
test("search is global and totals do not depend on page size", async () => {
	const { service } = fixture();
	for (const perPage of ["10", "25", "50"]) {
		const result = await service.getMySchedules(actor, { search: "Cliente 44", perPage });
		assert.deepEqual(
			result.data.map((row) => row.scheduleId),
			[44]
		);
		assert.equal(result.pagination.totalRows, 1);
	}
});
test("global search preserves accent-insensitive campaign, origin, profile and formatted phone matching", async () => {
	const { service, state } = fixture();
	state.schedules = [schedule(1)];
	state.customers = [customer(1)];
	for (const search of ["arvore", "INDICACAO", "potencial de compra", "interacao alta", "(55) 51 90000-0001"]) {
		const result = await service.getMySchedules(actor, { search });
		assert.equal(result.data.length, 1, search);
	}
});
test("campaign metadata remains available when filters return zero", async () => {
	const { service } = fixture();
	const result = await service.getMySchedules(actor, { customerCampaignIds: "999", search: "nothing" });
	assert.equal(result.pagination.totalRows, 0);
	assert.deepEqual(result.filters.customerCampaigns, [{ id: "1", label: "Campanha Árvore" }]);
	assert.equal(result.pagination.current, 1);
});
test("simple query enriches profiles and purchases only for its page", async () => {
	const { service, state } = fixture();
	const result = await service.getMySchedules(actor, { perPage: "10" });
	assert.equal(result.data.length, 10);
	assert.equal(state.profileCalls.length, 1);
	assert.equal(state.profileCalls[0]!.length, 10);
	assert.equal(state.crmCalls.filter((call: Row) => call.sql.includes("ordered.CLIENTE")).length, 1);
	assert.ok(state.reads.every((read: Row) => read.take <= 200));
});
test("commercial denial never calls purchases or profiles and rejects commercial filters", async () => {
	const { service, state } = fixture({ financial: false });
	const result = await service.getMySchedules(actor, {});
	assert.equal(result.capabilities?.commercial, false);
	assert.ok(result.data.every((row) => row.profileSummary === null && row.repurchase === null));
	assert.equal(state.profileCalls.length, 0);
	assert.equal(
		state.crmCalls.some((call: Row) => call.sql.includes("FROM compras")),
		false
	);
	await assert.rejects(
		() => service.getMySchedules(actor, { purchaseLevel: "muitas_compras" }),
		(error) => status(error) === 403
	);
});
test("blocked customers cannot reveal commercial data through projection, filters, or text search", async () => {
	const { service, state } = fixture();
	state.schedules = [schedule(1)];
	state.customers = [customer(1, { BLOCK_COMPRAS: "SIM" })];
	const basic = await service.getMySchedules(actor, {});
	assert.equal(basic.data[0]?.meta.commercialRestricted, true);
	assert.equal(basic.data[0]?.profileSummary, null);
	assert.equal(basic.data[0]?.repurchase, null);
	assert.equal(state.profileCalls.length, 0);
	const search = await service.getMySchedules(actor, { search: "muitas compras" });
	assert.equal(search.pagination.totalRows, 0);
	const filtered = await service.getMySchedules(actor, { repurchaseStatuses: "neutral" });
	assert.equal(filtered.pagination.totalRows, 0);
	const admin = await service.getMySchedules({ ...actor, role: "ADMIN" }, {});
	assert.ok(admin.data[0]?.profileSummary);
});
test("missing linked customer or no linked customer remains a valid basic schedule", async () => {
	const { service, state } = fixture();
	state.schedules = [schedule(1), schedule(2, { contact: { ...schedule(2).contact, customerId: null } })];
	state.customers = [];
	const result = await service.getMySchedules(actor, {});
	assert.equal(result.pagination.totalRows, 2);
	assert.ok(result.data.every((row) => row.customerName === null && row.profileSummary === null));
});
test("optional enrichment failure warns; dependent search/filter and channel failures reject", async () => {
	const { service, state } = fixture({ failProfile: true });
	const basic = await service.getMySchedules(actor, {});
	assert.ok(basic.warnings?.some((warning) => warning.code === "ENRICHMENT_UNAVAILABLE"));
	assert.equal(basic.pagination.totalRows, 45);
	await assert.rejects(
		() => service.getMySchedules(actor, { profileLevel: "consolidado" }),
		(error) => status(error) === 500
	);
	await assert.rejects(
		() => service.getMySchedules(actor, { search: "Cliente" }),
		(error) => status(error) === 500
	);
	state.failProfile = false;
	state.failChannel = true;
	await assert.rejects(
		() => service.getMySchedules(actor, {}),
		(error) => status(error) === 500
	);
});
test("custom bounds are start inclusive/end exclusive and today uses Sao Paulo civil day", async () => {
	const { service, state } = fixture();
	state.schedules = [
		schedule(1, { scheduleDate: new Date("2026-11-13T03:00:00Z") }),
		schedule(2, { scheduleDate: new Date("2026-11-14T02:59:59Z") }),
		schedule(3, { scheduleDate: new Date("2026-11-14T03:00:00Z") }),
		schedule(4, { scheduleDate: new Date("2026-11-13T02:59:59Z") })
	];
	const today = await service.getMySchedules(actor, { period: "today" });
	assert.deepEqual(
		today.data.map((row) => row.scheduleId),
		[1, 2]
	);
	const custom = await service.getMySchedules(actor, {
		period: "custom",
		scheduledFrom: "2026-11-13T00:00:00-03:00",
		scheduledTo: "2026-11-14T00:00:00-03:00"
	});
	assert.deepEqual(
		custom.data.map((row) => row.scheduleId),
		[1, 2]
	);
	assert.deepEqual(schedulePeriod({ period: "next7" }, now), { from: now, to: new Date("2026-11-20T15:00:00Z") });
});
test("legacy zero and invalid calendar dates raise a controlled error", () => {
	for (const date of ["0000-00-00 00:00:00", "2026-02-31 00:00:00", "2026-00-14 00:00:00", "invalid"])
		assert.throws(
			() => scheduleCivilDate(date),
			(error) => status(error) === 400
		);
	assert.equal(scheduleCivilDate("2026-11-13 12:00:00").toISOString(), now.toISOString());
});
test("telephone ownership remains wallet OPERATOR and invalid-date rows are visible as warnings", async () => {
	const { service, state } = fixture({ old: true, invalid: 1, schedules: [] });
	state.telephony = [
		{
			CODIGO: 90,
			CLIENTE: 1,
			CAMPANHA: 1,
			date: "2026-11-13 12:00:00",
			OPERADOR: 7,
			OPERADOR_LIGACAO: 0,
			phone: "51999999999",
			name: "Fixture",
			campaign: "Campaign",
			operatorName: "Fixture"
		}
	];
	const mine = await service.getMySchedules(actor, { channels: "TELEFONIA" });
	assert.equal(mine.data[0]?.scheduledFor, 7);
	assert.equal(mine.data[0]?.scheduledBy, 0);
	assert.ok(mine.warnings?.some((warning) => warning.code === "INVALID_SCHEDULE_DATES"));
	assert.equal(mine.pagination.totalRows, 1);
	const legacy = await service.getUnifiedSchedules(actor, { channels: "TELEFONIA" });
	assert.equal(legacy.data[0]?.scheduledFor, 0);
	assert.equal(legacy.data[0]?.scheduledBy, 7);
});
test("telephone civil bounds preserve fractional inclusive/exclusive instants at second precision", async () => {
	const { service, state } = fixture({ old: true, schedules: [] });
	state.telephony = [0, 1, 2].map((second) => ({
		CODIGO: second + 1,
		CLIENTE: 1,
		CAMPANHA: 1,
		date: `2026-11-13 12:00:0${second}`,
		OPERADOR: 7,
		OPERADOR_LIGACAO: 0,
		phone: "5199",
		name: "Fixture",
		campaign: "Campaign",
		operatorName: "Fixture"
	}));
	const result = await service.getMySchedules(actor, {
		channels: "TELEFONIA",
		period: "custom",
		scheduledFrom: "2026-11-13T15:00:00.123Z",
		scheduledTo: "2026-11-13T15:00:01.123Z"
	});
	assert.deepEqual(
		result.data.map((row) => row.scheduleId),
		[2]
	);
});
test("cross-source paging has deterministic timestamp/channel/id ties in both directions", async () => {
	const { service, state } = fixture({ old: true });
	state.schedules = Array.from({ length: 30 }, (_, i) =>
		schedule(i + 1, { scheduleDate: new Date("2026-11-13T15:00:00Z") })
	);
	state.telephony = Array.from({ length: 30 }, (_, i) => ({
		CODIGO: i + 100,
		CLIENTE: 1,
		CAMPANHA: 1,
		date: "2026-11-13 12:00:00",
		OPERADOR: 7,
		OPERADOR_LIGACAO: 0,
		phone: "5199",
		name: "Fixture",
		campaign: "Campaign",
		operatorName: "Fixture"
	}));
	for (const sortOrder of ["asc", "desc"]) {
		const result = await service.getMySchedules(actor, { page: "4", perPage: "10", sortOrder });
		assert.deepEqual(
			result.data.map((row) => row.id),
			Array.from({ length: 10 }, (_, i) => `WHATSAPP-${i + 1}`)
		);
		assert.equal(result.pagination.totalRows, 60);
	}
});
test("CRM view performs no automatic profile or repurchase enrichment, with legacy routes preserved", async () => {
	const { service, state } = fixture();
	const crm = await service.getMySchedules(actor, { view: "crm", search: "Cliente" });
	assert.equal(crm.pagination.totalRows, 45);
	assert.ok(crm.data.every((row) => row.profileSummary === null && row.repurchase === null));
	assert.equal(state.profileCalls.length, 0);
	assert.equal(
		state.crmCalls.some((call: Row) => call.sql.includes("ordered.CLIENTE")),
		false
	);
	assert.equal(
		(await service.getMySchedules(actor, { view: "crm", search: "muitas compras" })).pagination.totalRows,
		0
	);
	assert.equal((await service.getUnifiedSchedules(actor, { search: "muitas compras" })).pagination.totalRows, 45);
	assert.equal(
		(await service.getMySchedules(actor, { view: "crm", purchaseLevel: "muitas_compras" })).pagination.totalRows,
		45
	);
});
test("business matching is real, scoped, bounded and applied before exact totals and paging", async () => {
	const { service, state } = fixture({ customerMatches: [44] });
	for (const perPage of ["10", "25", "50"]) {
		const result = await service.getMySchedules(actor, { view: "crm", segmentIds: "1,2", groupIds: "10", perPage });
		assert.deepEqual(
			result.data.map((row) => row.scheduleId),
			[44]
		);
		assert.equal(result.pagination.totalRows, 1);
		assert.deepEqual(result.filters.customerCampaigns, [{ id: "1", label: "Campanha Árvore" }]);
	}
	const calls = state.crmCalls.filter((call: Row) => call.sql.includes("clientes.CODIGO FROM clientes WHERE"));
	assert.ok(calls.length >= 3);
	assert.ok(
		calls.every(
			(call: Row) => call.sql.includes("clientes.SEGMENTO IN (?,?)") && call.sql.includes("clientes.GRUPO IN (?)")
		)
	);
	assert.equal(state.profileCalls.length, 0);
});
test("business filters exclude absent clients, retain zero and negative CRM ids, and reject foreign matcher rows", async () => {
	const { service, state } = fixture();
	state.schedules = [
		schedule(1, { contact: { ...schedule(1).contact, customerId: 0 } }),
		schedule(2, { contact: { ...schedule(2).contact, customerId: -1 } }),
		schedule(3, { contact: { ...schedule(3).contact, customerId: null } }),
		schedule(4, { contact: { ...schedule(4).contact, customerId: 999 } })
	];
	state.customers = [customer(0, { COD_CAMPANHA: 0 }), customer(-1, { COD_CAMPANHA: -1 })];
	const result = await service.getMySchedules(actor, { view: "crm", groupIds: "0,-1" });
	assert.deepEqual(
		result.data.map((row) => row.customerId),
		[0, -1]
	);
	assert.equal(result.data[0]?.customerName, "Cliente 0");
	assert.deepEqual(result.filters.customerCampaigns.map((option) => option.id).sort(), ["-1", "0"]);
	state.businessResponse = [9000];
	await assert.rejects(
		() => service.getMySchedules(actor, { view: "crm", segmentIds: "1" }),
		(error) => status(error) === 500
	);
});
test("purchase business filters enforce financial permission before querying purchases and failure never broadens", async () => {
	const { service, state } = fixture({ financial: false });
	for (const query of [
		{ purchaseStatus: "with_purchases" },
		{ purchaseStatus: "without_purchases" },
		{ purchaseFrom: "2026-11-13" }
	])
		await assert.rejects(
			() => service.getMySchedules(actor, { view: "crm", ...query }),
			(error) => status(error) === 403
		);
	assert.equal(
		state.crmCalls.some((call: Row) => call.sql.includes("FROM compras")),
		false
	);
	state.financial = true;
	state.failBusiness = true;
	await assert.rejects(
		() => service.getMySchedules(actor, { view: "crm", segmentIds: "1" }),
		(error) => status(error) === 500
	);
	state.schedules = [];
	await assert.rejects(
		() =>
			service.getMySchedules(actor, {
				view: "crm",
				purchaseStatus: "without_purchases",
				purchaseFrom: "2026-11-13"
			}),
		(error) => status(error) === 400
	);
});
