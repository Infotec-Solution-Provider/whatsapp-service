import { promises as fs } from "node:fs";
import path from "node:path";

/** Atomic, awaitable persistence for the existing survey session file. One service process owns it. */
export class SatisfactionSessionStore<T> {
	private loaded: Promise<void> | null = null;
	private tail: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | null = null;
	constructor(private readonly filePath: string) {}

	async ensureLoaded(consume: (sessions: T[]) => void): Promise<void> {
		if (!this.loaded) this.loaded = (async () => {
			let content: string;
			try { content = await fs.readFile(this.filePath, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") { consume([]); return; }
				throw new Error("SURVEY_SESSION_READ_FAILED");
			}
			const value: unknown = JSON.parse(content);
			const sessions = Array.isArray(value) ? value : (value as { sessions?: unknown })?.sessions;
			if (!Array.isArray(sessions)) throw new Error("SURVEY_SESSION_FILE_INVALID");
			consume(sessions as T[]);
		})();
		return this.loaded;
	}

	save(provider: () => Iterable<T>): Promise<void> {
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		const payload = JSON.stringify({ sessions: Array.from(provider()) });
		const write = this.tail.then(async () => {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			const temporary = `${this.filePath}.tmp`;
			const handle = await fs.open(temporary, "w", 0o600);
			try { await handle.writeFile(payload, "utf8"); await handle.sync(); }
			finally { await handle.close(); }
			await fs.rename(temporary, this.filePath);
		});
		this.tail = write.catch(() => {});
		return write;
	}

	scheduleSave(provider: () => Iterable<T>): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.save(provider).catch(() => console.error("[exatron-satisfaction] SURVEY_SESSION_SAVE_FAILED"));
		}, 250);
	}
}
