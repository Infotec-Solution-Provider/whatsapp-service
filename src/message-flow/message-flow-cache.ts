/** Process-local cache. Invalidation also fences a load already in progress. */
export class MessageFlowCache<T> {
	private readonly entries = new Map<string, { generation: number; value: Promise<T> }>();
	private readonly generations = new Map<string, number>();
	private key(instance: string, sectorId: number): string { return JSON.stringify([instance, sectorId]); }

	async get(instance: string, sectorId: number, load: () => Promise<T>): Promise<T> {
		const key = this.key(instance, sectorId);
		while (true) {
			const generation = this.generations.get(key) ?? 0;
			let entry = this.entries.get(key);
			if (!entry || entry.generation !== generation) {
				entry = { generation, value: Promise.resolve().then(load) };
				this.entries.set(key, entry);
			}
			try {
				const value = await entry.value;
				if ((this.generations.get(key) ?? 0) !== generation) continue;
				return value;
			} catch (error) {
				if (this.entries.get(key) === entry) this.entries.delete(key);
				if ((this.generations.get(key) ?? 0) !== generation) continue;
				throw error;
			}
		}
	}

	invalidate(instance: string, sectorId: number): void {
		const key = this.key(instance, sectorId);
		this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
		this.entries.delete(key);
	}
}

import type MessageFlow from "./message-flow";
export const messageFlowCache = new MessageFlowCache<MessageFlow>();
