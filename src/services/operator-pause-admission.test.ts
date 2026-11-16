import assert from "node:assert/strict";
import test from "node:test";
import { OperatorPauseAdmission, pauseAdmissionFailure, type PauseAdmissionTransaction } from "./operator-pause-admission";
import { pauseSendTargetMatches } from "../utils/operator-pause-peer";

function fixture() {
	let present = true, enabled = 1, global = 1, hash = "a".repeat(64), previous = 7;
	let started = new Date("2026-11-16T11:00:00Z"), cutoff = new Date("2026-11-16T12:00:00Z");
	const states = new Map([[7, "paused"], [8, "available"]]);
	const events: string[] = [];
	const tx: PauseAdmissionTransaction = {
		$queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => {
			if (sql.includes("information_schema")) return (present ? [{ COLUMN_NAME: "pause_all_channels" }] : []) as T;
			if (sql.includes("FROM telephony_runtime_policy")) return [{ enabled, pause_all_channels: global, preflight_hash: hash }] as T;
			if (sql.includes("FROM telephony_operator_state")) { events.push(`state:${values[0]}`); return [{ state: states.get(Number(values[0])) ?? "available", unavailable_since: cutoff }] as T; }
			if (sql.includes("FROM operadores WHERE")) return [{ ATIVO: "SIM" }] as T;
			if (sql.includes("FROM chats")) { events.push("chat"); return [{ id: 10, user_id: previous, is_finished: 0, is_schedule: 0, started_at: started, peer_contact_id: 42, peer_phone: "5551999999999", peer_whatsapp_id: "5551999999999" }] as T; }
			if (sql.includes("LEFT JOIN")) return [...states].filter(([, state]) => state === "available").map(([CODIGO]) => ({ CODIGO })) as T;
			throw new Error("unexpected SQL");
		},
		$executeRawUnsafe: async (_sql, ...values) => { events.push(`insert:${values[0]}`); return 1; }
	};
	return { tx, events, states, admission: new OperatorPauseAdmission(), configure: (patch: { present?: boolean; enabled?: number; global?: number; hash?: string; previous?: number; started?: Date; cutoff?: Date }) => {
		present = patch.present ?? present; enabled = patch.enabled ?? enabled; global = patch.global ?? global; hash = patch.hash ?? hash; previous = patch.previous ?? previous;
		started = patch.started ?? started; cutoff = patch.cutoff ?? cutoff;
	} };
}
test("global pause gates both pending and paused, with stable retryable errors", async () => {
	for (const state of ["pending", "paused"]) {
		const f = fixture(); f.states.set(7, state);
		await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 7 }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	}
	const f = fixture();
	await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: "7" as unknown as number }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
});
test("new shared attendance still guards its human initiator", async () => {
	const f = fixture();
	await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: -1, initiatorId: 7 }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	await f.admission.assert(f.tx, { instance: "one", recipientId: -1, initiatorId: 8 }, true);
});
test("same ownership stays usable and transfers away lock recipients before the chat", async () => {
	const f = fixture();
	await f.admission.assert(f.tx, { instance: "one", recipientId: 7, chatId: 10 }, true);
	f.events.length = 0;
	await f.admission.assert(f.tx, { instance: "one", recipientId: 8, initiatorId: 7, chatId: 10 }, true).catch(() => {});
	assert.deepEqual(f.events, ["insert:7", "state:7", "insert:8", "state:8", "chat"]);
	await f.admission.assert(f.tx, { instance: "one", recipientId: 8, chatId: 10 }, true);
});
test("OFF and unmigrated tenants retain legacy behavior; a reviewed gate cannot disappear silently", async () => {
	const f = fixture(); f.configure({ global: 0 });
	await f.admission.assert(f.tx, { instance: "one", recipientId: 7 }, true);
	f.configure({ global: 1 });
	await f.admission.assert(f.tx, { instance: "one", recipientId: 8 }, true);
	f.configure({ present: false });
	await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 8 }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_AVAILABILITY_UNAVAILABLE");
	await f.admission.assert(f.tx, { instance: "unmigrated", recipientId: 7 }, true);
	await f.admission.assert(f.tx, { instance: "central", recipientId: 7 }, false);
});
test("invalid reviewed policy never grants admission and advisory excludes paused actors", async () => {
	const f = fixture();
	assert.deepEqual([...await f.admission.eligible(f.tx, "one", [7, 8], true)], [8]);
	f.configure({ hash: "" });
	await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 8 }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_AVAILABILITY_UNAVAILABLE");
});
test("paused human sends preserve old shared chats and owned chats, but never open a new shared attendance", async () => {
	const f = fixture(); f.configure({ previous: -1 });
	await f.admission.assertSend(f.tx, { instance: "one", actorId: 7, chatId: 10, to: "5551999999999@c.us" }, true);
	for (const started of [new Date("2026-11-16T12:00:00Z"), new Date("2026-11-16T12:00:01Z")]) {
		f.configure({ started });
		await assert.rejects(f.admission.assertSend(f.tx, { instance: "one", actorId: 7, chatId: 10, to: "5551999999999" }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	}
	f.configure({ previous: 7 });
	await f.admission.assertSend(f.tx, { instance: "one", actorId: 7, chatId: 10, to: "5551999999999" }, true);
	await assert.rejects(f.admission.assertSend(f.tx, { instance: "one", actorId: 7, chatId: 10, to: "5551888888888" }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	await assert.rejects(f.admission.assertSend(f.tx, { instance: "one", actorId: 7, chatId: 10, contactId: 99, to: "5551999999999" }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	await assert.rejects(f.admission.assertSend(f.tx, { instance: "one", actorId: 7 }, true), error => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED");
	await f.admission.assertSend(f.tx, { instance: "one", actorId: 8 }, true);
});
test("peer binding preserves phone JIDs, bare IDs, LIDs and groups without crossing identity kinds", () => {
	assert.equal(pauseSendTargetMatches("5551999999999@s.whatsapp.net", null, "5551999999999@c.us"), true);
	assert.equal(pauseSendTargetMatches("51999999999", "5551999999999", null), true);
	assert.equal(pauseSendTargetMatches("5551999999999", "555199999999", null), true);
	assert.equal(pauseSendTargetMatches("555199999999", "5551999999999", null), true);
	assert.equal(pauseSendTargetMatches("1234@lid", null, "1234"), true);
	assert.equal(pauseSendTargetMatches("1234", null, "1234@lid"), true);
	assert.equal(pauseSendTargetMatches("1203-4@g.us", null, "1203-4@g.us"), true);
	assert.equal(pauseSendTargetMatches("1234@lid", "1234", null), false);
	assert.equal(pauseSendTargetMatches("1234@g.us", null, "1234@lid"), false);
	assert.equal(pauseSendTargetMatches("5551888888888", "5551999999999", "1234@lid"), false);
});
