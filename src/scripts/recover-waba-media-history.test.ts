import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Prisma, WppMessageStatus } from "@prisma/client";
import { recoverWabaMediaHistory } from "./recover-waba-media-history";
import { getMediaMessageId, parsePlan } from "./waba-media-recovery-plan";

const target = { id: "9f2b1b23e70b467db516fdbd29a07577fc10", instance: "example", updatedAt: "2026-01-01 10:57:00.123" };
const legacyId = "934044ae-d355-4737-96eb-98c17d14d40c";
const source = { id: "wamid.synthetic", type: "audio", audio: { id: "123" }, from: "55000000", timestamp: "1767261600" };
const recipient = "55000001";
const sentAt = new Date(Number(source.timestamp) * 1000);
const payload = JSON.stringify({ entry: [{ changes: [{ value: {
	metadata: { display_phone_number: recipient, phone_number_id: "124" }, messages: [source]
} }] }] });

function fixture() {
	const calls: string[] = [];
	const db = {} as Parameters<typeof recoverWabaMediaHistory>[0];
	const state: {
		status: string; chatMatches: number; legacyPresent: boolean; crmUnavailable: boolean; autoClose: boolean;
		stored: Prisma.WppMessageUncheckedCreateInput | null;
	} = { status: "FAILED", chatMatches: 1, legacyPresent: false, crmUnavailable: false, autoClose: false, stored: null };
	const tx = {
		$queryRaw: async (query: Prisma.Sql) => {
			if (query.sql.includes("DATABASE()")) return [{ name: "history_fixture" }];
			if (query.sql.includes("FROM parameters")) {
				assert.match(query.sql, /FIELD\(scope, 'INSTANCE', 'SECTOR', 'USER'\) DESC, id DESC/);
				return state.autoClose ? [{ value: "true" }] : [];
			}
			return [{ payload, status: state.status, updatedAt: target.updatedAt, connectionRefused: true, exhausted: true }];
		},
		$executeRaw: async (query: Prisma.Sql) => {
			assert.match(query.sql, /UPDATE waba_webhook_queue SET status = 'COMPLETED'/);
			assert.doesNotMatch(query.sql, /\bpayload\s*=/);
			assert.ok(state.stored && state.legacyPresent);
			calls.push("complete");
			state.status = "COMPLETED";
			return 1;
		},
		wppClient: { findMany: async () => [{ id: 101 }] },
		wppContact: { findUnique: async () => ({ id: 102, isDeleted: false }) },
		wppChat: { findMany: async (query: Prisma.WppChatFindManyArgs) => {
			assert.deepEqual(query.where?.startedAt, { lte: sentAt });
			assert.deepEqual(query.where?.sector, { clients: { some: { id: 101 } } });
			return Array.from({ length: state.chatMatches }, (_, index) => ({ id: 103 + index, isFinished: false, sectorId: 106, userId: 107 }));
		} },
		wppMessage: {
			findUnique: async () => state.stored,
			create: async ({ data }: { data: Prisma.WppMessageUncheckedCreateInput }) => {
				assert.equal(state.stored, null);
				calls.push("store");
				state.stored = { id: 104, ...data };
				return state.stored;
			}
		}
	};
	Object.assign(db, tx, { $transaction: async (run: (input: typeof tx) => Promise<unknown>) => run(tx) });
	const crm = { executeQuery: async (_, query, params) => {
		if (!query.includes("INSERT")) return (state.legacyPresent ? [{ id: 104 }] : []) as never;
		if (state.crmUnavailable) throw new Error("synthetic CRM failure");
		assert.match(query, /INSERT INTO wpp_messages/);
		assert.match(query, /ON DUPLICATE KEY UPDATE id = id/);
		assert.doesNotMatch(query, /wpp_last_messages|wpp_chats/);
		assert.deepEqual(params.slice(0, 9), [104, target.instance, source.id, source.from, `me:${recipient}`, "audio", null, 103, 102]);
		assert.equal(params[12], "2026-01-01 07:00:00");
		calls.push("mirror");
		state.legacyPresent = true;
		return {} as never;
	} } satisfies Parameters<typeof recoverWabaMediaHistory>[1];
	const download: Parameters<typeof recoverWabaMediaHistory>[2] = async (clientId, peer, instance, event) => {
		calls.push("download");
		assert.deepEqual(event, source);
		return { clientId, instance, wabaId: event.id, from: event.from, to: `me:${peer}`, type: "audio", sentAt,
			timestamp: String(sentAt.getTime()), status: WppMessageStatus.RECEIVED, body: "", fileId: 105, fileType: "audio/ogg", fileSize: "234" };
	};
	return { state, calls, run: (apply = false) => recoverWabaMediaHistory(db, crm, download, "history_fixture", [target], apply) };
}

test("aceita os IDs da fila atual e legada e valida mídia exata", () => {
	assert.equal(parsePlan([target, { ...target, id: legacyId }]).length, 2);
	assert.throws(() => parsePlan([target, target]));
	assert.throws(() => parsePlan([{ ...target, id: target.id.slice(1) }]));
	assert.throws(() => parsePlan([{ ...target, updatedAt: "2026-01-01T10:57:00.123Z" }]));
	assert.equal(getMediaMessageId(payload), source.id);
	assert.equal(getMediaMessageId(payload.replace('"audio"', '"text"')), undefined);
});

test("simulação apenas consulta e aplicação escreve só na mensagem, cópia e fila", async () => {
	const f = fixture();
	assert.deepEqual(await f.run(), { eligible: 1, alreadyComplete: 0, recovered: 0 });
	assert.deepEqual(f.calls, []);
	assert.deepEqual(await f.run(true), { eligible: 1, alreadyComplete: 0, recovered: 1 });
	assert.deepEqual(f.calls, ["download", "store", "mirror", "complete"]);
	assert.equal(f.state.stored?.wabaId, source.id);
	assert.deepEqual(f.state.stored?.sentAt, sentAt);
	assert.deepEqual(await f.run(true), { eligible: 0, alreadyComplete: 1, recovered: 0 });
	assert.deepEqual(f.calls, ["download", "store", "mirror", "complete"]);
});

test("falha de cópia não confirma fila e retomada usa arquivo já gravado", async () => {
	const f = fixture();
	f.state.crmUnavailable = true;
	await assert.rejects(f.run(true), /interrompida após 0 itens/);
	assert.equal(f.state.status, "FAILED");
	assert.deepEqual(f.calls, ["download", "store"]);
	f.state.crmUnavailable = false;
	await f.run(true);
	assert.deepEqual(f.calls, ["download", "store", "mirror", "complete"]);
});

test("atendimento ambíguo ou histórico órfão no CRM impede qualquer escrita", async () => {
	const noChat = fixture();
	noChat.state.chatMatches = 2;
	await assert.rejects(noChat.run(true), /único atendimento histórico/);
	assert.deepEqual(noChat.calls, []);
	const orphan = fixture();
	orphan.state.legacyPresent = true;
	await assert.rejects(orphan.run(true), /reconciliação/);
	assert.deepEqual(orphan.calls, []);
});

test("não altera atendimento aberto com encerramento automático habilitado", async () => {
	const f = fixture();
	f.state.autoClose = true;
	await assert.rejects(f.run(true), /encerramento automático habilitado/);
	assert.deepEqual(f.calls, []);
});

test("a recuperação histórica não importa rotas de distribuição, envio, bot ou push", () => {
	const sourcePath = __filename.replace(/\.test(?=\.[jt]s$)/, "");
	const text = readFileSync(sourcePath, "utf8");
	assert.doesNotMatch(text, /messages-distribution|whatsapp\.service|socket\.service|sendMessage|sendPushNotification|\bbots\/|\.wppChat\.(?:create|update)/);
});
