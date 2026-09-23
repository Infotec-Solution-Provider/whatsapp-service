import assert from "node:assert/strict";

async function main() {
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown) => {
		const id = require.resolve(path);
		previous.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
	};
	let queries = 0;
	const rows = [
		{ id: 1, instance: "a", contactId: 42, userId: 7, isFinished: false },
		{ id: 2, instance: "b", contactId: 42, userId: 99, isFinished: false },
		{ id: 3, instance: "a", contactId: 43, userId: 99, isFinished: false },
		{ id: 4, instance: "a", contactId: 42, userId: 8, isFinished: false },
		{ id: 5, instance: "a", contactId: 42, userId: 99, isFinished: true },
	];
	try {
		stub("./prisma.service", { wppChat: { findMany: async (query: any) => {
			queries++;
			assert.equal(query.include, undefined, "must never materialize message/contact relations");
			assert.deepEqual(query.select, { contactId: true, userId: true });
			assert.deepEqual(query.where.contactId.in, [42]);
			assert.deepEqual(query.orderBy, { id: "asc" });
			return rows.filter(row => row.instance === query.where.instance &&
				row.isFinished === query.where.isFinished && query.where.contactId.in.includes(row.contactId))
				.map(({ contactId, userId }) => ({ contactId, userId }));
		} } });
		stub("./customers.service", () => ({ setAuth() {} }));
		stub("./users.service", () => ({ setAuth() {}, getUserById: async (id: number) => ({ NOME: `User ${id}` }) }));
		const Service = (require("./contact-search.service") as typeof import("./contact-search.service")).default;
		const service = new Service("test");
		assert.deepEqual(await service.enrichContacts("a", []), []);
		assert.equal(queries, 0, "empty pages must not query chats");
		const result = await service.enrichContacts("a", [{ id: 42, customerId: null }]);
		assert.equal(result[0]?.chatingWith, "User 8", "only the newest active chat for this tenant and page may enrich the contact");
		assert.equal(queries, 1);
		console.log("contact-search-memory: passed");
	} finally {
		for (const [id, cached] of previous) {
			if (cached) require.cache[id] = cached; else delete require.cache[id];
		}
	}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
