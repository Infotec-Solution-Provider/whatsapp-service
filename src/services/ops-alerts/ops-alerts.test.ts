import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadOpsAlertsConfig, parseNotifyTargets } from "./ops-alerts.config";
import { formatOpsAlert, OPS_ALERT_MAX_LENGTH } from "./ops-alerts.format";
import { OpsAlertsMonitor } from "./ops-alerts.monitor";
import { OpsAlertsService, opsAlertKey } from "./ops-alerts.service";
import type { OpsAlertInput, OpsAlertsConfig } from "./ops-alerts.types";
import { WhatsappAlertSender, type AlertSenderHttp } from "./whatsapp-alert-sender";

const MIN = 60_000;

function config(overrides: Partial<OpsAlertsConfig> = {}): OpsAlertsConfig {
	return {
		...loadOpsAlertsConfig({}),
		stateFile: path.join(os.tmpdir(), `ops-alerts-test-${process.pid}-${Math.random().toString(16).slice(2)}`, "state.json"),
		...overrides
	};
}

function harness(overrides: Partial<OpsAlertsConfig> = {}) {
	let now = Date.parse("2026-10-06T17:35:08.000Z");
	const sent: string[] = [];
	const notified: Array<{ title: string; text: string }> = [];
	const logs: Array<Record<string, unknown>> = [];
	const cfg = config(overrides);
	const service = new OpsAlertsService(
		cfg,
		{
			log: (entry) => logs.push(entry),
			notify: (title, text) => notified.push({ title, text }),
			whatsapp: (text) => sent.push(text)
		},
		() => now
	);
	return {
		service, sent, notified, logs, cfg,
		advance: (ms: number) => { now += ms; },
		now: () => now
	};
}

const failed = (extra: Partial<OpsAlertInput> = {}): OpsAlertInput => ({
	type: "SEND_FAILED", severity: "high", instance: "nunes", clientId: 2, summary: "Falha no envio ao grupo",
	refs: { internalMessageId: 76897, jobId: "356" }, ...extra
});

test("config defaults need no .env and parse overrides", () => {
	const cfg = loadOpsAlertsConfig({});
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.dedupWindowMs, 600_000);
	assert.equal(cfg.maxPerHour, 20);
	assert.equal(cfg.whatsappMode, "auto");
	assert.equal(cfg.senderUrl, "http://127.0.0.1:7290");
	assert.equal(cfg.whatsappTo, "555184449218");
	assert.deepEqual([...cfg.excludedClientIds], [1, 9, 10]);
	assert.deepEqual(cfg.notifyTargets, [{ instance: "exatron", userId: 38 }]);
	assert.equal(cfg.stateFile, path.join(process.cwd(), "data", "ops-alerts-state.json"));
	const custom = loadOpsAlertsConfig({ OPS_ALERTS_ENABLED: "false", OPS_ALERTS_WHATSAPP: "OFF", OPS_ALERTS_MAX_PER_HOUR: "abc" });
	assert.equal(custom.enabled, false);
	assert.equal(custom.whatsappMode, "off");
	assert.equal(custom.maxPerHour, 20, "invalid numbers fall back to the default");
	assert.deepEqual(parseNotifyTargets("exatron:38, nunes:7,bad,x:0"), [
		{ instance: "exatron", userId: 38 },
		{ instance: "nunes", userId: 7 }
	]);
});

test("format matches the agreed PT-BR layout, ids only, Sao Paulo time, ≤ 600 chars", () => {
	const text = formatOpsAlert(
		{
			type: "SEND_SLOW", severity: "warn", instance: "nunes", clientId: 2, sessionId: "nunes_zapo", summary: "",
			refs: { library: "ZAPO", fallback: false, internalMessageId: 76897, jobId: "356", durationMs: 66_000, firstAttemptAt: "2026-10-06T17:35:08.000Z" }
		},
		{ now: new Date("2026-10-06T17:36:00.000Z"), slowSendMs: 20_000, dedupWindowMs: 600_000, suppressed: 3 }
	);
	assert.equal(
		text,
		[
			"[AVISO] nunes · Envio lento (>20 s)",
			"Sessão nunes_zapo (ZAPO, principal) · cliente 2",
			"Mensagem interna 76897 · job 356",
			"Duração 66 s · 1ª tentativa 14:35:08",
			"+3 ocorrências em 10 min",
			"in.pulse monitor · 06/10 14:36"
		].join("\n")
	);
	const phoneLike = formatOpsAlert(
		{ ...failed(), sessionId: "5551999999999@s.whatsapp.net", summary: "x".repeat(2_000) },
		{ now: new Date(), slowSendMs: 20_000, dedupWindowMs: 600_000 }
	);
	assert.ok(!phoneLike.includes("5551999999999"), "phone-like identifiers are dropped");
	assert.ok(phoneLike.length <= OPS_ALERT_MAX_LENGTH);
	assert.ok(phoneLike.startsWith("[CRÍTICO] nunes · Falha no envio"));
});

test("first occurrence is sent at once; repeats are summarized after the window", () => {
	const h = harness();
	h.service.emit(failed());
	assert.equal(h.sent.length, 1);
	assert.equal(h.notified.length, 1);
	assert.ok(h.notified[0]!.title.startsWith("[CRÍTICO] nunes"));
	for (let i = 0; i < 3; i += 1) h.service.emit(failed());
	assert.equal(h.sent.length, 1, "repeats inside the window are counted, not sent");
	h.advance(5 * MIN);
	h.service.tick();
	assert.equal(h.sent.length, 1);
	h.advance(5 * MIN);
	h.service.tick();
	assert.equal(h.sent.length, 2);
	assert.match(h.sent[1]!, /\+3 ocorrências em 10 min/);
	h.service.tick();
	assert.equal(h.sent.length, 2, "summary is sent once");
	// Other keys are independent.
	h.service.emit(failed({ clientId: 11, instance: "exatron" }));
	assert.equal(h.sent.length, 3);
	assert.equal(opsAlertKey(failed()), "nunes:SEND_FAILED:2");
	assert.ok(h.logs.some((entry) => entry["event"] === "suppressed"), "suppressed events are logged too");
});

test("a repeat after an expired window carries the pending count", () => {
	const h = harness();
	h.service.emit(failed());
	h.service.emit(failed());
	h.advance(11 * MIN);
	h.service.emit(failed());
	assert.equal(h.sent.length, 2);
	assert.match(h.sent[1]!, /\+1 ocorrências em 10 min/);
});

test("global hourly cap folds the overflow into one digest", () => {
	const h = harness({ maxPerHour: 3 });
	for (let client = 20; client < 26; client += 1) h.service.emit(failed({ clientId: client }));
	assert.equal(h.sent.length, 3);
	h.service.tick();
	assert.equal(h.sent.length, 3, "still capped");
	h.advance(61 * MIN);
	h.service.tick();
	assert.equal(h.sent.length, 4);
	assert.match(h.sent[3]!, /^\[RESUMO\] in\.pulse · 3 alertas acima do limite \(3\/h\)/);
	assert.match(h.sent[3]!, /SEND_FAILED nunes ×3/);
	h.service.tick();
	assert.equal(h.sent.length, 4, "one digest");
});

test("open criticals: no repeats, reminders every 30 min (max 3), RESOLVED once", () => {
	const h = harness();
	const down: OpsAlertInput = { type: "SESSION_DOWN", severity: "critical", instance: "nunes", clientId: 2, summary: "Estado DISCONNECTED há 200 s" };
	h.service.emit(down);
	assert.equal(h.sent.length, 1);
	assert.ok(h.service.isOpen(down));
	h.service.emit(down);
	h.advance(15 * MIN);
	h.service.tick();
	assert.equal(h.sent.length, 1, "repeats of an open critical are silent");
	for (let i = 0; i < 5; i += 1) {
		h.advance(30 * MIN);
		h.service.tick();
	}
	const reminders = h.sent.filter((text) => text.includes("Lembrete"));
	assert.equal(reminders.length, 3);
	assert.match(reminders[2]!, /Lembrete 3\/3/);
	h.service.emit({ ...down, severity: "resolved", summary: "Sessão conectada novamente" });
	h.service.emit({ ...down, severity: "resolved", summary: "Sessão conectada novamente" });
	const resolved = h.sent.filter((text) => text.startsWith("[RESOLVIDO]"));
	assert.equal(resolved.length, 1);
	assert.equal(h.service.isOpen(down), false);
	// A new outage after RESOLVED alerts again immediately.
	h.advance(MIN);
	h.service.emit(down);
	assert.ok(h.sent.at(-1)!.startsWith("[CRÍTICO] nunes · Sessão fora do ar"));
});

test("scope: excluded clients and clients outside the connected set never alert", () => {
	const h = harness();
	h.service.emit(failed({ clientId: 9 }));
	assert.equal(h.sent.length, 0);
	h.service.setScope(new Map([[2, { instance: "nunes" }]]));
	h.service.emit(failed({ clientId: 3 }));
	assert.equal(h.sent.length, 0);
	h.service.emit(failed({ clientId: 2 }));
	assert.equal(h.sent.length, 1);
	assert.equal(h.service.recent().length, 1, "only in-scope alerts are buffered");
});

test("disabled service and throwing channels never break the caller", () => {
	const off = harness({ enabled: false });
	off.service.emit(failed());
	assert.equal(off.sent.length, 0);
	const broken = new OpsAlertsService(config(), {
		log: () => { throw new Error("log"); },
		notify: () => { throw new Error("notify"); },
		whatsapp: () => { throw new Error("wa"); }
	});
	assert.doesNotThrow(() => broken.emit(failed()));
	assert.doesNotThrow(() => broken.tick());
});

test("buffer is bounded", () => {
	const h = harness({ bufferSize: 5 } as Partial<OpsAlertsConfig>);
	for (let i = 0; i < 12; i += 1) h.service.emit(failed());
	assert.equal(h.service.recent().length, 5);
});

test("state file: atomic persist, reload, tolerate missing and corrupt files", async () => {
	const h = harness();
	h.service.loadState();
	h.service.emit(failed());
	h.service.emit(failed());
	h.service.setCursor("operator-terminal", 123);
	h.service.markSeen("op-1");
	await h.service.persist();
	const stored = JSON.parse(fs.readFileSync(h.cfg.stateFile, "utf8"));
	assert.equal(stored.version, 1);
	assert.equal(stored.keys["nunes:SEND_FAILED:2"].suppressed, 1);
	assert.deepEqual(fs.readdirSync(path.dirname(h.cfg.stateFile)), ["state.json"], "no temp file left");

	const reloaded = new OpsAlertsService(h.cfg, { log() {}, notify() {}, whatsapp() {} }, h.now);
	reloaded.loadState();
	assert.equal(reloaded.getCursor("operator-terminal"), 123);
	assert.equal(reloaded.hasSeen("op-1"), true);
	const sent: string[] = [];
	const after = new OpsAlertsService(h.cfg, { log() {}, notify() {}, whatsapp: (text) => sent.push(text) }, h.now);
	after.loadState();
	after.emit(failed());
	assert.equal(sent.length, 0, "dedup window survives a restart");

	fs.writeFileSync(h.cfg.stateFile, "{not json");
	const logs: Array<Record<string, unknown>> = [];
	const corrupt = new OpsAlertsService(h.cfg, { log: (entry) => logs.push(entry), notify() {}, whatsapp() {} });
	assert.doesNotThrow(() => corrupt.loadState());
	assert.equal(corrupt.getCursor("operator-terminal"), null);
	assert.ok(logs.some((entry) => entry["event"] === "state-ignored"));

	const missing = new OpsAlertsService(config(), { log: (entry) => logs.push(entry), notify() {}, whatsapp() {} });
	assert.doesNotThrow(() => missing.loadState());
	fs.rmSync(path.dirname(h.cfg.stateFile), { recursive: true, force: true });
});

test("state file: a shutdown flush during an async persist never shares its temp file", async () => {
	const h = harness();
	h.service.loadState();
	h.service.setCursor("operator-terminal", 1);
	const inFlight = h.service.persist();
	h.service.setCursor("operator-terminal", 2);
	h.service.stop();
	await inFlight;
	const stored = JSON.parse(fs.readFileSync(h.cfg.stateFile, "utf8"));
	assert.equal(stored.cursors["operator-terminal"], 2, "the final flush wins");
	assert.deepEqual(fs.readdirSync(path.dirname(h.cfg.stateFile)), ["state.json"], "no temp file left");
	fs.rmSync(path.dirname(h.cfg.stateFile), { recursive: true, force: true });
});

// ─── WhatsApp sender ────────────────────────────────────────────────────────

function senderHarness(mode: "auto" | "on" | "off", options: { state?: string; failPost?: boolean; failList?: boolean } = {}) {
	let now = 0;
	const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
	const logs: string[] = [];
	const http: AlertSenderHttp = {
		get: async <T>(url: string) => {
			calls.push({ method: "GET", url });
			if (options.failList) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
			if (url.endsWith("/api/sessions")) {
				return { data: { sessions: [{ sessionId: "alerts", monitorRole: "PRIMARY", isDefault: true, available: true }] } as T };
			}
			return { data: { state: options.state ?? "CONNECTED" } as T };
		},
		post: async <T>(url: string, body: unknown, request: { headers: Record<string, string> }) => {
			calls.push({ method: "POST", url, body, headers: request.headers });
			if (options.failPost) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
			return { data: { jobId: "77", status: "PENDING" } as T };
		}
	};
	const cfg = { ...loadOpsAlertsConfig({}), whatsappMode: mode };
	const sender = new WhatsappAlertSender(cfg, http, (message) => logs.push(message), () => now);
	return { sender, calls, logs, advance: (ms: number) => { now += ms; } };
}

test("auto mode sends only when the dedicated sender session is CONNECTED", async () => {
	const ok = senderHarness("auto");
	assert.equal(await ok.sender.deliver("alerta"), "sent");
	const post = ok.calls.find((call) => call.method === "POST")!;
	assert.equal(post.url, "http://127.0.0.1:7290/api/send-message/jobs");
	assert.deepEqual(post.body, { to: "555184449218", text: "alerta" });
	assert.match(post.headers!["Idempotency-Key"]!, /^ops-alert:[0-9a-f-]{36}$/);
	assert.ok(ok.calls.some((call) => call.url.endsWith("/api/sessions/alerts/session/info")));
	assert.ok(ok.logs.some((line) => line.includes("whatsapp job 77")));

	await ok.sender.deliver("de novo");
	assert.equal(ok.calls.filter((call) => call.method === "GET").length, 2, "health is cached for 60 s");
	ok.advance(61_000);
	await ok.sender.deliver("mais um");
	assert.equal(ok.calls.filter((call) => call.method === "GET").length, 4);

	const qr = senderHarness("auto", { state: "QR_PENDING" });
	assert.equal(await qr.sender.deliver("alerta"), "skipped");
	assert.equal(qr.calls.filter((call) => call.method === "POST").length, 0);
	const down = senderHarness("auto", { failList: true });
	assert.equal(await down.sender.deliver("a"), "skipped");
	down.advance(61_000);
	assert.equal(await down.sender.deliver("b"), "skipped");
	assert.equal(down.logs.filter((line) => line.includes("sender unavailable")).length, 1, "unavailable is logged at most every 30 min");
	down.advance(30 * MIN);
	await down.sender.deliver("c");
	assert.equal(down.logs.filter((line) => line.includes("sender unavailable")).length, 2);
});

test("mode off never calls the sender; mode on skips the health check", async () => {
	const off = senderHarness("off");
	assert.equal(await off.sender.deliver("x"), "skipped");
	off.sender.send("x");
	assert.equal(off.calls.length, 0);
	const on = senderHarness("on", { state: "QR_PENDING" });
	assert.equal(await on.sender.deliver("x"), "sent");
	assert.equal(on.calls.filter((call) => call.method === "GET").length, 0);
});

test("circuit breaker: 5 consecutive failures back off 15 min", async () => {
	const h = senderHarness("on", { failPost: true });
	for (let i = 0; i < 5; i += 1) assert.equal(await h.sender.deliver("x"), "failed");
	assert.equal(await h.sender.deliver("x"), "skipped");
	h.advance(14 * MIN);
	assert.equal(await h.sender.deliver("x"), "skipped");
	assert.equal(h.calls.filter((call) => call.method === "POST").length, 5);
	h.advance(2 * MIN);
	assert.equal(await h.sender.deliver("x"), "failed", "retries after the back-off");
	assert.ok(h.logs.some((line) => line.includes("backing off 15 min")));
	assert.ok(!h.logs.some((line) => line.includes("555184449218") === false && /\d{8,}/.test(line)), "no phone numbers in logs");
});

// ─── Periodic monitor ───────────────────────────────────────────────────────

function monitorHarness() {
	const h = harness();
	const snapshots = new Map<number, Record<string, unknown>>();
	const internalRows: Array<Record<string, unknown>> = [];
	const operatorGroups: Array<Record<string, unknown>> = [];
	const operatorRows: Array<Record<string, unknown>> = [];
	const stormGroups: Array<{ clientId: number; _count: { _all: number } }> = [];
	const connectedEventClients = new Set<number>();
	const db = {
		wppClient: {
			findMany: async () => [...snapshots.entries()].map(([id, snapshot]) => ({
				id, instance: id === 11 ? "exatron" : "nunes", sessionSnapshot: snapshot
			}))
		},
		wppClientSessionEvent: {
			groupBy: async ({ where }: { where: { state?: string; clientId: { in: number[] } } }) =>
				where.state === "DISCONNECTED"
					? stormGroups
					: where.clientId.in.filter((id) => connectedEventClients.has(id)).map((clientId) => ({ clientId, _count: { _all: 1 } }))
		},
		internalMessageProcessingQueue: { findMany: async () => internalRows },
		operatorOutboundSend: {
			groupBy: async () => operatorGroups,
			findMany: async ({ where, skip = 0, take }: { where: { completedAt: { gte: Date } }; skip?: number; take: number }) =>
				operatorRows
					.filter((row) => (row["completedAt"] as Date).getTime() >= where.completedAt.gte.getTime())
					.slice(skip, skip + take)
		}
	};
	const monitor = new OpsAlertsMonitor(h.service, h.cfg, db as never, () => undefined, h.now);
	const at = (msAgo: number) => new Date(h.now() - msAgo);
	const snapshot = (state: string, extra: Record<string, unknown> = {}) => ({
		state, stateChangedAt: at(0), lastConnectedAt: at(10 * MIN), lastDisconnectedAt: null,
		lastObservedAt: at(0), consecutivePollFailures: 0, ...extra
	});
	return { ...h, monitor, snapshots, internalRows, operatorGroups, operatorRows, stormGroups, connectedEventClients, at, snapshot };
}

test("SESSION_DOWN after 180 s (60 s for QR/LOGGED_OUT), RESOLVED when back, scope respected", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("RECONNECTING", { lastDisconnectedAt: m.at(150_000), stateChangedAt: m.at(5_000) }));
	m.snapshots.set(11, m.snapshot("QR_PENDING", { stateChangedAt: m.at(70_000), lastDisconnectedAt: m.at(70_000) }));
	m.snapshots.set(9, m.snapshot("DISCONNECTED", { stateChangedAt: m.at(MIN * 60) }));
	m.snapshots.set(4, m.snapshot("DISCONNECTED", { lastConnectedAt: m.at(48 * 60 * MIN), stateChangedAt: m.at(MIN * 60) }));
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 1, "only exatron QR_PENDING > 60 s; nunes 150 s < 180 s; 9 excluded; 4 not connected in 24 h");
	assert.match(m.sent[0]!, /^\[CRÍTICO\] exatron · Sessão fora do ar\nCliente 11\nEstado QR_PENDING há 70 s/);

	m.advance(40_000);
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 2);
	assert.match(m.sent[1]!, /nunes · Sessão fora do ar/);

	m.snapshots.set(2, m.snapshot("CONNECTED"));
	await m.monitor.runChecks();
	await m.monitor.runChecks();
	assert.equal(m.sent.filter((text) => text.startsWith("[RESOLVIDO] nunes")).length, 1);
});

test("SESSION_DOWN when the remote API stops answering polls", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("CONNECTED", { consecutivePollFailures: 7, lastObservedAt: m.at(4 * MIN) }));
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 1);
	assert.match(m.sent[0]!, /API do WhatsApp sem resposta há 240 s/);
});

test("DISCONNECT_STORM above 10 disconnections in the last hour", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("CONNECTED"));
	m.snapshots.set(11, m.snapshot("CONNECTED"));
	m.stormGroups.push({ clientId: 2, _count: { _all: 11 } }, { clientId: 11, _count: { _all: 10 } });
	await m.monitor.refreshScope();
	await m.monitor.checkDisconnectStorm();
	assert.equal(m.sent.length, 1);
	assert.match(m.sent[0]!, /^\[AVISO\] nunes · Desconexões frequentes[\s\S]*11 desconexões na última hora/);
});

test("QUEUE_BACKLOG for internal and operator items older than 2 min (manual resend restarts the clock)", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("CONNECTED"));
	m.snapshots.set(11, m.snapshot("CONNECTED"));
	m.internalRows.push(
		{ instance: "nunes", createdAt: m.at(5 * MIN), messageData: JSON.stringify({ clientId: 2 }) },
		{ instance: "nunes", createdAt: m.at(9 * MIN), messageData: JSON.stringify({ clientId: 2, lastRetryAt: m.at(30_000).toISOString() }) }
	);
	m.operatorGroups.push({ instance: "exatron", clientId: 11, _count: { _all: 2 }, _min: { createdAt: m.at(3 * MIN) } });
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 2);
	assert.match(m.sent[0]!, /nunes · Fila de envio atrasada[\s\S]*1 envio\(s\) de grupo interno aguardando há mais de 300 s/);
	assert.match(m.sent[1]!, /exatron · Fila de envio atrasada[\s\S]*2 envio\(s\) de operador/);
});

test("operator REMOTE terminal UNKNOWN/FAILED alerts once, never historical rows", async () => {
	const m = monitorHarness();
	m.snapshots.set(11, m.snapshot("CONNECTED"));
	m.operatorRows.push({ id: "old", instance: "exatron", clientId: 11, messageId: 1, remoteJobId: "j1", status: "UNKNOWN", createdAt: m.at(10 * MIN), completedAt: m.at(5 * MIN) });
	m.service.loadState();
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 0, "first run only sets the cursor");
	m.advance(MIN);
	m.operatorRows.push({ id: "new", instance: "exatron", clientId: 11, messageId: 2, remoteJobId: "j2", status: "FAILED", createdAt: m.at(30_000), completedAt: m.at(10_000) });
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 1);
	assert.match(m.sent[0]!, /^\[CRÍTICO\] exatron · Falha no envio\nCliente 11\nMensagem 2 · job j2\nEnvio de operador falhou/);
	m.advance(MIN);
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 1, "rows already alerted are skipped");
	fs.rmSync(path.dirname(m.cfg.stateFile), { recursive: true, force: true });
});

test("SESSION_DOWN fires once during a reconnect loop that moves lastDisconnectedAt every few seconds", async () => {
	const m = monitorHarness();
	const lastConnectedAt = m.at(10 * MIN);
	let firedAt: number | null = null;
	const start = m.now();
	for (let step = 0; step < 20; step += 1) {
		// Baileys: DISCONNECTED -> 5 s -> RECONNECTING -> socket closes again -> DISCONNECTED ...
		m.snapshots.set(2, m.snapshot(step % 2 ? "RECONNECTING" : "DISCONNECTED", {
			lastConnectedAt, lastDisconnectedAt: m.at(5_000), stateChangedAt: m.at(step % 2 ? 0 : 5_000)
		}));
		await m.monitor.runChecks();
		if (firedAt === null && m.sent.length) firedAt = m.now() - start;
		m.advance(30_000);
	}
	assert.equal(m.sent.filter((text) => text.includes("Sessão fora do ar")).length, 1, "one critical, no repeats");
	assert.ok(firedAt !== null && firedAt <= 4 * MIN, `fired after ${firedAt} ms`);

	m.snapshots.set(2, m.snapshot("CONNECTED", { lastConnectedAt: m.at(0) }));
	await m.monitor.runChecks();
	assert.equal(m.sent.filter((text) => text.startsWith("[RESOLVIDO] nunes")).length, 1);
	assert.equal(m.service.getCursor("session-down:2"), null, "outage tracking ends when connected");

	// A new outage starts its own clock.
	m.snapshots.set(2, m.snapshot("DISCONNECTED", { lastConnectedAt: m.at(1_000), lastDisconnectedAt: m.at(0) }));
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 2, "not re-alerted from the old outage start");
});

test("scope survives a wwebjs-api restart that nulls lastConnectedAt (persisted CONNECTED transition)", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("QR_PENDING", { lastConnectedAt: null, stateChangedAt: m.at(2 * MIN) }));
	m.snapshots.set(4, m.snapshot("QR_PENDING", { lastConnectedAt: null, stateChangedAt: m.at(2 * MIN) }));
	m.connectedEventClients.add(2);
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 1, "client 4 has no connection in 24 h and stays out of scope");
	assert.match(m.sent[0]!, /^\[CRÍTICO\] nunes · Sessão fora do ar\nCliente 2\nEstado QR_PENDING/);
});

test("persistent storm and backlog alert once per condition, not on every re-check", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("CONNECTED"));
	m.stormGroups.push({ clientId: 2, _count: { _all: 14 } });
	m.internalRows.push({ instance: "nunes", createdAt: m.at(5 * MIN), messageData: JSON.stringify({ clientId: 2 }) });
	for (let minute = 0; minute < 60; minute += 1) {
		await m.monitor.runChecks();
		if (minute % 5 === 0) await m.monitor.checkDisconnectStorm();
		m.service.tick();
		m.advance(MIN);
	}
	assert.equal(m.sent.filter((text) => text.includes("Desconexões frequentes")).length, 1);
	assert.equal(m.sent.filter((text) => text.includes("Fila de envio atrasada")).length, 1);
	assert.ok(!m.sent.some((text) => text.includes("ocorrências")), "re-checks are not counted as occurrences");

	// Cleared, then back: a new condition alerts again (after the dedup window).
	m.internalRows.length = 0;
	await m.monitor.runChecks();
	m.advance(11 * MIN);
	m.internalRows.push({ instance: "nunes", createdAt: m.at(3 * MIN), messageData: JSON.stringify({ clientId: 2 }) });
	await m.monitor.runChecks();
	assert.equal(m.sent.filter((text) => text.includes("Fila de envio atrasada")).length, 2);
});

test("QUEUE_BACKLOG skips internal rows already reported as SEND_SLOW", async () => {
	const m = monitorHarness();
	m.snapshots.set(2, m.snapshot("CONNECTED"));
	m.internalRows.push({
		instance: "nunes", createdAt: m.at(5 * MIN),
		messageData: JSON.stringify({ clientId: 2, timing: { slowAlertedAt: m.at(4 * MIN).toISOString() } })
	});
	await m.monitor.runChecks();
	assert.equal(m.sent.length, 0);
});

test("operator scan reads a burst larger than one page", async () => {
	const m = monitorHarness();
	m.snapshots.set(11, m.snapshot("CONNECTED"));
	m.snapshots.set(12, m.snapshot("CONNECTED"));
	m.service.loadState();
	await m.monitor.runChecks();
	m.advance(MIN);
	for (let index = 0; index < 150; index += 1) {
		m.operatorRows.push({
			id: `op-${index}`, instance: index < 100 ? "exatron" : "nunes", clientId: index < 100 ? 11 : 12, messageId: index,
			remoteJobId: null, status: "UNKNOWN", createdAt: m.at(50_000), completedAt: m.at(40_000 - index * 100)
		});
	}
	await m.monitor.runChecks();
	assert.ok(m.sent.some((text) => /^\[CRÍTICO\] nunes · Falha no envio\nCliente 12/.test(text)), "rows past the first 100 are alerted");
	assert.equal(m.service.recent().filter((entry) => entry.alert.type === "SEND_FAILED").length, 150);
	fs.rmSync(path.dirname(m.cfg.stateFile), { recursive: true, force: true });
});
