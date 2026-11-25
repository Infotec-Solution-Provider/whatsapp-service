import assert from "node:assert/strict";
import type { PrismaClient, WppChat, WppContact, WppMessage } from "@prisma/client";
import { findChatForContactChannel } from "../services/chat-channel-scope";

/** Exercises the ordinary distribution entry point, with MySQL as storage and no external I/O. */
export async function verifySharedSectorRouting(db: PrismaClient) {
	const contact = await db.wppContact.create({ data: { instance: "alpha", phone: "551177", name: "Dois canais" } });
	for (const id of [7, 8])
		await db.wppClient.create({
			data: {
				id,
				instance: "alpha",
				name: "Sem bot " + id,
				type: "WABA",
				isActive: true,
				sectors: { connect: { id: 5 } }
			}
		});
	const incoming = (channelId: number, from: string, chatId?: number) =>
		db.wppMessage.create({
			data: {
				instance: "alpha",
				from,
				to: "me:100",
				clientId: channelId,
				body: "Olá",
				type: "chat",
				sentAt: new Date(),
				status: "RECEIVED",
				timestamp: String(Date.now()),
				contactId: contact.id,
				...(chatId && { chatId })
			}
		});
	const owner = await db.wppChat.create({
		data: { instance: "alpha", sectorId: 5, type: "ACTIVE", contactId: contact.id, userId: 17 }
	});
	await incoming(7, "system", owner.id); // an internal note cannot claim this chat for the wrong number
	await incoming(7, "me:1", owner.id); // originally opened by the attendant on A
	assert.equal(await findChatForContactChannel(db, 8, contact), null);
	const stale = await db.wppChat.create({
		data: { instance: "alpha", sectorId: 5, type: "ACTIVE", contactId: contact.id }
	});
	assert.equal((await findChatForContactChannel(db, 7, contact))?.id, owner.id);
	assert.equal((await findChatForContactChannel(db, 8, contact))?.id, stale.id);
	await incoming(7, "system", stale.id);
	assert.equal((await findChatForContactChannel(db, 8, contact))?.id, stale.id);
	await db.wppChat.update({ where: { id: stale.id }, data: { isFinished: true } });
	const modules = new Map<string, NodeModule | undefined>();
	const replace = (path: string, value: unknown) => {
		const id = require.resolve(path);
		modules.set(id, require.cache[id]);
		require.cache[id] = {
			id,
			filename: id,
			loaded: true,
			exports: { __esModule: true, default: value }
		} as NodeModule;
	};
	const noop = async () => {};
	try {
		replace("../services/chats.service", {
			getChatForContact: (id: number, c: WppContact) => findChatForContactChannel(db, id, c),
			syncChatToLocal: noop
		});
		replace("../services/contacts.service", { resolveContactAddress: () => null });
		replace("../services/message-queue.service", { setProcessHandler() {} });
		replace("../services/socket.service", {});
		replace("../services/message-presentation.service", {});
		replace("../services/message-mentions.service", {});
		replace(
			"../utils/processing-logger",
			class {
				log() {}
				failed() {}
				success() {}
				debug() {}
			}
		);
		replace("../bots/bots-registry", { entries: () => [] });
		const path = require.resolve("../services/messages-distribution.service");
		modules.set(path, require.cache[path]);
		delete require.cache[path];
		const distribution = require(path).default;
		distribution.getFlow = async (_: string, sectorId: number) => ({
			hasStartBot: () => false,
			getChatPayload: async () => ({
				instance: "alpha",
				sectorId,
				contactId: contact.id,
				type: "RECEPTIVE",
				userId: -1
			})
		});
		distribution.addSystemMessage = noop;
		distribution.processAiAgentMessage = noop;
		distribution.insertAndNotify = async (_: unknown, chat: WppChat, msg: WppMessage) =>
			db.wppMessage.update({ where: { id: msg.id }, data: { chatId: chat.id } });
		const b = await distribution.processMessage("alpha", 8, await incoming(8, contact.phone!));
		assert.notEqual(b.chatId, owner.id, "uma mensagem em B não entra no atendimento humano de A");
		const other = await db.wppChat.findUniqueOrThrow({ where: { id: b.chatId } });
		assert.equal(other.botId, null);
		assert.equal(other.sectorId, 5);
		assert.equal(
			(await distribution.processMessage("alpha", 7, await incoming(7, contact.phone!))).chatId,
			owner.id
		);
		assert.equal(
			(await distribution.processMessage("alpha", 8, await incoming(8, contact.phone!))).chatId,
			other.id
		);
		return { contact, ownerId: owner.id, otherId: other.id };
	} finally {
		for (const [id, old] of modules) {
			if (old) require.cache[id] = old;
			else delete require.cache[id];
		}
	}
}
