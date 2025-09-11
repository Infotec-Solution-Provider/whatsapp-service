import { promises as fs } from "fs";
import path from "path";

export interface JsonSessionStoreOptions {
  dir?: string; // defaults to 'data'
  filename: string; // e.g., 'exatron-satisfaction.sessions.json'
  debounceMs?: number; // defaults to 250ms
}

/**
 * Lightweight JSON store with lazy loading and debounced saving.
 * Persists data as { sessions: T[] } for compatibility with existing format.
 */
export default class JsonSessionStore<T> {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly debounceMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: JsonSessionStoreOptions) {
    const dir = options.dir ?? "data";
    this.dir = path.resolve(process.cwd(), dir);
    this.filePath = path.join(this.dir, options.filename);
    this.debounceMs = options.debounceMs ?? 250;
  }

  /** Ensure the JSON file is loaded once, and pass the array to the provided consumer. */
  async ensureLoaded(consume: (arr: T[]) => void): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const arr = await this.load();
        try {
          consume(arr);
        } finally {
          this.initialized = true;
        }
      })();
    }
    await this.initPromise;
  }

  /** Read the array from disk; returns [] if missing/invalid. */
  private async load(): Promise<T[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const data = JSON.parse(content) as { sessions: T[] } | T[] | null;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.sessions)) return data.sessions;
      return [];
    } catch {
      return [];
    }
  }

  /** Debounced save; dataProvider is called at save-time. */
  scheduleSave(dataProvider: () => Iterable<T>) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save(dataProvider).catch(() => {});
    }, this.debounceMs);
  }

  private async save(dataProvider: () => Iterable<T>) {
    const data = Array.from(dataProvider());
    await fs.mkdir(this.dir, { recursive: true });
    const payload = { sessions: data };
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
  }
}
