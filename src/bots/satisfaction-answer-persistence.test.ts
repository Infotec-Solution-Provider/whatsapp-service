import assert from "node:assert/strict";
import { persistInitialSurveyRating, persistSurveyAnswer, SurveyChatLock, type SurveyAnswerInput, type SurveyQuery } from "./satisfaction-answer-persistence";

const input: SurveyAnswerInput = { chatId: 100, numberId: 9, messageId: 501, questionKey: "q1", question: "Fixture question", questionIndex: 0, answer: "8", rating: 8 };
async function run() {
	for (const mode of ["normal", "old-schema", "lost-reply", "unavailable", "no-row", "conflict"]) {
		let inserts = 0;
		let stored = mode === "conflict";
		const query: SurveyQuery = async (statement) => {
			if (statement.startsWith("SELECT")) return stored ? [{ RESPOSTA: mode === "conflict" ? "different" : "8", NOTA: 8 }] : [];
			inserts++;
			if (mode === "old-schema" && statement.includes("QUESTION_KEY")) throw new Error("Unknown column 'QUESTION_KEY' in field list");
			if (mode === "unavailable") throw new Error("Connection closed");
			stored = mode !== "no-row";
			if (mode === "lost-reply") throw new Error("Response timeout after commit");
			return { affectedRows: stored ? 1 : 0 };
		};
		if (["unavailable", "no-row", "conflict"].includes(mode)) {
			await assert.rejects(persistSurveyAnswer(query, input));
			assert.equal(inserts, mode === "conflict" ? 0 : 1, "transport failure must never invoke legacy INSERT fallback");
		} else {
			await persistSurveyAnswer(query, input);
			const beforeRetry = inserts;
			await persistSurveyAnswer(query, input);
			assert.equal(inserts, beforeRetry, "replayed message must only confirm the existing answer");
			assert.equal(inserts, mode === "old-schema" ? 2 : 1);
		}
	}
	await assert.rejects(persistInitialSurveyRating(async () => [], 100, "8", 8), /UNCONFIRMED/, "zero matched feedback rows must not advance the bot");
	const events: string[] = [];
	const lock = new SurveyChatLock();
	let release!: () => void;
	const wait = new Promise<void>(resolve => { release = resolve; });
	const first = lock.run(1, async () => { events.push("first"); await wait; events.push("first done"); });
	const second = lock.run(1, async () => { events.push("second"); });
	await lock.run(2, async () => { events.push("other chat"); });
	assert.deepEqual(events, ["first", "other chat"]);
	release(); await Promise.all([first, second]);
	assert.deepEqual(events, ["first", "other chat", "first done", "second"]);
	await assert.rejects(lock.run(1, async () => { throw new Error("failure"); }));
	await lock.run(1, async () => { events.push("released after failure"); });
	console.log("survey persistence: legacy schema, ambiguous commit, outages, zero rows, conflict and per-chat serialization passed");
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
