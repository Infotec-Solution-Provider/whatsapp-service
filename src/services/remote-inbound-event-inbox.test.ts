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
		const key = where.OR.find((condition: any) => condition.idempotencyKey)?.idempotencyKey;
		if (key === "concurrent-key" && !findByWhere(where) && concurrentFinds < 2) {
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

	const legacyKeyDuplicate = await remoteInboundEventInboxService.enqueue(7, message, "legacy-direct-key");
	assert.equal(legacyKeyDuplicate.created, false);
	assert.equal(legacyKeyDuplicate.id, first.id);
	assert.equal(legacyKeyDuplicate.idempotencyKey, "delivery-key");
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

	const concurrentMessage = { ...message, wwebjsIdStanza: "stanza-concurrent" };
	const concurrent = await Promise.all([
		remoteInboundEventInboxService.enqueue(7, concurrentMessage, "concurrent-key"),
		remoteInboundEventInboxService.enqueue(7, concurrentMessage, "concurrent-key")
	]);
	assert.deepEqual(concurrent.map((result) => result.created).sort(), [false, true]);
	assert.equal(concurrent[0]?.id, concurrent[1]?.id);
}

testDurableEnqueueContract()
	.then(() => console.log("Remote inbound event inbox tests passed"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
