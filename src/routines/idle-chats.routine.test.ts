import assert from "node:assert/strict";

const HOUR = 60 * 60 * 1000;
const IDLE_TIME = 48 * HOUR;

interface FakeMessage { sentAt: Date; from: string; }
interface FakeChat {
	id: number; instance: string; userId: number | null; sectorId: number | null; contactId: number;
	startedAt: Date; isFinished: boolean; messages: FakeMessage[]; contact: { name: string } | null;
}

const previousModules = new Map<string, NodeModule | undefined>();
function mockModule(id: string, exports: unknown): void {
	const path = require.resolve(id);
	previousModules.set(path, require.cache[path]);
	require.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
}

let now = Date.parse("2026-10-06T12:00:00.000Z");
const realDateNow = Date.now;
Date.now = () => now;

let chats: FakeChat[] = [];
let notifications: number[] = [];
let finishAttempts: number[] = [];
let failingChats = new Map<number, "before-update" | "after-update">();
let messagesWindowStart: Date | null = null;
const results: Array<{ processedChats: number; finishedChats: number; failedChatIds: number[]; stopReason: string | null }> = [];

const parameters = [
	{ id: 1, scope: "INSTANCE", key: "chat_auto_finish_enabled", value: "true", instance: "suprimaxxi", sectorId: null, userId: null },
	{ id: 2, scope: "INSTANCE", key: "chat_auto_finish_idle_time", value: String(IDLE_TIME), instance: "suprimaxxi", sectorId: null, userId: null },
];

// No real database, tenant or WhatsApp provider is used by these tests.
mockModule("../services/prisma.service", {
	__esModule: true,
	default: {
		parameter: { findMany: async () => parameters },
		wppChat: {
			findMany: async (args: { where: { instance: { in: string[] } }; include: { messages: { where: { sentAt: { gte: Date } } } } }) => {
				const gte = args.include.messages.where.sentAt.gte;
				messagesWindowStart = gte;
				return chats
					.filter((chat) => !chat.isFinished && args.where.instance.in.includes(chat.instance))
					.map((chat) => ({
						...chat,
						messages: chat.messages
							.filter((message) => message.sentAt >= gte)
							.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime()),
					}));
			},
			findUnique: async ({ where }: { where: { id: number } }) => chats.find((chat) => chat.id === where.id) ?? null,
		},
		notification: { create: async ({ data }: { data: { chatId: number } }) => { notifications.push(data.chatId); } },
		wppSector: { findUnique: async () => null },
	},
});
mockModule("../services/chats.service", {
	__esModule: true,
	default: {
		systemFinishChatById: async (chatId: number) => {
			finishAttempts.push(chatId);
			const failure = failingChats.get(chatId);
			const chat = chats.find((item) => item.id === chatId)!;
			if (failure === "before-update") throw new Error(`timeout of 60000ms exceeded (chat ${chatId})`);
			chat.isFinished = true;
			if (failure === "after-update") throw new Error(`tenant sync failed (chat ${chatId})`);
		},
	},
});
mockModule("../services/whatsapp.service", { __esModule: true, default: { getClient: async () => null } });
mockModule("../bots/choose-sector.bot", {
	__esModule: true,
	default: { checkIfAlreadyAskedToBackToMenu: async () => false, askIfWantsToBackToMenu: async () => undefined },
});
mockModule("../utils/processing-logger", {
	__esModule: true,
	default: class {
		log(): void {}
		success(result: (typeof results)[number]): void { results.push(result); }
		failed(): void {}
	},
});
mockModule("@in.pulse-crm/utils", { Logger: { info: () => undefined, error: () => undefined } });

const runIdleChatsJob = (require("./idle-chats.routine") as typeof import("./idle-chats.routine")).default;

function idleChat(id: number, lastMessageAgo: number | null = null): FakeChat {
	return {
		id, instance: "suprimaxxi", userId: 7, sectorId: 1, contactId: id, contact: { name: `Contato ${id}` },
		startedAt: new Date(now - 10 * 24 * HOUR), isFinished: false,
		messages: lastMessageAgo === null ? [] : [{ sentAt: new Date(now - lastMessageAgo), from: "5511999999999" }],
	};
}

function reset(nextChats: FakeChat[]): void {
	chats = nextChats;
	notifications = [];
	finishAttempts = [];
	failingChats = new Map();
	results.length = 0;
}

async function testBacklogDrainsInBatches(): Promise<void> {
	reset(Array.from({ length: 120 }, (_, index) => idleChat(1000 + index)));

	await runIdleChatsJob();
	assert.equal(notifications.length, 50, "one run must finish a full batch, not a single chat");
	assert.deepEqual(results[0], { processedChats: 50, finishedChats: 50, failedChatIds: [], stopReason: "limite de 50 ações por execução" });

	await runIdleChatsJob();
	await runIdleChatsJob();
	assert.equal(notifications.length, 120);
	assert.equal(chats.filter((chat) => !chat.isFinished).length, 0);
	assert.deepEqual(results[2], { processedChats: 20, finishedChats: 20, failedChatIds: [], stopReason: null });
}

async function testMessagesWindowCoversIdleTime(): Promise<void> {
	reset([idleChat(2000, 30 * HOUR), idleChat(2001, 50 * HOUR), idleChat(2002, 2 * HOUR)]);

	await runIdleChatsJob();
	assert.equal(messagesWindowStart?.getTime(), now - IDLE_TIME, "messages must be loaded for the whole idle time");
	assert.deepEqual(notifications, [2001], "a chat with a message 30h ago is not idle under a 48h idle time");
}

async function testFailedChatDoesNotBlockOthers(): Promise<void> {
	reset([idleChat(3000), idleChat(3001), idleChat(3002)]);
	failingChats.set(3000, "before-update");

	await runIdleChatsJob();
	assert.deepEqual(notifications, [3001, 3002], "a failed chat gets no notification and does not stop the run");
	assert.deepEqual(results[0]?.failedChatIds, [3000]);

	finishAttempts = [];
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [], "a failed chat waits before the next attempt");

	now += 16 * 60 * 1000;
	failingChats.clear();
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [3000]);
	assert.deepEqual(notifications, [3001, 3002, 3000]);
}

async function testConsecutiveFailuresStopTheRun(): Promise<void> {
	reset(Array.from({ length: 10 }, (_, index) => idleChat(4000 + index)));
	for (const chat of chats) failingChats.set(chat.id, "before-update");

	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [4000, 4001, 4002], "an unavailable tenant must not be hit for every chat");
	assert.equal(results[0]?.stopReason, "3 falhas consecutivas");
	assert.deepEqual(notifications, []);
}

async function testFailureAfterFinishingStillNotifies(): Promise<void> {
	now += 60 * 60 * 1000;
	reset([idleChat(5000)]);
	failingChats.set(5000, "after-update");

	await runIdleChatsJob();
	assert.deepEqual(notifications, [5000]);
	assert.deepEqual(results[0], { processedChats: 1, finishedChats: 1, failedChatIds: [], stopReason: null });
}

async function main(): Promise<void> {
	try {
		await testBacklogDrainsInBatches();
		await testMessagesWindowCoversIdleTime();
		await testFailedChatDoesNotBlockOthers();
		await testConsecutiveFailuresStopTheRun();
		await testFailureAfterFinishingStillNotifies();
		console.log("idle-chats.routine tests passed");
	} finally {
		Date.now = realDateNow;
		for (const [path, previous] of previousModules) {
			if (previous) require.cache[path] = previous;
			else delete require.cache[path];
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
