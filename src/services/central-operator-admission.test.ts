import assert from "node:assert/strict";
import test from "node:test";
import { CentralOperatorAdmission, pauseAdmissionFailure, type PauseAdmissionTransaction } from "./central-operator-admission";
import type { CentralOperatorState, lockRuntimeAdmission } from "../operator-runtime/core";
import { pauseSendTargetMatches } from "../utils/operator-pause-peer";

function fixture() {
	let enabled = true, fails = false, owner = 7, finished = 0, scheduled = 0;
	let started: Date | null = new Date("2026-11-16T11:00:00Z");
	const cutoff = new Date("2026-11-16T12:00:00Z"), states = new Map<number, CentralOperatorState>();
	for (const id of [7, 8]) states.set(id, { operatorId: id, state: id === 7 ? "paused" : "available", version: 1,
		unavailableSince: cutoff, activeCallId: null, pendingScheduleId: null, pendingCallId: null, pauseId: null, reasonId: null, reasonName: null, reasonSnapshot: null });
	const events: string[] = [];
	const lock: typeof lockRuntimeAdmission = async (_tx, instance, ids) => {
		events.push(`lock:${instance}:${ids.join(",")}`);
		if (fails) throw new Error("schema unavailable");
		return { enabled, policy: enabled ? { revision: 1, reviewSha256: "a".repeat(64) } : null, states };
	};
	const tx: PauseAdmissionTransaction = {
		$queryRawUnsafe: async <T>(sql: string) => {
			assert.match(sql, /FROM chats/); events.push("chat");
			return [{ id: 10, user_id: owner, is_finished: finished, is_schedule: scheduled, started_at: started,
				peer_contact_id: 42, peer_phone: "5551999999999", peer_whatsapp_id: "5551999999999" }] as T;
		},
		$executeRawUnsafe: async () => { throw new Error("adapter must delegate state writes to central core"); }
	};
	return { tx, events, states, admission: new CentralOperatorAdmission(lock), configure: (patch: {
		enabled?: boolean; fails?: boolean; owner?: number; finished?: number; scheduled?: number; started?: Date | null
	}) => {
		enabled = patch.enabled ?? enabled; fails = patch.fails ?? fails; owner = patch.owner ?? owner;
		finished = patch.finished ?? finished; scheduled = patch.scheduled ?? scheduled;
		if ("started" in patch) started = patch.started!;
	} };
}
const paused = (error: unknown) => pauseAdmissionFailure(error)?.code === "OPERATOR_PAUSED";
test("pending and paused fence new assignments and shared manual starts", async () => {
	for (const state of ["pending", "paused"] as const) {
		const f = fixture(); f.states.get(7)!.state = state;
		await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 7 }), paused);
		await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: -1, initiatorId: 7 }), paused);
		await f.admission.assert(f.tx, { instance: "one", recipientId: -1, initiatorId: 8 });
	}
});
test("existing open ownership is preserved; reopening and scheduled activation are new attendance", async () => {
	const f = fixture();
	await f.admission.assert(f.tx, { instance: "one", recipientId: 7, chatId: 10 });
	for (const patch of [{ finished: 1 }, { finished: 0, scheduled: 1 }, { scheduled: 0, started: null }]) {
		f.configure(patch); await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 7, chatId: 10 }), paused);
	}
});
test("recipient locks precede chat; transfer away from a paused owner remains possible", async () => {
	const f = fixture();
	await f.admission.assert(f.tx, { instance: "one", recipientId: 8, chatId: 10 });
	assert.deepEqual(f.events, ["lock:one:8", "chat"]);
	f.events.length = 0;
	await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 8, initiatorId: 7, chatId: 10 }), paused);
	assert.deepEqual(f.events, ["lock:one:7,8", "chat"]);
});
test("canonical tenant keys precede policy lookup and malformed keys fail closed", async () => {
	const f = fixture();
	await assert.rejects(f.admission.assert(f.tx, { instance: " SuPrimaxxi ", recipientId: 7 }), paused);
	assert.deepEqual(f.events, ["lock:suprimaxxi:7"]);
	f.events.length = 0;
	await assert.rejects(f.admission.assert(f.tx, { instance: "one/other", recipientId: 8 }), e => pauseAdmissionFailure(e)?.status === 503);
	assert.deepEqual(f.events, []);
});
test("OFF preserves legacy behavior and failed authority returns a stable noncommitted 503", async () => {
	const f = fixture(); f.configure({ enabled: false });
	await f.admission.assert(f.tx, { instance: "one", recipientId: 7 });
	assert.deepEqual(f.events, ["lock:one:7"]);
	f.configure({ enabled: true, fails: true });
	await assert.rejects(f.admission.assert(f.tx, { instance: "one", recipientId: 8 }), error => {
		const failure = pauseAdmissionFailure(error); return failure?.status === 503 && failure.outcome === "NOT_COMMITTED";
	});
});
test("old shared and owned conversations remain usable with real destination binding", async () => {
	const f = fixture(); f.configure({ owner: -1 });
	const send = (to = "5551999999999@c.us", contactId = 42) => f.admission.assertSend(f.tx, { instance: "one", actorId: 7, chatId: 10, contactId, to });
	await send();
	for (const started of [new Date("2026-11-16T12:00:00Z"), new Date("2026-11-16T12:00:00.001Z")]) {
		f.configure({ started }); await assert.rejects(send(), paused);
	}
	f.configure({ owner: 7 }); await send();
	await assert.rejects(send("5551888888888"), paused); await assert.rejects(send(undefined, 99), paused);
	await assert.rejects(f.admission.assertSend(f.tx, { instance: "one", actorId: 7 }), paused);
	await f.admission.assertSend(f.tx, { instance: "one", actorId: 8 });
});
test("advisory filters unavailable actors and batches more than 200 sorted IDs", async () => {
	const f = fixture();
	assert.deepEqual([...await f.admission.eligible(f.tx, "one", [7, 8])], [8]);
	f.events.length = 0;
	await f.admission.eligible(f.tx, "ONE", Array.from({ length: 401 }, (_, i) => 401 - i));
	assert.equal(f.events.length, 3); assert.ok(f.events[0]!.startsWith("lock:one:1,2,"));
});
test("phone, bare ID, LID and group binding do not cross peer kinds", () => {
	assert.equal(pauseSendTargetMatches("5551999999999@s.whatsapp.net", null, "5551999999999@c.us"), true);
	assert.equal(pauseSendTargetMatches("51999999999", "5551999999999", null), true);
	assert.equal(pauseSendTargetMatches("5551999999999", "555199999999", null), true);
	assert.equal(pauseSendTargetMatches("1234@lid", null, "1234"), true);
	assert.equal(pauseSendTargetMatches("1203-4@g.us", null, "1203-4@g.us"), true);
	assert.equal(pauseSendTargetMatches("1234@lid", "1234", null), false);
	assert.equal(pauseSendTargetMatches("1234@g.us", null, "1234@lid"), false);
});
