import assert from "node:assert/strict";
import axios from "axios";
import { Logger } from "@in.pulse-crm/utils";
import { pipelineEnrollmentRetryDelayMs } from "../services/pipeline-enrollment-outbox.service";
import pipelineEnrollmentOutboxService from "../services/pipeline-enrollment-outbox.service";
import prismaService from "../services/prisma.service";
import { readyMessagePipelineSource, templatePipelineSource } from "./pipeline-trigger-source";

assert.deepEqual(readyMessagePipelineSource(12), {
	sourceType: "READY_MESSAGE",
	sourceKey: "ready-message:12",
});
assert.deepEqual(templatePipelineSource("WABA", " PROMO_AGOSTO ", "PT_BR"), {
	sourceType: "WHATSAPP_TEMPLATE",
	sourceKey: "template:waba:promo_agosto:pt_br",
});
assert.equal(pipelineEnrollmentRetryDelayMs(0), 1_000);
assert.equal(pipelineEnrollmentRetryDelayMs(3), 8_000);
assert.equal(pipelineEnrollmentRetryDelayMs(20), 256_000);

async function testOutboxDeliveryStates(): Promise<void> {
	const now = new Date();
	const rows = new Map<string, any>([
		["success", { id: "success", idempotencyKey: "event-success", instance: "acme", sourceType: "READY_MESSAGE", sourceKey: "success", messageId: 1, contactId: 1, customerId: 10, status: "PENDING", retryCount: 0, nextAttemptAt: now, lockedUntil: null, lockedBy: null }],
		["retry", { id: "retry", idempotencyKey: "event-retry", instance: "acme", sourceType: "READY_MESSAGE", sourceKey: "retry", messageId: 2, contactId: 2, customerId: 20, status: "PENDING", retryCount: 0, nextAttemptAt: now, lockedUntil: null, lockedBy: null }],
		["invalid", { id: "invalid", idempotencyKey: "event-invalid", instance: "acme", sourceType: "WHATSAPP_TEMPLATE", sourceKey: "invalid", messageId: 3, contactId: null, customerId: null, status: "PENDING", retryCount: 0, nextAttemptAt: now, lockedUntil: null, lockedBy: null }],
	]);
	const delegate = prismaService.pipelineEnrollmentOutbox as any;
	const matches = (row: any, where: any): boolean => {
		if (where.id !== undefined && row.id !== where.id) return false;
		if (where.status !== undefined && row.status !== where.status) return false;
		if (where.lockedBy !== undefined && row.lockedBy !== where.lockedBy) return false;
		if (where.nextAttemptAt?.lte && row.nextAttemptAt > where.nextAttemptAt.lte) return false;
		if (where.lockedUntil?.lt && (!row.lockedUntil || row.lockedUntil >= where.lockedUntil.lt)) return false;
		return true;
	};
	delegate.updateMany = async ({ where, data }: any) => {
		let count = 0;
		for (const [id, row] of rows) {
			if (!matches(row, where)) continue;
			rows.set(id, { ...row, ...data });
			count += 1;
		}
		return { count };
	};
	delegate.findMany = async ({ where, take }: any) =>
		[...rows.values()].filter((row) => matches(row, where)).slice(0, take);
	delegate.findUnique = async ({ where }: any) => rows.get(where.id) ?? null;

	const originalPost = axios.post;
	const originalLoggerError = Logger.error;
	(Logger as any).error = () => undefined;
	(axios as any).post = async (_url: string, body: any) => {
		if (body.sourceKey === "retry") {
			throw Object.assign(new Error("marketing unavailable"), { isAxiosError: true, response: { status: 503 } });
		}
		if (body.sourceKey === "invalid") {
			throw Object.assign(new Error("invalid event"), { isAxiosError: true, response: { status: 400 } });
		}
		return { status: 200 };
	};
	try {
		await pipelineEnrollmentOutboxService.processOnce();
	} finally {
		(axios as any).post = originalPost;
		(Logger as any).error = originalLoggerError;
	}

	assert.equal(rows.get("success")?.status, "COMPLETED");
	assert.equal(rows.get("retry")?.status, "PENDING");
	assert.equal(rows.get("retry")?.retryCount, 1);
	assert.equal(rows.get("invalid")?.status, "FAILED");
	assert.equal(rows.get("invalid")?.retryCount, 1);
}

testOutboxDeliveryStates()
	.then(() => console.log("pipeline enrollment outbox tests passed"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
