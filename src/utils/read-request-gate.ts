export class ReadRequestLimitError extends Error {
	constructor(public readonly retryAfterSeconds: number) { super("READ_REQUEST_LIMIT"); }
}

interface Waiter { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }
interface Flight { waiters: Set<Waiter> }
interface Bucket { count: number; resetAt: number; flights: Map<string, Flight> }

/** Only pending work is shared. Completed results are never cached. */
export class ReadRequestGate {
	private readonly buckets = new Map<string, Bucket>();
	constructor(private readonly options = {
		maxRequests: 30, windowMs: 10_000, maxConcurrent: 4, maxWaiters: 8, maxUsers: 5000
	}, private readonly clock: () => number = Date.now) {}

	run<T>(user: string, key: string, execute: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		const now = this.clock();
		for (const [id, bucket] of this.buckets) {
			if (!bucket.flights.size && bucket.resetAt <= now) this.buckets.delete(id);
		}
		let bucket = this.buckets.get(user);
		if (!bucket) {
			if (this.buckets.size >= this.options.maxUsers) return Promise.reject(new ReadRequestLimitError(10));
			bucket = { count: 0, resetAt: now + this.options.windowMs, flights: new Map() };
			this.buckets.set(user, bucket);
		}
		if (now >= bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + this.options.windowMs; }
		if (bucket.count >= this.options.maxRequests) {
			return Promise.reject(new ReadRequestLimitError(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
		}
		bucket.count++;
		let flight = bucket.flights.get(key);
		const isNew = !flight;
		if ((!flight && bucket.flights.size >= this.options.maxConcurrent) ||
			(flight && flight.waiters.size >= this.options.maxWaiters)) {
			return Promise.reject(new ReadRequestLimitError(2));
		}
		if (!flight) { flight = { waiters: new Set() }; bucket.flights.set(key, flight); }
		const active = flight;
		const result = new Promise<T | undefined>((resolve, reject) => {
			const abort = () => { active.waiters.delete(waiter); waiter.cleanup(); resolve(undefined); };
			const waiter: Waiter = {
				resolve: (value) => resolve(value as T), reject,
				cleanup: () => signal?.removeEventListener("abort", abort)
			};
			active.waiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
		if (isNew) {
			const owner = bucket;
			const finish = (ok: boolean, value: unknown) => {
				// A disconnect removes only its waiter, never the running operation.
				owner.flights.delete(key);
				for (const waiter of active.waiters) {
					waiter.cleanup();
					if (ok) waiter.resolve(value); else waiter.reject(value);
				}
				active.waiters.clear();
			};
			void Promise.resolve().then(execute).then(value => finish(true, value), error => finish(false, error));
		}
		return result;
	}
}
