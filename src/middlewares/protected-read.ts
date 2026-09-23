import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { ReadRequestGate, ReadRequestLimitError } from "../utils/read-request-gate";

const gate = new ReadRequestGate();

export function readRequestKey(operation: string, req: Pick<Request, "session" | "params" | "query" | "body">): string {
	let nodes = 0;
	const canonical = (value: unknown, depth = 0): unknown => {
		if (++nodes > 2000 || depth > 12) throw new RangeError("READ_FILTER_TOO_LARGE");
		if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.keys(value).sort().map(key =>
				[key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
		}
		return value;
	};
	const encoded = JSON.stringify(canonical([operation, req.session, req.params, req.query, req.body ?? null]));
	if (encoded.length > 32768) throw new RangeError("READ_FILTER_TOO_LARGE");
	return createHash("sha256").update(encoded).digest("hex");
}

/** Install after authentication/authorization, only on side-effect-free JSON reads. */
export default function protectedRead(operation: string, read: (req: Request) => Promise<unknown>, admission = gate) {
	return async (req: Request, res: Response): Promise<void> => {
		if (!req.session) { res.status(401).json({ message: "Unauthorized!" }); return; }
		let key: string;
		try { key = readRequestKey(operation, req); }
		catch { res.status(400).json({ message: "Filtros de consulta muito grandes." }); return; }
		const controller = new AbortController();
		const disconnect = () => controller.abort();
		res.once("close", disconnect);
		if (res.destroyed) controller.abort();
		try {
			const user = JSON.stringify([req.session.instance, req.session.userId]);
			const result = await admission.run(user, key, () => read(req), controller.signal);
			if (!controller.signal.aborted) res.status(200).json(result);
		} catch (error) {
			if (controller.signal.aborted) return;
			if (!(error instanceof ReadRequestLimitError)) throw error;
			res.setHeader("Retry-After", String(error.retryAfterSeconds));
			res.status(429).json({
				code: "READ_REQUEST_LIMIT",
				retryAfterSeconds: error.retryAfterSeconds,
				message: `Muitos carregamentos seguidos. Aguarde ${error.retryAfterSeconds} segundos antes de tentar novamente.`
			});
		} finally { res.removeListener("close", disconnect); }
	};
}
