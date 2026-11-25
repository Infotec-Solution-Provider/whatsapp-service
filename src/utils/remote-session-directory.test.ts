import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
import { Logger } from "@in.pulse-crm/utils";
import { currentDatabaseTenant, withDatabaseTenant } from "./database-tenant-context";
import { pickClientSession } from "./remote-session-directory";

const shadow = { sessionId: "nunes", clientId: 2, monitorRole: "SHADOW", isDefault: false };
const primary = { sessionId: "nunes_zapo", clientId: 2, monitorRole: "PRIMARY", isDefault: true };

test("prefers PRIMARY, then the default session, then the first match", () => {
	// wwebjs-api lists sessions by session_id: the shadow comes first after a swap.
	assert.equal(pickClientSession([shadow, primary], 2)?.sessionId, "nunes_zapo");
	assert.equal(
		pickClientSession([{ ...shadow, isDefault: false }, { ...primary, monitorRole: "SHADOW", isDefault: true }], 2)?.sessionId,
		"nunes_zapo"
	);
	assert.equal(
		pickClientSession([{ sessionId: "a", clientId: 2 }, { sessionId: "b", clientId: 2 }], 2)?.sessionId,
		"a",
		"older remotes without role/default keep the first match"
	);
	assert.equal(pickClientSession([shadow, primary], 3), undefined);
	assert.equal(pickClientSession(undefined, 2), undefined);
	assert.equal(pickClientSession([shadow, primary])?.sessionId, "nunes_zapo", "without clientId picks among all");
});

test("the session poller reads the PRIMARY session, not the shadow listed first", async (t) => {
	const resolved = require.resolve("../services/prisma.service");
	const previous = require.cache[resolved];
	const servicePath = require.resolve("../services/remote-session-monitor.service");
	const previousService = require.cache[servicePath];
	const recorded: Array<{ clientId: number; state: string }> = [];
	require.cache[resolved] = {
		id: resolved, filename: resolved, loaded: true,
		exports: {
			__esModule: true,
			default: {
				wppClient: { findFirst: async () => ({ remoteClientUrl: "http://wwebjs:728" }) },
				wppClientSessionSnapshot: { updateMany: async () => ({ count: 1 }) }
			}
		}
	} as NodeModule;
	delete require.cache[servicePath];
	const originalRequest = axios.request;
	const requested: string[] = [];
	(axios as unknown as { request: unknown }).request = async ({ url }: { url: string }) => {
		requested.push(url);
		if (url === "/api/sessions") return { data: { sessions: [shadow, primary] } };
		return { data: { state: url.includes("nunes_zapo") ? "CONNECTED" : "DISCONNECTED", observedAt: new Date().toISOString() } };
	};
	t.after(() => {
		(axios as unknown as { request: unknown }).request = originalRequest;
		if (previous) require.cache[resolved] = previous; else delete require.cache[resolved];
		if (previousService) require.cache[servicePath] = previousService; else delete require.cache[servicePath];
	});
	const monitor = (require("../services/remote-session-monitor.service") as typeof import("../services/remote-session-monitor.service")).default;
	(monitor as unknown as { recordSnapshot: unknown }).recordSnapshot = async (clientId: number, session: { state: string }) => {
		recorded.push({ clientId, state: session.state });
	};
	await monitor.refreshClient(2);
	assert.deepEqual(requested, ["/api/sessions", "/api/sessions/nunes_zapo/session/info"]);
	assert.deepEqual(recorded, [{ clientId: 2, state: "CONNECTED" }]);
});

test("polling keeps the session tenant through refresh and updates when a peer database is unavailable", async (t) => {
	const saved = new Map<string, NodeModule | undefined>();
	function stub(path: string, exports: unknown) {
		const id = require.resolve(path);
		saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	}
	const monitorPath = require.resolve("../services/remote-session-monitor.service");
	saved.set(monitorPath, require.cache[monitorPath]);
	delete require.cache[monitorPath];
	t.after(() => {
		for (const [id, module] of saved) {
			if (module) require.cache[id] = module;
			else delete require.cache[id];
		}
	});
	let native = true;
	const id = 42;
	const enumerated: Array<string | undefined> = [];
	const refreshed: Array<string | null> = [];
	const observed: Array<string | null> = [];
	const failures: Array<string | null> = [];
	stub("../tenant-sql/registry", { tenantSqlEnabled: () => native });
	stub("../tenant-sql/router", { tenantSqlInstanceNames: () => ["homolog", "infotec", "suprimaxxi"] });
	stub("../services/prisma.service", { __esModule: true, default: {
		wppClient: {
			findMany: async ({ where }: { where: { instance?: string } }) => {
				enumerated.push(where.instance);
				if (native && (!where.instance || where.instance === "homolog")) throw new Error("Database unavailable");
				return [{ id, instance: where.instance ?? "legacy" }];
			},
			findFirst: async () => {
				const tenant = currentDatabaseTenant();
				refreshed.push(tenant);
				return { remoteClientUrl: `http://${tenant ?? "legacy"}:728` };
			}
		},
		wppClientSessionSnapshot: { updateMany: async () => { failures.push(currentDatabaseTenant()); return { count: 1 }; } }
	} });
	const errors = t.mock.method(Logger, "error", () => {});
	t.mock.method(axios, "request", async ({ url, baseURL }: { url: string; baseURL: string }) => {
		if (url === "/api/sessions") return { data: { sessions: [] } };
		if (baseURL.includes("suprimaxxi")) throw new Error("Remote unavailable");
		return { data: { state: "CONNECTED", observedAt: new Date().toISOString() } };
	});
	const monitor = (require("../services/remote-session-monitor.service") as typeof import("../services/remote-session-monitor.service")).default;
	t.mock.method(monitor, "recordSnapshot", async () => { observed.push(currentDatabaseTenant()); });

	await monitor.pollAll();
	assert.deepEqual(enumerated, ["homolog", "infotec", "suprimaxxi"]);
	assert.deepEqual(refreshed, ["infotec", "suprimaxxi"]);
	assert.deepEqual(observed, ["infotec"]);
	assert.deepEqual(failures, ["suprimaxxi"]);
	assert.match(String(errors.mock.calls[0]?.arguments[0]), /homolog.*Database unavailable/);

	await withDatabaseTenant("infotec", () => monitor.pollAll());
	assert.deepEqual(enumerated.slice(3), ["infotec"]);
	assert.equal(observed.at(-1), "infotec");
	assert.equal(currentDatabaseTenant(), null);

	native = false;
	await monitor.pollAll();
	assert.equal(enumerated.at(-1), undefined);
	assert.equal(observed.at(-1), null);
});
