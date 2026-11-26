import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import MessageDto from "../types/remote-client.types";
import {
	assertRemoteInboundPayloadMatches,
	calculateRemoteInboundRetryDelayMs,
	hashRemoteInboundPayload,
	RemoteInboundInboxRequestError,
	resolveRemoteInboundIdempotencyKey
} from "./remote-inbound-event-inbox.service";
import remoteInboundEventInboxService from "./remote-inbound-event-inbox.service";
import prismaService from "./prisma.service";

const message: MessageDto = {
	instance: "acme",
	clientId: 7,
	from: "5511999999999",
	to: "me:5511888888888",
	body: "ola",
	type: "chat",
	timestamp: "1786975200000",
	sentAt: new Date("2026-08-17T12:00:00.000Z"),
	status: "RECEIVED",
	wwebjsIdStanza: "stanza-123",
	isGroup: false
};

const payload = { type: "message-received" as const, clientId: 7, message };
const reorderedPayload = {
	message,
	clientId: 7,
	type: "message-received" as const
};

assert.equal(hashRemoteInboundPayload(payload), hashRemoteInboundPayload({ ...reorderedPayload, message }));
assert.notEqual(
	hashRemoteInboundPayload(payload),
	hashRemoteInboundPayload({ ...payload, message: { ...message, body: "conteudo diferente" } })
);

assert.equal(resolveRemoteInboundIdempotencyKey("  explicit-key  ", 7, message), "explicit-key");
assert.equal(
	resolveRemoteInboundIdempotencyKey(undefined, 7, message),
	"remote-message:v1:7:stanza-123"
);
assert.throws(
	() => resolveRemoteInboundIdempotencyKey(undefined, 7, { ...message, wwebjsIdStanza: null }),
	(error) => error instanceof RemoteInboundInboxRequestError && error.statusCode === 400
);
assert.throws(
	() => resolveRemoteInboundIdempotencyKey("x".repeat(192), 7, message),
	RemoteInboundInboxRequestError
);

assert.doesNotThrow(() => assertRemoteInboundPayloadMatches("key", "same", "same"));
assert.throws(
	() => assertRemoteInboundPayloadMatches("key", "old", "new"),
	(error) => error instanceof RemoteInboundInboxRequestError && error.statusCode === 409
);

assert.equal(calculateRemoteInboundRetryDelayMs(0), 1_000);
assert.equal(calculateRemoteInboundRetryDelayMs(3), 8_000);
assert.equal(calculateRemoteInboundRetryDelayMs(100), 256_000);

async function testDurableEnqueueContract(): Promise<void> {
	const rows = new Map<string, any>();
	const delegate = prismaService.remoteInboundEventInbox as any;
	let concurrentFinds = 0;
	let releaseConcurrentFinds: (() => void) | null = null;
	const concurrentFindGate = new Promise<void>((resolve) => {
		releaseConcurrentFinds = resolve;
	});
	const findByWhere = (where: any) => [...rows.values()].find((row) =>
		where.OR.some((condition: any) =>
			(condition.idempotencyKey && row.idempotencyKey === condition.idempotencyKey) ||
			(condition.clientId === row.clientId &&
				condition.eventType === row.eventType &&
				condition.providerMessageId === row.providerMessageId)
		)
	) ?? null;
	delegate.findFirst = async ({ where }: any) => {
		const stanza = where.OR.find((condition: any) => condition.providerMessageId)?.providerMessageId;
		if (stanza === "stanza-concurrent" && !findByWhere(where) && concurrentFinds < 2) {
			concurrentFinds += 1;
			if (concurrentFinds === 2) releaseConcurrentFinds?.();
			await concurrentFindGate;
		}
		return findByWhere(where);
	};
	delegate.create = async ({ data }: any) => {
		if ([...rows.values()].some((row) =>
			row.idempotencyKey === data.idempotencyKey ||
			(row.clientId === data.clientId &&
				row.eventType === data.eventType &&
				row.providerMessageId === data.providerMessageId)
		)) {
			throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
				code: "P2002",
				clientVersion: "test"
			});
		}
		const row = {
			...data,
			id: `inbox-${rows.size + 1}`,
			status: "PENDING",
			retryCount: 0,
			error: null,
			messageId: null,
			lockedUntil: null,
			lockedBy: null,
			processingStartedAt: null,
			nextAttemptAt: new Date(),
			completedAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
		};
		rows.set(data.idempotencyKey, row);
		return row;
	};
	delegate.update = async ({ where, data }: any) => {
		const current = [...rows.values()].find((row) => row.id === where.id);
		const updated = { ...current, ...data };
		rows.set(updated.idempotencyKey, updated);
		return updated;
	};

	const first = await remoteInboundEventInboxService.enqueue(7, message, "delivery-key");
	assert.equal(first.created, true);
	assert.equal(first.status, "PENDING");

	const duplicate = await remoteInboundEventInboxService.enqueue(7, message, "delivery-key");
	assert.equal(duplicate.created, false);
	assert.equal(duplicate.id, first.id);

	const legacyCopy = { ...message, wwebjsId: "legacy-copy", body: "legacy interpretation" };
	const legacyKeyDuplicate = await remoteInboundEventInboxService.enqueue(7, legacyCopy);
	assert.equal(legacyKeyDuplicate.created, false);
	assert.equal(legacyKeyDuplicate.id, first.id);
	assert.equal(legacyKeyDuplicate.idempotencyKey, "delivery-key");
	assert.equal(rows.get(first.idempotencyKey).payload.message.body, message.body);

	const oldFirst = { ...legacyCopy, wwebjsIdStanza: "stanza-legacy-first" };
	const oldResult = await remoteInboundEventInboxService.enqueue(7, oldFirst);
	const newResult = await remoteInboundEventInboxService.enqueue(
		7,
		{ ...oldFirst, wwebjsId: "canonical-copy", body: "canonical interpretation" },
		"wa-inbound:v1:legacy-first"
	);
	assert.equal(oldResult.created, true);
	assert.equal(newResult.created, false);
	assert.equal(newResult.id, oldResult.id);
	assert.equal(newResult.idempotencyKey, "remote-message:v1:7:stanza-legacy-first");
	assert.equal(rows.get(oldResult.idempotencyKey).payload.message.wwebjsId, "legacy-copy");

	const divergentSecondSource = await remoteInboundEventInboxService.enqueue(
		7,
		{ ...message, body: "interpretação diferente do segundo produtor" },
		"second-producer-key"
	);
	assert.equal(divergentSecondSource.created, false);
	assert.equal(divergentSecondSource.id, first.id);

	await assert.rejects(
		remoteInboundEventInboxService.enqueue(7, { ...message, body: "conflito" }, "delivery-key"),
		(error) => error instanceof RemoteInboundInboxRequestError && error.statusCode === 409
	);

	const concurrentLegacy = { ...legacyCopy, wwebjsIdStanza: "stanza-concurrent" };
	const concurrentCanonical = { ...concurrentLegacy, wwebjsId: "canonical-copy", body: "canonical interpretation" };
	const concurrent = await Promise.all([
		remoteInboundEventInboxService.enqueue(7, concurrentLegacy),
		remoteInboundEventInboxService.enqueue(7, concurrentCanonical, "wa-inbound:v1:concurrent")
	]);
	assert.deepEqual(concurrent.map((result) => result.created).sort(), [false, true]);
	assert.equal(concurrent[0]?.id, concurrent[1]?.id);
	assert.equal(concurrent[0]?.idempotencyKey, concurrent[1]?.idempotencyKey);
	const winner = concurrent[0].created ? concurrentLegacy : concurrentCanonical;
	assert.equal(rows.get(concurrent[0].idempotencyKey).payload.message.wwebjsId, winner.wwebjsId);
	assert.equal(concurrentFinds, 2);
	assert.equal([...rows.values()].filter((row) => row.providerMessageId === "stanza-concurrent").length, 1);

	const receipt = await remoteInboundEventInboxService.enqueueStatus(7, "stanza-123", "READ");
	const replay = await remoteInboundEventInboxService.enqueueStatus(7, "stanza-123", "READ");
	assert.equal(replay.id, receipt.id);
	assert.equal(replay.created, false);
	assert.notEqual((await remoteInboundEventInboxService.enqueueStatus(7, "stanza-123", "RECEIVED")).id, receipt.id);
	assert.notEqual((await remoteInboundEventInboxService.enqueueStatus(8, "stanza-123", "READ")).id, receipt.id);
	assert.equal(rows.get(receipt.idempotencyKey).maxRetries, 0);
	await assert.rejects(remoteInboundEventInboxService.enqueueStatus(7, "", "READ"), RemoteInboundInboxRequestError);
	await assert.rejects(remoteInboundEventInboxService.enqueueStatus(7, "id", "INVALID"), RemoteInboundInboxRequestError);
	delegate.create = async () => { throw new Error("P2024 database unavailable"); };
	await assert.rejects(remoteInboundEventInboxService.enqueueStatus(7, "new-id", "READ"), /P2024/);
}

testDurableEnqueueContract()
	.then(() => console.log("Remote inbound event inbox tests passed"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
