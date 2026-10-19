import assert from "node:assert/strict";
import { SurveyChatLock } from "./satisfaction-answer-persistence";

// Load the real orchestration with all I/O replaced; no clients, timers or databases are started.
const originals = new Map<string, NodeModule | undefined>();
function mock(id: string, exports: unknown) {
	const filename = require.resolve(id);
	originals.set(filename, require.cache[filename]);
	require.cache[filename] = { id: filename, filename, loaded: true, exports: { __esModule: true, ...(exports as object) } } as NodeModule;
}
const chat = { id: 7, instance: "exatron", userId: 23, sectorId: 4, contactId: 9, isFinished: false };
const contact = { id: 9, instance: "exatron", phone: "5511999990000" };
const message = { id: 100, instance: "exatron", chatId: 7, body: "8", from: contact.phone };
let saved: any[] = [], failPersistence = true, failProgressSave = false, finished = false;
let sent = 0, writes = 0, saveCalls = 0;
mock("./satisfaction-session-store", { SatisfactionSessionStore: class {
	async ensureLoaded(consume: (rows: unknown[]) => void) { consume([]); }
	scheduleSave() {}
	async save(provider: () => Iterable<unknown>) {
		saveCalls++;
		const rows = Array.from(provider()) as any[];
		if (failProgressSave && rows[0] && !rows[0].pendingAnswer) throw new Error("disk fixture");
		saved = JSON.parse(JSON.stringify(rows));
	}
} });
mock("./satisfaction-answer-persistence", { SurveyChatLock,
	persistSurveyAnswer: async () => { writes++; if (failPersistence) throw new Error("CRM fixture"); },
	persistInitialSurveyRating: async () => { throw new Error("unexpected initial rating"); }
});
mock("../sdk-local", { SocketEventType: {} });
mock("../services/instances.service", { default: { executeQuery: async () => [{ CODIGO: 3 }] } });
mock("../services/parameters.service", { default: { getSessionParams: async (params: any) => {
	assert.equal(params.userId, 23, "parameters use operator, not contact ID"); return {};
} } });
mock("../services/prisma.service", { default: {
	wppChat: { findUnique: async () => ({ ...chat, isFinished: finished }), findFirst: async () => ({ ...chat, isFinished: finished }) },
	wppMessage: { findUnique: async () => message }, wppContact: { findUnique: async () => contact },
	wppSector: { findUnique: async () => ({ defaultClientId: 1 }) }
} });
mock("../services/whatsapp.service", { default: { getClient: () => ({ id: 1 }), sendBotMessage: async () => { sent++; } } });
for (const id of ["../services/chats.service", "../services/messages.service", "../services/socket.service"]) mock(id, { default: {} });
mock("../utils/processing-logger", { default: class { log() {} success() {} failed() {} } });
const originalInterval = global.setInterval;
global.setInterval = (() => 0) as unknown as typeof setInterval;

async function main() {
	const bot = require("./exatron-satisfaction.bot").default;
	try {
		await bot.processMessage(chat, contact, message);
		let session = bot.sessions.get(7);
		assert.equal(session.questionIndex, 0);
		assert.equal(saved[0].pendingAnswer.messageId, 100);
		assert.equal(sent, 0, "CRM failure cannot advance/send");
		session.lastActivity = 0;
		await bot.checkSessionTimeouts();
		assert.equal(session.questionIndex, 0, "pending answer is not timed out");
		await assert.rejects(() => bot.reset(7, 23), /PENDING/);
		failPersistence = false;
		failProgressSave = true;
		await bot.checkSessionTimeouts();
		assert.equal(session.questionIndex, 0, "failed checkpoint restores pending progress");
		assert.equal(session.lastProcessedMessageId, undefined);
		assert.equal(sent, 0);
		failProgressSave = false;
		await bot.checkSessionTimeouts();
		assert.equal(session.questionIndex, 1);
		assert.equal(session.pendingAnswer, undefined);
		assert.equal(saved[0].lastProcessedMessageId, 100);
		assert.equal(sent, 1);
		await bot.processMessage(chat, contact, message);
		assert.equal(sent, 1, "duplicate event does not answer the next question");
		failPersistence = true;
		await bot.processMessage(chat, contact, { ...message, id: 101 });
		assert.equal(session.pendingAnswer.messageId, 101);
		// Recovery after manual closure persists the original answer without reopening/sending.
		message.id = 101;
		finished = true;
		failPersistence = false;
		await bot.checkSessionTimeouts();
		assert.equal(bot.sessions.size, 0);
		assert.equal(sent, 1);
		assert.ok(writes >= 5 && saveCalls >= 5);
		console.log("survey bot: failed CRM/checkpoint, timeout recovery, duplicate events, operator context and manual closure passed");
	} finally {
		global.setInterval = originalInterval;
		for (const [filename, original] of originals) { if (original) require.cache[filename] = original; else delete require.cache[filename]; }
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
