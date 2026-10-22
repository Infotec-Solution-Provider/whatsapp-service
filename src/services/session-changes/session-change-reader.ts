import type { SessionData } from "../../sdk-local";
import { cursorScope, decodeCursor, encodeCursor } from "./session-change-cursor";

export interface StreamHead { epoch: string; sequence: string; floorSequence: string }
export interface JournalRow {
	sequence: string; kind: string; entityId: number; chatId: number | null;
	previousUserId: number | null; previousWalletId: number | null; previousSectorId: number | null;
}
export interface ChangeRepository {
	wallets(session: SessionData): Promise<number[]>;
	read(instance: string, after: string | null, limit: number): Promise<{ head: StreamHead; rows: JournalRow[] }>;
	project(session: SessionData, rows: JournalRow[], wallets: number[]): Promise<unknown>;
}

/** The cursor describes examined journal rows, including events invisible to this user. */
export class SessionChangeReader {
	constructor(private readonly repository: ChangeRepository) {}
	public async capture(session: SessionData): Promise<string> {
		const wallets = await this.repository.wallets(session);
		const { head } = await this.repository.read(session.instance, null, 0);
		return encodeCursor(cursorScope(session, wallets), head.epoch, head.sequence);
	}
	public async read(session: SessionData, value: unknown, limit: number) {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid change page size");
		const wallets = await this.repository.wallets(session);
		const scope = cursorScope(session, wallets);
		const cursor = decodeCursor(value, scope);
		const { head, rows } = await this.repository.read(session.instance, cursor?.sequence ?? null, limit + 1);
		if (!cursor || cursor.epoch !== head.epoch || BigInt(cursor.sequence) < BigInt(head.floorSequence) ||
			BigInt(cursor.sequence) > BigInt(head.sequence)) {
			return { resetRequired: true, changes: null, nextCursor: null, hasMore: false };
		}
		const page = rows.slice(0, limit);
		const changes = await this.repository.project(session, page, wallets);
		return {
			resetRequired: false, changes,
			nextCursor: encodeCursor(scope, head.epoch, page.at(-1)?.sequence ?? cursor.sequence),
			hasMore: rows.length > limit
		};
	}
}
