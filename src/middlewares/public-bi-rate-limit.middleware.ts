import { createHash } from "node:crypto";
import { NextFunction, Request, Response } from "express";

const DEFAULT_MAX_REQUESTS = 50;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 4;

interface RateLimitBucket {
	count: number;
	resetAt: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface PublicBiRateLimitDecision {
	allowed: boolean;
	limit: number;
	remaining: number;
	retryAfterSeconds: number;
}

export class PublicBiRateLimiter {
	private readonly buckets = new Map<string, RateLimitBucket>();
	private nextCleanupAt = 0;

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
		private readonly clock: () => number = Date.now
	) {
		if (!Number.isInteger(limit) || limit <= 0) throw new Error("rate limit must be a positive integer");
		if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("rate limit window must be positive");
	}

	public consume(key: string): PublicBiRateLimitDecision {
		const now = this.clock();
		this.cleanupExpired(now);
		let bucket = this.buckets.get(key);

		if (!bucket || bucket.resetAt <= now) {
			bucket = { count: 0, resetAt: now + this.windowMs };
			this.buckets.set(key, bucket);
		}

		const allowed = bucket.count < this.limit;
		if (allowed) bucket.count += 1;

		return {
			allowed,
			limit: this.limit,
			remaining: Math.max(0, this.limit - bucket.count),
			retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
		};
	}

	private cleanupExpired(now: number) {
		if (now < this.nextCleanupAt) return;
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) this.buckets.delete(key);
		}
		this.nextCleanupAt = now + this.windowMs;
	}
}

const maxRequests = positiveInteger(process.env["PUBLIC_BI_RATE_LIMIT_MAX_REQUESTS"], DEFAULT_MAX_REQUESTS);
const windowMs = positiveInteger(process.env["PUBLIC_BI_RATE_LIMIT_WINDOW_MS"], DEFAULT_WINDOW_MS);
const maxConcurrent = positiveInteger(process.env["PUBLIC_BI_MAX_CONCURRENT_REQUESTS"], DEFAULT_MAX_CONCURRENT);
const limiter = new PublicBiRateLimiter(maxRequests, windowMs);
const activeRequests = new Map<string, number>();

function requestKey(req: Request): string {
	const authorization = String(req.headers["authorization"] || "").trim();
	const identity = authorization || req.ip || req.socket.remoteAddress || "unknown";
	return createHash("sha256").update(identity).digest("hex");
}

export default function publicBiRateLimit(req: Request, res: Response, next: NextFunction) {
	const key = requestKey(req);
	const decision = limiter.consume(key);
	res.setHeader("RateLimit-Limit", String(decision.limit));
	res.setHeader("RateLimit-Remaining", String(decision.remaining));
	res.setHeader("RateLimit-Reset", String(decision.retryAfterSeconds));

	if (!decision.allowed) {
		res.setHeader("Retry-After", String(decision.retryAfterSeconds));
		res.status(429).json({ message: "Too many BI API requests" });
		return;
	}

	const active = activeRequests.get(key) || 0;
	if (active >= maxConcurrent) {
		res.setHeader("Retry-After", "1");
		res.status(429).json({ message: "Too many concurrent BI API requests" });
		return;
	}

	activeRequests.set(key, active + 1);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const current = activeRequests.get(key) || 1;
		if (current <= 1) activeRequests.delete(key);
		else activeRequests.set(key, current - 1);
	};
	res.once("finish", release);
	res.once("close", release);
	next();
}
