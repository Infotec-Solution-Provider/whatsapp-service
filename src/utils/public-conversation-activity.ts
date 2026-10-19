import { BadRequestError } from "@rgranatodutra/http-errors";

export interface PublicConversationsFilters {
	page: number;
	limit: number;
	isFinished?: boolean;
	userId?: number;
	sectorId?: number;
	contactId?: number;
	search?: string;
	startedFrom?: Date;
	startedTo?: Date;
	finishedFrom?: Date;
	finishedTo?: Date;
	updatedFrom?: Date;
	updatedTo?: Date;
}

// Bound the event window without loading all matching conversation IDs into Node.
export const MAX_ACTIVITY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export function parseConversationActivityRange(from: unknown, to: unknown, now = new Date()) {
	const parse = (value: unknown, field: string) => {
		if (value === undefined || value === "") return undefined;
		if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
			throw new BadRequestError(`${field} must be an ISO date with timezone!`);
		}
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) throw new BadRequestError(`${field} must be a valid date!`);
		return parsed;
	};
	const updatedFrom = parse(from, "updatedFrom");
	const updatedTo = parse(to, "updatedTo");
	if (!updatedFrom && !updatedTo) return {};
	if (!updatedFrom) throw new BadRequestError("updatedFrom is required with updatedTo!");
	const end = updatedTo ?? now;
	if (updatedFrom > end) throw new BadRequestError("updatedFrom must be before or equal to updatedTo!");
	if (end.getTime() - updatedFrom.getTime() > MAX_ACTIVITY_WINDOW_MS) {
		throw new BadRequestError("The updatedFrom/updatedTo window must not exceed 31 days; split the extraction into windows.");
	}
	return { updatedFrom, updatedTo: end };
}

/** Activity is an event-window predicate, not a durable audit of arbitrary row edits. */
export function buildConversationActivityQueries(instance: string, filters: PublicConversationsFilters) {
	if (!filters.updatedFrom || !filters.updatedTo) throw new Error("Activity query requires both boundaries");
	const values: Array<string | number | Date> = [instance];
	const conditions = ["ch.instance = ?"];
	const add = (condition: string, value: string | number | Date) => { conditions.push(condition); values.push(value); };
	if (filters.isFinished !== undefined) add("ch.is_finished = ?", filters.isFinished ? 1 : 0);
	if (filters.userId !== undefined) add("ch.user_id = ?", filters.userId);
	if (filters.sectorId !== undefined) add("ch.sector_id = ?", filters.sectorId);
	if (filters.contactId !== undefined) add("ch.contact_id = ?", filters.contactId);
	if (filters.startedFrom) add("ch.started_at >= ?", filters.startedFrom);
	if (filters.startedTo) add("ch.started_at <= ?", filters.startedTo);
	if (filters.finishedFrom) add("ch.finished_at >= ?", filters.finishedFrom);
	if (filters.finishedTo) add("ch.finished_at <= ?", filters.finishedTo);
	if (filters.search) {
		conditions.push("EXISTS (SELECT 1 FROM contacts search_contact WHERE search_contact.id = ch.contact_id AND search_contact.instance = ch.instance AND (search_contact.name LIKE ? OR search_contact.phone LIKE ? OR search_contact.whatsapp_id LIKE ?))");
		const pattern = `%${filters.search}%`;
		values.push(pattern, pattern, pattern);
	}
	const range = (column: string) => {
		values.push(filters.updatedFrom!, filters.updatedTo!);
		return `${column} >= ? AND ${column} <= ?`;
	};
	conditions.push(`(
		(${range("ch.started_at")})
		OR (${range("ch.finished_at")})
		OR EXISTS (SELECT 1 FROM messages activity_message WHERE activity_message.instance = ch.instance AND activity_message.chat_id = ch.id AND ${range("activity_message.sent_at")})
		OR EXISTS (SELECT 1 FROM chat_transfer_history activity_transfer WHERE activity_transfer.instance = ch.instance AND activity_transfer.chat_id = ch.id AND ${range("activity_transfer.transferred_at")})
		OR EXISTS (SELECT 1 FROM contacts activity_contact WHERE activity_contact.instance = ch.instance AND activity_contact.id = ch.contact_id AND ${range("activity_contact.updated_at")})
	)`);
	const predicate = `FROM chats ch WHERE ${conditions.join(" AND ")}`;
	return {
		countSql: `SELECT COUNT(*) AS total ${predicate}`,
		pageSql: `SELECT ch.id ${predicate} ORDER BY ch.started_at DESC, ch.id DESC LIMIT ? OFFSET ?`,
		values,
		pageValues: [...values, filters.limit, (filters.page - 1) * filters.limit]
	};
}
