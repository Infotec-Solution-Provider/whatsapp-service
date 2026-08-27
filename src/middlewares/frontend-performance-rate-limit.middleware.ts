import { NextFunction, Request, Response } from "express";
import type { SessionData } from "../sdk-local";

export const FRONTEND_PERFORMANCE_RATE_LIMIT_MAX_REQUESTS = 30;
export const FRONTEND_PERFORMANCE_RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitBucket {
	count: number;
	resetAt: number;
}

export interface FrontendPerformanceRateLimitDecision {
	allowed: boolean;
	limit: number;
	remaining: number;
	resetAt: number;
	retryAfterSeconds: number;
}

/**
 * Limita a ingestao por identidade autenticada. A instancia e o usuario usados
 * na chave devem vir exclusivamente de req.session, nunca do corpo/cabecalhos
 * enviados pelo frontend.
 */
export class FrontendPerformanceRateLimiter {
	private readonly buckets = new Map<string, RateLimitBucket>();
	private nextCleanupAt = 0;

	constructor(
		private readonly limit = FRONTEND_PERFORMANCE_RATE_LIMIT_MAX_REQUESTS,
		private readonly windowMs = FRONTEND_PERFORMANCE_RATE_LIMIT_WINDOW_MS,
		private readonly clock: () => number = Date.now
	) {
		if (!Number.isInteger(limit) || limit <= 0) throw new Error("rate limit must be a positive integer");
		if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("rate limit window must be positive");
	}

	public consume(instance: string, userId: number): FrontendPerformanceRateLimitDecision {
		const now = this.clock();
		this.cleanupExpired(now);

		// JSON preserves the boundary between both trusted dimensions and avoids
		// collisions caused by separator characters in instance names.
		const key = JSON.stringify([instance, userId]);
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
			resetAt: bucket.resetAt,
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

const frontendPerformanceRateLimiter = new FrontendPerformanceRateLimiter();

export default function frontendPerformanceRateLimit(req: Request, res: Response, next: NextFunction) {
	// Keep this module compilable in focused ts-node tests, which do not load the
	// project's ambient Express augmentation from global.d.ts.
	const session = (req as Request & { session: SessionData }).session;
	const decision = frontendPerformanceRateLimiter.consume(session.instance, session.userId);
	res.setHeader("RateLimit-Limit", String(decision.limit));
	res.setHeader("RateLimit-Remaining", String(decision.remaining));
	res.setHeader("RateLimit-Reset", String(decision.retryAfterSeconds));

	if (!decision.allowed) {
		res.setHeader("Retry-After", String(decision.retryAfterSeconds));
		res.status(429).json({ message: "Too many frontend performance telemetry batches" });
		return;
	}

	next();
}
