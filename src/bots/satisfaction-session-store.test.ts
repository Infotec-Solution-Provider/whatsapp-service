import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SatisfactionSessionStore } from "./satisfaction-session-store";

async function run() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inpulse-survey-test-"));
	const file = path.join(directory, "sessions.json");
	try {
		const store = new SatisfactionSessionStore<{ chatId: number; pendingAnswer?: { messageId: number } }>(file);
		await store.ensureLoaded(sessions => assert.deepEqual(sessions, []));
		await store.save(() => [{ chatId: 1, pendingAnswer: { messageId: 501 } }]);
		const restarted = new SatisfactionSessionStore(file);
		await restarted.ensureLoaded(sessions => assert.deepEqual(sessions, [{ chatId: 1, pendingAnswer: { messageId: 501 } }]));
		await Promise.all([store.save(() => [{ chatId: 1 }]), store.save(() => [{ chatId: 2 }])]);
		assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { sessions: [{ chatId: 2 }] });
		await fs.writeFile(file, '[{"chatId":3}]');
		await new SatisfactionSessionStore(file).ensureLoaded(sessions => assert.deepEqual(sessions, [{ chatId: 3 }]));
		await fs.writeFile(file, "broken JSON");
		await assert.rejects(new SatisfactionSessionStore(file).ensureLoaded(() => assert.fail("corrupt file must not silently become empty")));
		assert.equal(await fs.readFile(file, "utf8"), "broken JSON");
		console.log("survey session store: restart recovery, ordered atomic writes, legacy shape and corruption protection passed");
	} finally {
		// Only the uniquely-created fixture directory is removed.
		await fs.rm(directory, { recursive: true, force: true });
	}
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
