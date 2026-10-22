import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionData } from "../sdk-local";

type Row = Record<string, any> & {
	id?: any; name?: any; customerId?: any; instance?: any; sectors?: any; sectorId?: any;
	description?: any; scheduledBy?: any; scheduledFor?: any; chatId?: any;
};
const actor: SessionData = { instance: "fixture-a", userId: 7, sectorId: 3, role: "ATIVO", name: "Fixture" };
let contacts: Row[] = [], schedules: Row[] = [], sectors: Row[] = [], writes = 0;
let ownOnly = false;
let race: (() => void) | undefined;
const queries: Row[] = [];
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "AND") return (Array.isArray(value) ? value : [value]).every(condition => matches(row, condition));
		if (key === "OR") return value.some((condition: Row) => matches(row, condition));
		if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
		return row[key] === value;
	});
}
function delegate(rows: () => Row[]) {
	return {
		findFirst: async ({ where }: Row) => { queries.push(copy(where)); return copy(rows().find(row => matches(row, where)) ?? null); },
		findMany: async ({ where }: Row) => { queries.push(copy(where)); return copy(rows().filter(row => matches(row, where))); },
		update: async ({ where, data }: Row) => {
			if (race) { const hook = race; race = undefined; hook(); }
			const row = rows().find(item => matches(item, where));
			if (!row) throw new Error("P2025 fixture: scope changed before write");
			writes++;
			const { sectors: links, ...scalar } = data;
			Object.assign(row, copy(scalar));
			if (links?.deleteMany) row.sectors = [];
			if (links?.create) row.sectors.push(...links.create.map((link: Row) => ({ contactId: row.id, ...link })));
			if (links?.connectOrCreate && !row.sectors.some((link: Row) => link.sectorId === links.connectOrCreate.create.sectorId)) {
				row.sectors.push({ contactId: row.id, ...links.connectOrCreate.create });
			}
			return copy(row);
		},
		delete: async ({ where }: Row) => {
			if (race) { const hook = race; race = undefined; hook(); }
			const index = rows().findIndex(row => matches(row, where));
			if (index < 0) throw new Error("P2025 fixture: scope changed before delete");
			writes++; return copy(rows().splice(index, 1)[0]);
		}
	};
}
const database: Row = {
	wppContact: delegate(() => contacts), wppSchedule: delegate(() => schedules), wppSector: delegate(() => sectors),
	wppWallet: { findMany: async ({ where }: Row) => { queries.push(copy(where)); return []; } },
	$transaction: async (fn: (tx: any) => Promise<unknown>) => fn(database)
};
const saved = new Map<string, NodeModule | undefined>();
function stub(modulePath: string, value: unknown) {
	const filename = require.resolve(modulePath); saved.set(filename, require.cache[filename]);
	require.cache[filename] = { id: filename, filename, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
}
stub("./prisma.service", database);
stub("./parameters.service", { getSessionParams: async () => ({ update_only_own_contacts: String(ownOnly) }) });
stub("./instances.service", { executeQuery: async () => [{ OPERADOR: 99 }] });
stub("./chats.service", {}); stub("./local-sync.service", {});
stub("node-cron", { schedule: () => undefined });
stub("../routines/idle-chats.routine", () => undefined); stub("../routines/schedules.routine", () => undefined);
const registry = require.resolve("../tenant-sql/registry"); saved.set(registry, require.cache[registry]);
require.cache[registry] = { id: registry, filename: registry, loaded: true, exports: { tenantSqlEnabled: () => true } } as NodeModule;
const contactService = (require("./contacts.service") as typeof import("./contacts.service")).default;
const scheduleService = (require("./schedules.service") as typeof import("./schedules.service")).default;
const walletService = (require("./wallets.service") as typeof import("./wallets.service")).default;
for (const [filename, previous] of saved) { if (previous) require.cache[filename] = previous; else delete require.cache[filename]; }

function reset() {
	contacts = [{ id: 1, instance: "fixture-a", name: "Before", customerId: null, isDeleted: false, isOnlyAdmin: false, sectors: [{ sectorId: 3 }] }];
	schedules = [{ id: 9, instance: "fixture-a", scheduledBy: 7, scheduledFor: 8, sectorId: 3, chatId: null, description: null }];
	sectors = [{ id: 3, instance: "fixture-a" }, { id: 4, instance: "fixture-a" }, { id: 5, instance: "fixture-b" }];
	writes = 0; queries.length = 0; ownOnly = false; race = undefined;
}

for (const field of ["instance", "isDeleted", "isOnlyAdmin", "isBlocked", "phone", "whatsappId", "sectors", "WppChat", "id"]) {
	test(`contact edit rejects privileged field ${field} before lookup`, async () => {
		reset(); await assert.rejects(() => contactService.updateContactWrapper(actor, 1, { [field]: false }));
		assert.equal(writes, 0); assert.equal(queries.length, 0);
	});
}
test("contacts remain in their tenant and deleted/admin-only rows cannot be edited by an operator", async () => {
	for (const changes of [{ instance: "fixture-b" }, { isDeleted: true }, { isOnlyAdmin: true }]) {
		reset(); Object.assign(contacts[0]!, changes);
		await assert.rejects(() => contactService.updateContactWrapper(actor, 1, { name: "After" })); assert.equal(writes, 0);
	}
});
test("contact customerId is only a precondition and never a raw linkage mutation", async () => {
	reset(); await assert.rejects(() => contactService.updateContactWrapper(actor, 1, { name: "After", customerId: 88 }));
	assert.equal(writes, 0); contacts[0]!.customerId = 88;
	await contactService.updateContactWrapper(actor, 1, { name: "After", customerId: 88 });
	assert.equal(contacts[0]!.name, "After"); assert.equal(contacts[0]!.customerId, 88);
});
test("contacts preserve ownership policy and validate every requested sector before writing", async () => {
	reset(); ownOnly = true; contacts[0]!.customerId = 88;
	await assert.rejects(() => contactService.updateContactWrapper(actor, 1, { name: "After" })); assert.equal(writes, 0);
	reset(); await assert.rejects(() => contactService.updateContactWrapper(actor, 1, { name: "After" }, [3, 5])); assert.equal(writes, 0);
	await contactService.updateContactWrapper(actor, 1, { name: "After" }, [3, 4, 4]);
	assert.deepEqual(contacts[0]!.sectors.map((row: Row) => row.sectorId), [3, 4]);
});
test("contact mutation cannot reactivate or follow a concurrent reassignment", async () => {
	for (const change of [{ isDeleted: true }, { customerId: 88 }, { isOnlyAdmin: true }]) {
		reset(); race = () => Object.assign(contacts[0]!, change);
		await assert.rejects(() => contactService.updateContactWrapper(actor, 1, { name: "After" })); assert.equal(writes, 0);
	}
});
test("adding a sector requires a visible contact and a sector from the same tenant; repeat is idempotent", async () => {
	reset(); await assert.rejects(() => contactService.addSectorToContact(actor, 1, 5)); assert.equal(writes, 0);
	await contactService.addSectorToContact(actor, 1, 4); await contactService.addSectorToContact(actor, 1, 4);
	assert.deepEqual(contacts[0]!.sectors.map((row: Row) => row.sectorId), [3, 4]);
	reset(); contacts[0]!.instance = "fixture-b";
	await assert.rejects(() => contactService.addSectorToContact(actor, 1, 4)); assert.equal(writes, 0);
});
test("registration rejects cross-tenant sector ids before creating or reusing a contact", async () => {
	reset();
	await assert.rejects(() => contactService.createContact("fixture-a", "Fixture", "11987654321", undefined, [5]));
	assert.equal(writes, 0); assert.equal(queries.length, 1);
});
test("operator cannot change someone else's schedule or any cross-tenant/consumed schedule", async () => {
	for (const change of [{ instance: "fixture-b" }, { scheduledBy: 99, scheduledFor: 98 }, { chatId: 123 }]) {
		reset(); Object.assign(schedules[0]!, change);
		await assert.rejects(() => scheduleService.editSchedule(actor, { description: "After" }, "9"));
		await assert.rejects(() => scheduleService.deleteSchedule(actor, "9")); assert.equal(writes, 0);
	}
});
test("schedule creator, recipient and tenant administrator can edit their allowed pending schedule", async () => {
	for (const session of [actor, { ...actor, userId: 8 }, { ...actor, userId: 99, role: "ADMIN" }]) {
		reset(); await scheduleService.editSchedule(session, { description: "After", scheduleDate: "2026-11-01T12:00:00Z" }, "9");
		assert.equal(schedules[0]!.description, "After"); assert.equal(schedules[0]!.scheduledFor, 8);
		await scheduleService.deleteSchedule(session, "9"); assert.equal(schedules.length, 0);
	}
});
test("schedule guard is repeated in the actual write, closing reassignment/worker races", async () => {
	reset(); race = () => { schedules[0]!.scheduledBy = 99; schedules[0]!.scheduledFor = 98; };
	await assert.rejects(() => scheduleService.editSchedule(actor, { description: "After" }, "9")); assert.equal(writes, 0);
	reset(); race = () => { schedules[0]!.chatId = 123; };
	await assert.rejects(() => scheduleService.deleteSchedule(actor, "9")); assert.equal(writes, 0);
});
for (const input of [{ instance: "fixture-b" }, { scheduledBy: 99 }, { scheduledFor: 99 }, { contactId: 99 }, { sectorId: 5 }, { chatId: null }, { scheduleDate: "2026-02-30T12:00:00Z" }, { scheduleDate: "yesterday" }, {}]) {
	test(`schedule rejects unsafe or invalid patch ${JSON.stringify(input)}`, async () => {
		reset(); await assert.rejects(() => scheduleService.editSchedule(actor, input, "9")); assert.equal(writes, 0);
	});
}
test("wallet queries default to self, deny another operator and always use authenticated tenant", async () => {
	reset(); await walletService.getUserWallets(actor);
	assert.equal(queries[0]!["instance"], "fixture-a"); assert.equal(queries[0]!["WppWalletUser"].some.userId, 7);
	await assert.rejects(() => walletService.getUserWallets(actor, "8")); assert.equal(queries.length, 1);
	await walletService.getUserWallets({ ...actor, role: "ADMIN" }, "8"); assert.equal(queries[1]!["instance"], "fixture-a");
	await assert.rejects(() => walletService.getUserWallets(actor, "7 OR 1=1"));
});
