import assert from "node:assert/strict";
import { Prisma, WppContact } from "@prisma/client";

type Contact = WppContact & { sectors: Array<{ contactId: number; sectorId: number }> };
type Query = Record<string, any>;
type ContactsModule = typeof import("./contacts.service");

function contact(overrides: Partial<Contact> = {}): Contact {
	return {
		id: 42, instance: "tenant-a", name: "Nome anterior", phone: "5511987654321",
		whatsappId: "123456789012345@lid", customerId: null, isDeleted: false,
		isBlocked: true, isOnlyAdmin: true, avatarUrl: "https://example.test/avatar.png",
		createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: null,
		lastOutOfHoursReplySentAt: null, conversationExpiration: null,
		sectors: [{ contactId: 42, sectorId: 7 }, { contactId: 42, sectorId: 8 }],
		...overrides
	};
}

function matches(row: Contact, where: Query): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") return (value as Query[]).some((branch) => matches(row, branch));
		if (key === "AND") return (Array.isArray(value) ? value : [value]).every((branch: Query) => matches(row, branch));
		if (key === "NOT") return !matches(row, value);
		const current = (row as unknown as Query)[key];
		if (value !== null && typeof value === "object") {
			return Object.entries(value).every(([operator, comparison]: [string, any]) => {
				if (operator === "in") return comparison.includes(current);
				if (operator === "equals") return current === comparison;
				if (operator === "not") return current !== comparison;
				throw new Error(`Unsupported contact query operator: ${operator}`);
			});
		}
		return current === value;
	});
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
	return new Prisma.PrismaClientKnownRequestError("Simulated registration race", { code, clientVersion: "test" });
}

function fixture(initialRows: Contact[] = []) {
	const rows = structuredClone(initialRows);
	const localWrites: Array<{ instance: string; query: string; values: unknown[] }> = [];
	const updateAttempts: Query[] = [];
	let createdCount = 0;
	let updatedCount = 0;
	let beforeUpdate: (() => void) | undefined;
	let beforeCreate: (() => void) | undefined;
	const applyData = (row: Contact, data: Query): Contact => {
		const { sectors, ...scalars } = data;
		Object.assign(row, structuredClone(scalars));
		if (sectors) {
			if (sectors.deleteMany) row.sectors = [];
			for (const entry of sectors.create ?? []) row.sectors.push({ contactId: row.id, sectorId: entry.sectorId });
		}
		return row;
	};
	const db = {
		wppContact: {
			findFirst: async ({ where }: Query) => structuredClone(rows.find((row) => matches(row, where)) ?? null),
			findUnique: async ({ where }: Query) => structuredClone(rows.find((row) => matches(row, where)) ?? null),
			update: async ({ where, data }: Query) => {
				updateAttempts.push(structuredClone(where));
				if (beforeUpdate) { const hook = beforeUpdate; beforeUpdate = undefined; hook(); }
				const row = rows.find((candidate) => matches(candidate, where));
				if (!row) throw prismaError("P2025");
				updatedCount++;
				return structuredClone(applyData(row, data));
			},
			create: async ({ data }: Query) => {
				if (beforeCreate) { const hook = beforeCreate; beforeCreate = undefined; hook(); }
				if (rows.some((row) => row.instance === data.instance &&
					((data.phone && row.phone === data.phone) || (data.whatsappId && row.whatsappId === data.whatsappId)))) {
					throw prismaError("P2002");
				}
				const row = applyData(contact({ id: 100 + rows.length, sectors: [], isBlocked: false, isOnlyAdmin: false }), data);
				rows.push(row);
				createdCount++;
				return structuredClone(row);
			}
		}
	};
	return {
		rows, db, localWrites, updateAttempts,
		counts: () => ({ created: createdCount, updated: updatedCount }),
		beforeUpdate: (hook: () => void) => { beforeUpdate = hook; },
		beforeCreate: (hook: () => void) => { beforeCreate = hook; }
	};
}

type Fixture = ReturnType<typeof fixture>;

async function withService(rows: Contact[], execute: (service: ContactsModule["default"], f: Fixture, errors: ContactsModule) => Promise<void>): Promise<void> {
	const previous = new Map<string, NodeModule | undefined>();
	const replace = (path: string, exports: unknown) => {
		const resolved = require.resolve(path);
		previous.set(resolved, require.cache[resolved]);
		require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
	};
	const stubDefault = (path: string, value: unknown) => replace(path, { __esModule: true, default: value });
	const f = fixture(rows);
	try {
		// Install all external-service stubs before loading ContactsService. No database,
		// HTTP client, cron or worker is started by this regression suite.
		stubDefault("./prisma.service", f.db);
		stubDefault("./parameters.service", {});
		stubDefault("./instances.service", { executeQuery: async (instance: string, query: string, values: unknown[]) => {
			f.localWrites.push({ instance, query, values });
			return [];
		} });
		const servicePath = require.resolve("./contacts.service");
		previous.set(servicePath, require.cache[servicePath]);
		delete require.cache[servicePath];
		const module = require("./contacts.service") as ContactsModule;
		await execute(module.default, f, module);
	} finally {
		for (const [path, cached] of previous) {
			if (cached) require.cache[path] = cached; else delete require.cache[path];
		}
	}
}

const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, execute: () => Promise<void>) => cases.push([name, execute]);

function assertUnchanged(f: Fixture, expected: Contact[]): void {
	assert.deepEqual(f.rows, expected);
	assert.deepEqual(f.counts(), { created: 0, updated: 0 });
	assert.equal(f.localWrites.length, 0);
}

for (const customerId of [null, 0, -1]) {
	test(`unassigned contact (${customerId}) links to the customer while preserving identity and sectors`, async () => {
		const original = contact({ customerId });
		await withService([original], async (service, f) => {
			const result = await service.createContact("tenant-a", "Nome cadastrado", "11987654321", 81);
			const expected = { ...original, name: "Nome cadastrado", customerId: 81 };
			assert.deepEqual(result, expected);
			assert.deepEqual(f.rows, [expected]);
			assert.deepEqual(f.counts(), { created: 0, updated: 1 });
			assert.ok(f.localWrites.some((write) => write.instance === "tenant-a" && write.values[0] === 42 && write.values[4] === 81));
			assert.equal(f.localWrites.some((write) => /wpp_contact_sectors/.test(write.query)), false);
			const guard = f.updateAttempts[0]!;
			assert.equal(guard["id"], original.id);
			assert.equal(guard["instance"], original.instance);
			assert.equal(guard["isDeleted"], false);
			assert.equal(guard["customerId"], customerId);
		});
	});
}

for (const [storedPhone, enteredPhone] of [
	["5511987654321", "+55 (11) 98765-4321"],
	["551187654321", "(11) 98765-4321"],
	["5511987654321", "11 8765-4321"]
]) {
	test(`formatted or ninth-digit variant ${enteredPhone} reuses the existing identity`, async () => {
		await withService([contact({ phone: storedPhone! })], async (service, f) => {
			const result = await service.createContact("tenant-a", "Novo nome", enteredPhone!, 81);
			assert.equal(result.id, 42);
			assert.equal(result.phone, storedPhone);
			assert.equal(result.whatsappId, "123456789012345@lid");
			assert.equal(f.rows.length, 1);
		});
	});
}

test("phone-shaped WhatsApp identity can be linked without replacing its missing phone", async () => {
	await withService([contact({ phone: null, whatsappId: "5511987654321" })], async (service, f) => {
		const result = await service.createContact("tenant-a", "Novo nome", "11987654321", 81);
		assert.equal(result.id, 42);
		assert.equal(result.phone, null);
		assert.equal(result.whatsappId, "5511987654321");
		assert.deepEqual(f.counts(), { created: 0, updated: 1 });
	});
});

test("an assigned phone owner takes precedence over an unassigned WhatsApp-only identity", async () => {
	const orphan = contact({ id: 41, phone: null, whatsappId: "5511987654321", sectors: [] });
	const phoneOwner = contact({ customerId: 99 });
	await withService([orphan, phoneOwner], async (service, f, errors) => {
		await assert.rejects(service.createContact("tenant-a", "Novo nome", "11987654321", 81), (error: unknown) => {
			assert.ok(error instanceof errors.ContactAlreadyExistsError);
			assert.equal(error.contactId, phoneOwner.id);
			return true;
		});
		assertUnchanged(f, [orphan, phoneOwner]);
	});
});

test("the same explicit sectors in a different order still permit direct customer linkage", async () => {
	const original = contact();
	await withService([original], async (service, f) => {
		const result = await service.createContact("tenant-a", "Novo nome", "11987654321", 81, [8, 7, 8]);
		assert.equal(result.customerId, 81);
		assert.deepEqual(f.rows[0]!.sectors, original.sectors);
		assert.equal(f.localWrites.some((write) => /wpp_contact_sectors/.test(write.query)), false);
	});
});

test("explicit empty sectors can link a global contact", async () => {
	await withService([contact({ sectors: [] })], async (service, f) => {
		assert.equal((await service.createContact("tenant-a", "Novo nome", "11987654321", 81, [])).customerId, 81);
		assert.deepEqual(f.rows[0]!.sectors, []);
	});
});

for (const requestedSectors of [[], [7], [7, 8, 9], [9]]) {
	test(`changing sectors to ${JSON.stringify(requestedSectors)} requires explicit overwrite`, async () => {
		const original = contact();
		await withService([original], async (service, f, errors) => {
			await assert.rejects(service.createContact("tenant-a", "Novo nome", "11987654321", 81, requestedSectors), errors.ContactAlreadyExistsError);
			assertUnchanged(f, [original]);
		});
	});
}

test("adding sectors to an existing global contact requires explicit overwrite", async () => {
	const original = contact({ sectors: [] });
	await withService([original], async (service, f, errors) => {
		await assert.rejects(service.createContact("tenant-a", "Novo nome", "11987654321", 81, [7]), errors.ContactAlreadyExistsError);
		assertUnchanged(f, [original]);
	});
});

for (const requestedCustomer of [81, 82, undefined]) {
	test(`an assigned contact cannot be registered again for customer ${requestedCustomer}`, async () => {
		const original = contact({ customerId: 81 });
		await withService([original], async (service, f, errors) => {
			await assert.rejects(service.createContact("tenant-a", "Novo nome", "11987654321", requestedCustomer), (error: unknown) => {
				assert.ok(error instanceof errors.ContactAlreadyExistsError);
				assert.equal(error.contactId, 42);
				assert.equal(error.isDeleted, false);
				return true;
			});
			assertUnchanged(f, [original]);
		});
	});
}

for (const requestedCustomer of [undefined, 0, -1]) {
	test(`an existing unassigned contact remains a duplicate without a positive customer (${requestedCustomer})`, async () => {
		const original = contact();
		await withService([original], async (service, f, errors) => {
			await assert.rejects(service.createContact("tenant-a", "Novo nome", "11987654321", requestedCustomer), errors.ContactAlreadyExistsError);
			assertUnchanged(f, [original]);
		});
	});
}

for (const overwrite of [false, true]) {
	test(`a deleted contact is never automatically reactivated (overwrite=${overwrite})`, async () => {
		const original = contact({ isDeleted: true });
		await withService([original], async (service, f, errors) => {
			await assert.rejects(service.createContact("tenant-a", "Novo nome", "11987654321", 81, undefined, overwrite), (error: unknown) => {
				assert.ok(error instanceof errors.ContactAlreadyExistsError || error instanceof errors.DeletedContactConflictError);
				assert.equal(error.contactId, 42);
				assert.equal(error.isDeleted, true);
				return true;
			});
			assertUnchanged(f, [original]);
		});
	});
}

test("authorized overwrite preserves the existing customer and sector replacement flow", async () => {
	await withService([contact({ customerId: 80 })], async (service, f) => {
		const result = await service.createContact("tenant-a", "Nome autorizado", "11987654321", 81, [9, 9], true);
		assert.equal(result.id, 42);
		assert.equal(result.name, "Nome autorizado");
		assert.equal(result.customerId, 81);
		assert.deepEqual(f.rows[0]!.sectors, [{ contactId: 42, sectorId: 9 }]);
		assert.deepEqual(f.counts(), { created: 0, updated: 1 });
	});
});

test("an unfamiliar number follows normal creation with normalized phone and selected sectors", async () => {
	await withService([], async (service, f) => {
		const result = await service.createContact("tenant-a", "Novo contato", "+55 (11) 98765-4321", 81, [7, 8]);
		assert.equal(result.name, "Novo contato");
		assert.equal(result.phone, "5511987654321");
		assert.equal(result.whatsappId, "5511987654321");
		assert.equal(result.customerId, 81);
		assert.deepEqual(f.rows[0]!.sectors.map((sector) => sector.sectorId), [7, 8]);
		assert.deepEqual(f.counts(), { created: 1, updated: 0 });
	});
});

test("a contact in another tenant does not block creation or expose its registration", async () => {
	const original = contact({ instance: "tenant-b", customerId: 80 });
	await withService([original], async (service, f) => {
		const result = await service.createContact("tenant-a", "Novo contato", "11987654321", 81);
		assert.notEqual(result.id, original.id);
		assert.equal(result.instance, "tenant-a");
		assert.deepEqual(f.rows[0], original);
		assert.deepEqual(f.counts(), { created: 1, updated: 0 });
	});
});

for (const concurrentChange of [{ customerId: 99 }, { isDeleted: true }]) {
	test(`concurrent ${JSON.stringify(concurrentChange)} prevents stale automatic linkage`, async () => {
		const original = contact();
		await withService([original], async (service, f, errors) => {
			f.beforeUpdate(() => { Object.assign(f.rows[0]!, concurrentChange); });
			await assert.rejects(service.createContact("tenant-a", "Nome atrasado", "11987654321", 81), (error: unknown) => {
				assert.ok(error instanceof errors.ContactAlreadyExistsError || error instanceof errors.DeletedContactConflictError);
				assert.equal(error.contactId, 42);
				assert.equal(error.isDeleted, !!concurrentChange.isDeleted);
				return true;
			});
			assertUnchanged(f, [{ ...original, ...concurrentChange }]);
		});
	});
}

test("a P2002 race with a new unassigned contact reuses the winner without creating a duplicate", async () => {
	await withService([], async (service, f) => {
		const winner = contact();
		f.beforeCreate(() => { f.rows.push(winner); });
		const result = await service.createContact("tenant-a", "Nome cadastrado", "11987654321", 81);
		assert.equal(result.id, winner.id);
		assert.deepEqual(f.rows, [{ ...contact(), name: "Nome cadastrado", customerId: 81 }]);
		assert.deepEqual(f.counts(), { created: 0, updated: 1 });
	});
});

for (const overwrite of [false, true]) {
	test(`a P2002 race cannot transfer a concurrently assigned contact (overwrite=${overwrite})`, async () => {
		await withService([], async (service, f, errors) => {
			const winner = contact({ customerId: 99 });
			f.beforeCreate(() => { f.rows.push(structuredClone(winner)); });
			await assert.rejects(service.createContact("tenant-a", "Nome atrasado", "11987654321", 81, [9], overwrite), errors.ContactAlreadyExistsError);
			assertUnchanged(f, [winner]);
		});
	});
}

test("a P2002 race cannot reactivate a concurrently deleted contact", async () => {
	await withService([], async (service, f, errors) => {
		const winner = contact({ isDeleted: true });
		f.beforeCreate(() => { f.rows.push(structuredClone(winner)); });
		await assert.rejects(service.createContact("tenant-a", "Nome atrasado", "11987654321", 81, undefined, true), (error: unknown) => {
			assert.ok(error instanceof errors.ContactAlreadyExistsError || error instanceof errors.DeletedContactConflictError);
			assert.equal(error.isDeleted, true);
			return true;
		});
		assertUnchanged(f, [winner]);
	});
});

async function run(): Promise<void> {
	for (const [name, execute] of cases) { await execute(); console.log(`PASS ${name}`); }
	console.log(`${cases.length} contact registration tests passed (isolated; no database or HTTP requests).`);
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
