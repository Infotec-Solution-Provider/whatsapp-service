import assert from "node:assert/strict";
import { test } from "node:test";
import type { WppChat, WppContact, WppMessage } from "@prisma/client";

test("a primeira mensagem só inicia pelo gestor e a sessão existente precede novas regras", async () => {
	const saved = new Map<string, NodeModule | undefined>();
	const stub = (name: string, value: unknown, named = false) => {
		const id = require.resolve(name);
		saved.set(id, require.cache[id]);
		require.cache[id] = {
			id,
			filename: id,
			loaded: true,
			exports: named ? value : { __esModule: true, default: value }
		} as NodeModule;
	};
	const noop = async () => {};
	const contact = { id: 7, instance: "alpha", phone: "55111" } as WppContact;
	const msg = { id: 101, type: "chat", body: "ajuda", instance: "alpha", from: "55111", clientId: 3 } as WppMessage;
	const bot = { id: 55, instance: "alpha", sectorId: 9, contactId: 7, botId: -10, userId: null } as WppChat;
	let current: WppChat | null = null,
		keyword = false,
		block = false,
		canStart = true,
		multisector = false;
	let calls: string[] = [];
	const capture = (name: string) => {
		calls.push(name);
	};
	try {
		for (const path of [
			"../services/instances.service",
			"../services/prisma.service",
			"../services/socket.service",
			"../services/messages.service",
			"../services/whatsapp.service",
			"../services/chat-user-preferences.service",
			"../services/message-presentation.service",
			"../services/transfer-history.service",
			"../services/parameters.service",
			"../services/users.service",
			"../message-flow/message-flow.factory",
			"../bots/bots-registry"
		])
			stub(path, {});
		stub("../services/message-queue.service", { setProcessHandler() {} });
		stub("../services/contacts.service", { resolveContactAddress: () => null });
		stub("../services/chats.service", { getChatForContact: async () => current, syncChatToLocal: noop });
		stub(
			"../utils/processing-logger",
			class {
				log() {}
				failed() {}
				success() {}
				debug() {}
			}
		);
		stub("./trigger-notices", { enqueueTriageNotice: noop }, true);
		stub(
			"./runtime",
			{
				acceptsTriageMessage: () => true,
				consumeTriage: async () =>
					current?.botId === -10 ? { chat: current, handled: true, opened: false } : null
			},
			true
		);
		stub(
			"./triggers",
			{
				triageTriggers: {
					match: async () => {
						capture("keyword");
						return keyword ? { versionId: 8 } : null;
					}
				}
			},
			true
		);
		stub(
			"./trigger-start",
			{
				startTriggeredTriage: async (input: { type: string }) => {
					capture(input.type);
					return canStart ? { chat: bot, opened: true, ref: { id: 3, name: "Equipe", version: 1 } } : null;
				}
			},
			true
		);
		const distribution = require("../services/messages-distribution.service").default;
		distribution.resolveMessageContact = async () => contact;
		distribution.getSectors = async () => (multisector ? [{ id: 8 }, { id: 9 }] : [{ id: 9 }]);
		distribution.getFlow = async () => ({
			hasStartBot: () => block,
			getChatPayload: async (
				_log: unknown,
				_c: unknown,
				_m: unknown,
				actions: { startBot: (id: number) => Promise<unknown> }
			) => {
				capture("flow selected");
				const chosen = await actions.startBot(3);
				return chosen ? { startedBot: chosen } : { userId: 41 };
			}
		});
		distribution.processBotMessage = async () => capture("existing owner");
		distribution.insertAndNotify = async (_log: unknown, chat: WppChat) => {
			capture("insert " + chat.id);
			return msg;
		};
		distribution.checkAndSendAutoResponseMessage = async () => {
			capture("auto");
			return false;
		};
		distribution.createNewChat = async (...args: unknown[]) => {
			const decision = args[6] as { userId: number } | undefined;
			capture(decision ? "human " + decision.userId : "legacy");
			return { chat: { ...bot, id: 27, botId: null } };
		};
		distribution.initializeBotForNewChat = noop;
		distribution.addSystemMessage = noop;
		distribution.processAiAgentMessage = async () => capture("ai");
		await distribution.processMessage("alpha", 3, msg);
		assert.deepEqual(calls, ["keyword", "auto", "legacy", "insert 27", "ai"]);
		block = true;
		calls = [];
		await distribution.processMessage("alpha", 3, msg);
		assert.deepEqual(calls, ["keyword", "flow selected", "flow", "insert 55"]);
		keyword = true;
		calls = [];
		await distribution.processMessage("alpha", 3, msg);
		assert.deepEqual(calls, ["keyword", "keyword", "insert 55"]);
		current = bot;
		calls = [];
		await distribution.processMessage("alpha", 3, msg);
		assert.deepEqual(calls, ["insert 55"]);
		current = null;
		canStart = false;
		keyword = false;
		calls = [];
		await distribution.processMessage("alpha", 3, msg);
		assert.deepEqual(calls, ["keyword", "flow selected", "flow", "auto", "human 41", "insert 27", "ai"]);
		multisector = true;
		calls = [];
		await distribution.processMessage("alpha", 3, msg);
		assert.deepEqual(calls, ["keyword", "auto", "legacy", "insert 27", "ai"]);
	} finally {
		for (const [k, v] of saved) {
			if (v) require.cache[k] = v;
			else delete require.cache[k];
		}
	}
});
