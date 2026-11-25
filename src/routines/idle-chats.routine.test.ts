import assert from "node:assert/strict";
import type { Parameter } from "@prisma/client";
import { InstanceQueryUnavailableError } from "../sdk-local/instance.client";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const IDLE_TIME = 48 * HOUR;
const FLAG = "CHAT_AUTO_FINISH_CLOSED_DAYS_ENABLED";
const previousFlag = process.env[FLAG];
delete process.env[FLAG];

interface FakeMessage {
	sentAt: Date;
	from: string;
}
interface FakeChat {
	id: number;
	instance: string;
	userId: number | null;
	sectorId: number | null;
	contactId: number;
	startedAt: Date;
	isFinished: boolean;
	messages: FakeMessage[];
	contact: { name: string } | null;
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
let failingChats = new Map<number, "before-update" | "after-update" | "crm-before-update" | "crm-after-update">();
let messagesWindowStart: Date | null = null;
let closedDates: { instance: string; date: Date }[] = [];
let calendarFailed = false;
let calendarReads = 0;
let calendarFailures = 0;
const results: Array<{
	processedChats: number;
	finishedChats: number;
	failedChatIds: number[];
	stopReason: string | null;
}> = [];

const parameters: Parameter[] = [
	{
		id: 1,
		scope: "INSTANCE",
		key: "chat_auto_finish_enabled",
		value: "true",
		instance: "suprimaxxi",
		sectorId: null,
		userId: null
	},
	{
		id: 2,
		scope: "INSTANCE",
		key: "chat_auto_finish_idle_time",
		value: String(IDLE_TIME),
		instance: "suprimaxxi",
		sectorId: null,
		userId: null
	}
];

// No real database, tenant or WhatsApp provider is used by these tests.
mockModule("../services/prisma.service", {
	__esModule: true,
	default: {
		parameter: { findMany: async () => parameters },
		chatAutoFinishClosedDate: {
			findMany: async ({ where }: { where: { instance: { in: string[] }; date: { lte: Date } } }) => {
				calendarReads++;
				if (calendarFailed) throw new Error("calendar unavailable");
				return closedDates.filter(({ instance, date }) => where.instance.in.includes(instance) && date <= where.date.lte);
			}
		},
		wppChat: {
			findMany: async (args: {
				where: { instance: { in: string[] } };
				include: { messages: { where: { sentAt: { gte: Date } } } };
			}) => {
				const gte = args.include.messages.where.sentAt.gte;
				messagesWindowStart = gte;
				return chats
					.filter((chat) => !chat.isFinished && args.where.instance.in.includes(chat.instance))
					.map((chat) => ({
						...chat,
						messages: chat.messages
							.filter((message) => message.sentAt >= gte)
							.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
					}));
			},
			findUnique: async ({ where }: { where: { id: number } }) =>
				chats.find((chat) => chat.id === where.id) ?? null
		},
		notification: {
			create: async ({ data }: { data: { chatId: number } }) => {
				notifications.push(data.chatId);
			}
		},
		wppSector: { findUnique: async () => null, findMany: async () => [{ instance: "suprimaxxi" }] }
	}
});
mockModule("../services/chats.service", {
	__esModule: true,
	default: {
		systemFinishChatById: async (chatId: number) => {
			finishAttempts.push(chatId);
			const failure = failingChats.get(chatId);
			const chat = chats.find((item) => item.id === chatId)!;
			if (failure === "before-update") throw new Error(`timeout of 60000ms exceeded (chat ${chatId})`);
			if (failure === "crm-before-update") throw new InstanceQueryUnavailableError(chat.instance, "CRM unreachable");
			chat.isFinished = true;
			if (failure === "crm-after-update") throw new InstanceQueryUnavailableError(chat.instance, "CRM unreachable");
			if (failure === "after-update") throw new Error(`tenant sync failed (chat ${chatId})`);
		}
	}
});
mockModule("../services/whatsapp.service", { __esModule: true, default: { getClient: async () => null } });
mockModule("../bots/choose-sector.bot", {
	__esModule: true,
	default: { checkIfAlreadyAskedToBackToMenu: async () => false, askIfWantsToBackToMenu: async () => undefined }
});
mockModule("../utils/processing-logger", {
	__esModule: true,
	default: class {
		log(): void {}
		success(result: (typeof results)[number]): void {
			results.push(result);
		}
		failed(): void { calendarFailures++; }
	}
});
mockModule("@in.pulse-crm/utils", { Logger: { info: () => undefined, error: () => undefined } });

const runIdleChatsJob = (require("./idle-chats.routine") as typeof import("./idle-chats.routine")).default;

function idleChat(id: number, lastMessageAgo: number | null = null): FakeChat {
	return {
		id,
		instance: "suprimaxxi",
		userId: 7,
		sectorId: 1,
		contactId: id,
		contact: { name: `Contato ${id}` },
		startedAt: new Date(now - 10 * 24 * HOUR),
		isFinished: false,
		messages: lastMessageAgo === null ? [] : [{ sentAt: new Date(now - lastMessageAgo), from: "5511999999999" }]
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
	assert.deepEqual(results[0], {
		processedChats: 50,
		finishedChats: 50,
		failedChatIds: [],
		stopReason: "limite de 50 ações por execução"
	});

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
	assert.deepEqual(finishAttempts, [4000, 4001, 4002], "unclassified failures retain the existing limit per run");
	assert.equal(results[0]?.stopReason, "3 falhas consecutivas");
	assert.deepEqual(notifications, []);
}

async function testCrmOutagePausesOnlyAffectedTenant(): Promise<void> {
	reset([
		idleChat(7000), idleChat(7001), idleChat(7002),
		{ ...idleChat(7003), instance: "other-tenant" }
	]);
	failingChats.set(7000, "crm-before-update");
	failingChats.set(7001, "crm-before-update");
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [7000, 7003]);
	assert.deepEqual(notifications, [7003]);
	assert.deepEqual(results[0]?.failedChatIds, [7000]);
	assert.equal(results[0]?.stopReason, null);

	now += MINUTE;
	chats.push({ ...idleChat(7004), instance: "other-tenant" });
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [7000, 7003, 7004]);

	now += 4 * MINUTE;
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [7000, 7003, 7004, 7001], "a failed recovery attempt pauses that tenant again");

	failingChats.clear();
	now += 5 * MINUTE;
	await runIdleChatsJob();
	assert.deepEqual(notifications, [7003, 7004, 7002], "healthy CRM resumes work while failed chats retain their own retry times");

	now += 10 * MINUTE;
	await runIdleChatsJob();
	assert.deepEqual(notifications, [7003, 7004, 7002, 7000, 7001]);
}

async function testCrmOutageAfterFinishingStillNotifies(): Promise<void> {
	reset([idleChat(7100), idleChat(7101), { ...idleChat(7102), instance: "other-tenant" }]);
	failingChats.set(7100, "crm-after-update");
	await runIdleChatsJob();
	assert.deepEqual(notifications, [7100, 7102]);
	assert.deepEqual(finishAttempts, [7100, 7102]);
	assert.deepEqual(results[0]?.failedChatIds, []);
	now += 5 * MINUTE;
	await runIdleChatsJob();
	assert.deepEqual(notifications, [7100, 7102, 7101], "finalized chat must not be reprocessed");
}

async function testFailureAfterFinishingStillNotifies(): Promise<void> {
	now += 60 * 60 * 1000;
	reset([idleChat(5000)]);
	failingChats.set(5000, "after-update");

	await runIdleChatsJob();
	assert.deepEqual(notifications, [5000]);
	assert.deepEqual(results[0], { processedChats: 1, finishedChats: 1, failedChatIds: [], stopReason: null });
}

async function testWeekendPreservesTheFortyEightHourWindow(): Promise<void> {
	process.env[FLAG] = "true";
	now = Date.parse("2026-12-07T12:00:00-03:00");
	const friday = Date.parse("2026-12-04T15:00:00-03:00");
	reset([
		idleChat(8000, now - friday),
		{ ...idleChat(8001), startedAt: new Date(friday) }
	]);
	await runIdleChatsJob();
	assert.equal(calendarReads, 1);
	assert.ok(messagesWindowStart!.getTime() <= friday, "Friday's message is older than the old query window");
	assert.deepEqual(finishAttempts, []);

	now = Date.parse("2026-12-08T15:00:00-03:00");
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [], "the existing strict deadline is preserved");
	now += MINUTE;
	await runIdleChatsJob();
	assert.deepEqual(notifications, [8000, 8001]);
}

async function testConsecutiveClosedDatesAreTenantScoped(): Promise<void> {
	now = Date.parse("2026-12-14T12:00:00-03:00");
	parameters.push({ ...parameters[0]!, id: 7, instance: "other-tenant" });
	closedDates = ["2026-12-12", "2026-12-14", "2026-12-15"].map((date) => ({
		instance: "suprimaxxi",
		date: new Date(date)
	}));
	const friday = Date.parse("2026-12-11T15:00:00-03:00");
	reset([idleChat(8100), idleChat(8101, now - friday), { ...idleChat(8102), instance: "other-tenant" }]);
	try {
		await runIdleChatsJob();
		assert.deepEqual(notifications, [8102], "the closed date affects only the company that registered it");
		now = Date.parse("2026-12-15T23:59:00-03:00");
		await runIdleChatsJob();
		assert.deepEqual(notifications, [8102]);
		now = Date.parse("2026-12-16T00:00:00-03:00");
		await runIdleChatsJob();
		assert.deepEqual(notifications, [8102, 8100], "the already expired chat resumes at midnight in São Paulo");
		now = Date.parse("2026-12-17T15:01:00-03:00");
		await runIdleChatsJob();
		assert.deepEqual(notifications, [8102, 8100, 8101], "the Saturday closure does not double-count");
	} finally {
		parameters.pop();
		closedDates = [];
	}
}

async function testShortTimeoutAndBotQuestionAfterTheWeekend(): Promise<void> {
	now = Date.parse("2026-12-21T00:05:00-03:00");
	const sunday = Date.parse("2026-12-20T17:00:00-03:00");
	const previousValue = parameters[1]!.value;
	parameters[1]!.value = String(5 * MINUTE);
	const answeredChat = idleChat(8201, now - sunday);
	answeredChat.messages[0]!.from = "me:1";
	reset([idleChat(8200, now - sunday), answeredChat]);
	try {
		await runIdleChatsJob();
		assert.deepEqual(finishAttempts, [], "activity on a closed date has the same deadline as activity at midnight");
		now = Date.parse("2026-12-21T00:15:00-03:00");
		await runIdleChatsJob();
		assert.deepEqual(notifications, [8200]);
		now += MINUTE;
		await runIdleChatsJob();
		assert.deepEqual(notifications, [8200, 8201], "the bot's 15-minute wait follows the same calendar");
	} finally {
		parameters[1]!.value = previousValue;
	}
}

async function testCalendarFailureAndRollback(): Promise<void> {
	now = Date.parse("2026-12-12T13:00:00-03:00");
	reset([idleChat(8300)]);
	calendarFailed = true;
	await runIdleChatsJob();
	assert.equal(calendarFailures, 1);
	assert.deepEqual(finishAttempts, []);
	calendarFailed = false;
	await runIdleChatsJob();
	assert.deepEqual(finishAttempts, [], "successful read still pauses closures on Saturday");
	delete process.env[FLAG];
	const readsBeforeRollback = calendarReads;
	await runIdleChatsJob();
	assert.equal(calendarReads, readsBeforeRollback);
	assert.deepEqual(notifications, [8300], "the rollout switch restores elapsed time");
}

async function main(): Promise<void> {
	try {
		await testBacklogDrainsInBatches();
		await testMessagesWindowCoversIdleTime();
		await testFailedChatDoesNotBlockOthers();
		await testConsecutiveFailuresStopTheRun();
		await testFailureAfterFinishingStillNotifies();
		parameters.push({ ...parameters[0]!, id: 6, instance: "other-tenant" });
		await testCrmOutagePausesOnlyAffectedTenant();
		await testCrmOutageAfterFinishingStillNotifies();
		parameters.pop();
		parameters.push({
			id: 3,
			scope: "USER",
			key: "chat_auto_finish_enabled",
			value: "false",
			instance: "other-tenant",
			sectorId: null,
			userId: 7
		});
		reset([idleChat(6000)]);
		await runIdleChatsJob();
		assert.deepEqual(notifications, [6000], "another tenant's user with the same ID cannot disable this chat");
		parameters[0]!.value = "false";
		parameters.push({
			id: 4,
			scope: "USER",
			key: "chat_auto_finish_enabled",
			value: "true",
			instance: "suprimaxxi",
			sectorId: null,
			userId: 7
		});
		reset([idleChat(6001), { ...idleChat(6002), userId: 8 }]);
		await runIdleChatsJob();
		assert.deepEqual(notifications, [6001], "a user exception enables only that user when instance is disabled");
		parameters.pop();
		parameters.push({
			id: 5,
			scope: "SECTOR",
			key: "chat_auto_finish_enabled",
			value: "true",
			instance: null,
			sectorId: 1,
			userId: null
		});
		reset([idleChat(6003), { ...idleChat(6004), sectorId: 2 }]);
		await runIdleChatsJob();
		assert.deepEqual(notifications, [6003], "legacy sector exception enables only that sector");
		parameters.splice(2);
		parameters[0]!.value = "true";
		await testWeekendPreservesTheFortyEightHourWindow();
		await testConsecutiveClosedDatesAreTenantScoped();
		await testShortTimeoutAndBotQuestionAfterTheWeekend();
		await testCalendarFailureAndRollback();
		console.log("idle-chats.routine tests passed");
	} finally {
		Date.now = realDateNow;
		if (previousFlag === undefined) delete process.env[FLAG];
		else process.env[FLAG] = previousFlag;
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
