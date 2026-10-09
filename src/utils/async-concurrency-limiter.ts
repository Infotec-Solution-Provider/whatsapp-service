/** Queue accepted work without dropping it; only running work consumes a slot. */
export class AsyncConcurrencyLimiter {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer");
	}

	public async run<T>(work: () => Promise<T>): Promise<T> {
		await new Promise<void>((resolve) => {
			const start = () => { this.active++; resolve(); };
			if (this.active < this.limit) start();
			else this.waiting.push(start);
		});
		try {
			return await work();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

/** Serialize transitions for one message, and release keys after completion. */
export class AsyncKeyedSequencer {
	private readonly tails = new Map<string, Promise<void>>();
	public async run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((resolve) => { release = resolve; });
		this.tails.set(key, tail);
		await previous;
		try { return await work(); }
		finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}
