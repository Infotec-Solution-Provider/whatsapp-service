import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

type TraceWriter = (entry: Record<string, unknown>) => void;
const writeTrace: TraceWriter = (entry) => console.info("[message-send]", JSON.stringify(entry));

/** Runs before authentication and multipart parsing, where controller logs cannot reach. */
export function createMessageSendTrace(write: TraceWriter = writeTrace) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const header = req.headers["idempotency-key"] ?? req.headers["x-upload-trace-id"];
		const traceId = typeof header === "string" && /^[A-Za-z0-9:_-]{8,128}$/.test(header) ? header : randomUUID();
		const startedAt = Date.now();
		let stage = "authentication";
		const emit = (event: string, details: Record<string, unknown> = {}) => {
			try {
				write({ at: new Date().toISOString(), traceId, event, stage,
					clientId: Number(req.params["clientId"]) || undefined,
					instance: req.session?.instance, userId: req.session?.userId,
					elapsedMs: Date.now() - startedAt, ...details });
			} catch { /* Logging must never interrupt delivery or change its outcome. */ }
		};
		res.locals["messageSendTraceId"] = traceId;
		res.locals["messageSendStage"] = (nextStage: string, details?: Record<string, unknown>) => {
			stage = nextStage;
			emit("stage", details);
		};
		emit("received");
		res.once("finish", () => emit("response", { httpStatus: res.statusCode }));
		res.once("close", () => {
			if (!res.writableFinished) emit("connection.closed");
		});
		next();
	};
}

export function markMessageSendStage(res: Response, stage: string, details?: Record<string, unknown>): void {
	res.locals["messageSendStage"]?.(stage, details);
}

export default createMessageSendTrace();
