import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
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
