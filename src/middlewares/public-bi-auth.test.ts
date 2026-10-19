import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import authService from "../services/auth.service";
import publicBiAuthenticated, {
	createPublicBiServiceTokenGuard, isPublicBiReadRoute, parsePublicBiCredentials, PublicBiServiceCredential
} from "./public-bi-auth.middleware";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

const tokenA = `bi1_${"a".repeat(43)}`; // synthetic fixture, not a real credential
const tokenB = `bi1_${"b".repeat(43)}`;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const credential: PublicBiServiceCredential = { id: "etl", instance: "tenant-a", sha256: hash(tokenA), expiresAt: "2030-01-01T00:00:00Z" };
let config = [credential];
let failConfig = false;
let normalAuthCalls = 0;
let protectedWriteCalls = 0;
const originalAuth = authService.fetchSessionData.bind(authService);
authService.fetchSessionData = async (token: string) => {
	normalAuthCalls++;
	assert.equal(token, "Bearer ordinary-jwt-fixture");
	return { instance: "normal-tenant", userId: 7, sectorId: 2, role: "USER", name: "Fixture" };
};

const app = express();
app.use(createPublicBiServiceTokenGuard(async () => {
	if (failConfig) throw new Error("unreadable config fixture");
	return parsePublicBiCredentials(config);
}, () => Date.parse("2026-10-19T12:00:00Z")));
app.get("/api/whatsapp/users", publicBiAuthenticated, (req, res) => {
	res.json({ instance: req.session.instance, userId: req.session.userId, role: req.session.role, databaseTenant: currentDatabaseTenant() });
});
app.post("/api/whatsapp/users", (_req, res) => { protectedWriteCalls++; res.sendStatus(200); });
app.get("/api/whatsapp/messages/1", (_req, res) => { protectedWriteCalls++; res.sendStatus(200); });

async function run() {
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>(resolve => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	const request = (token = tokenA, path = "/api/whatsapp/users", method = "GET") => fetch(`${origin}${path}`, {
		method, headers: { Authorization: `Bearer ${token}`, "X-Tenant": "tenant-b" }
	});
	try {
		const good = await request(tokenA, "/api/whatsapp/users?instance=tenant-b&userId=999");
		assert.equal(good.status, 200);
		assert.deepEqual(await good.json(), { instance: "tenant-a", userId: 0, role: "BI_READ_ONLY", databaseTenant: "tenant-a" });
		assert.equal(normalAuthCalls, 0);
		assert.equal((await request(tokenB)).status, 401);
		assert.equal((await request("bi1_short")).status, 401);
		assert.equal((await request(tokenA, "/api/whatsapp/users", "POST")).status, 403);
		assert.equal((await request(tokenA, "/api/whatsapp/users", "HEAD")).status, 403);
		assert.equal((await request(tokenA, "/api/whatsapp/messages/1")).status, 403);
		assert.equal(protectedWriteCalls, 0);
		config = [{ ...credential, expiresAt: "2026-10-19T12:00:00Z" }];
		assert.equal((await request()).status, 401);
		config = [{ ...credential, disabled: true }];
		assert.equal((await request()).status, 401);
		config = [credential, { ...credential, sha256: hash(tokenB) }];
		assert.equal((await request(tokenB)).status, 200); // overlap during rotation
		config = [{ ...credential, sha256: hash(tokenB) }];
		assert.equal((await request(tokenA)).status, 401); // immediate revocation
		assert.equal((await request(tokenB)).status, 200);
		config = [];
		assert.equal((await request(tokenB)).status, 401);
		failConfig = true;
		assert.equal((await request()).status, 503);
		const normal = await request("ordinary-jwt-fixture");
		assert.equal(normal.status, 200); // broken optional config does not affect ordinary user authentication
		assert.deepEqual(await normal.json(), { instance: "normal-tenant", userId: 7, role: "USER", databaseTenant: "normal-tenant" });
		assert.equal(normalAuthCalls, 1);
		assert.equal((await fetch(`${origin}/api/whatsapp/users`)).status, 401);
		assert.throws(() => parsePublicBiCredentials([{ ...credential, sha256: "plain-text-secret" }]), /Invalid/);
		assert.throws(() => parsePublicBiCredentials([credential, credential]), /Invalid/);
		assert.throws(() => parsePublicBiCredentials([credential, { ...credential, sha256: hash(tokenB), instance: "tenant-b" }]), /Invalid/);
		assert.throws(() => parsePublicBiCredentials([{ ...credential, expiresAt: "2030-01-01" }]), /Invalid/);
		for (const path of ["/api/whatsapp/conversations", "/api/whatsapp/conversations/123", "/api/whatsapp/conversations/123/messages", "/api/whatsapp/messages/export", "/api/whatsapp/transfers", "/api/whatsapp/sectors"]) {
			assert.equal(isPublicBiReadRoute("GET", path), true, path);
			assert.equal(isPublicBiReadRoute("POST", path), false, path);
		}
		assert.equal(isPublicBiReadRoute("GET", "/api/whatsapp/conversations/1/messages/extra"), false);
		assert.equal(isPublicBiReadRoute("GET", "/api/whatsapp/conversations/../users"), false);
		assert.equal(isPublicBiReadRoute("GET", "/api/internal/whatsapp/chats/1"), false);
		console.log("public-bi-auth: HTTP read-only scope, tenant isolation, expiry, rotation, revocation and user auth passed");
	} finally {
		authService.fetchSessionData = originalAuth;
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
