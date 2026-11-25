import assert from "node:assert/strict";
import test from "node:test";

test("startup loads active clients from healthy tenants when another database is unavailable", async () => {
	const saved = new Map<string, NodeModule | undefined>();
	function stub(path: string, exports: unknown) {
		const id = require.resolve(path);
		saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	}
	class RuntimeClient {
		constructor(readonly id: number, readonly instance: string) {}
	}
	const reads: Array<string | undefined> = [];
	const errors: string[] = [];
	let native = true;
	stub("@in.pulse-crm/utils", {
		Logger: { error: (message: string) => errors.push(message) },
		sanitizeErrorMessage: (error: Error) => error.message
	});
	for (const dependency of [
		"../adapters/template.adapter", "../utils/processing-logger", "../utils/file-upload-trace",
		"../whatsapp-client/gupshup-whatsapp-client", "../whatsapp-client/waba-whatsapp-client", "../whatsapp-client/wwebjs-whatsapp-client",
		"./files.service", "./instances.service", "./internal-chats.service", "./messages-distribution.service",
		"./messages.service", "./contacts.service", "./ready-messages.service", "./human-behavior-config.service",
		"./operator-pause-admission.runtime"
	]) stub(dependency, {});
	stub("../whatsapp-client/remote-whatsapp-client", { __esModule: true, default: RuntimeClient });
	stub("../tenant-sql/registry", { tenantSqlEnabled: () => native });
	stub("../tenant-sql/router", { tenantSqlInstanceNames: () => ["homolog", "infotec", "suprimaxxi"] });
	stub("./prisma.service", { __esModule: true, default: { wppClient: {
		findMany: async ({ where }: { where: { instance?: string; isActive: boolean } }) => {
			assert.equal(where.isActive, true);
			reads.push(where.instance);
			if (native && (!where.instance || where.instance === "homolog")) throw new Error("Database unavailable");
			const id = where.instance === "infotec" ? 2_000_000_003 : where.instance ? 12 : 14;
			return [{ id, instance: where.instance ?? "legacy", type: "REMOTE", name: "Fixture", isActive: true }];
		}
	} } });

	try {
		const service = (require("./whatsapp.service") as typeof import("./whatsapp.service")).default;
		await service.buildClients();
		assert.deepEqual(reads, ["homolog", "infotec", "suprimaxxi"]);
		assert.deepEqual(errors, ["Falha ao carregar canais da empresa homolog: Database unavailable"]);
		assert.equal(service.getClient(2_000_000_003)?.instance, "infotec");
		assert.equal(service.getClient(12)?.instance, "suprimaxxi");

		native = false;
		await service.buildClients();
		assert.equal(reads.at(-1), undefined);
		assert.equal(service.getClient(14)?.instance, "legacy");
	} finally {
		delete require.cache[require.resolve("./whatsapp.service")];
		for (const [path, original] of saved) {
			if (original) require.cache[path] = original;
			else delete require.cache[path];
		}
	}
});
