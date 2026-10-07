import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../../sdk-local";
import { safeDecode } from "../../utils/safe-encode";
import { monitorScope, type MonitorExecute, type MonitorRow } from "./monitor-reader";

export interface MonitorHistoryInput {
	type: unknown;
	id: unknown;
	limit?: unknown;
	beforeId?: unknown;
}
function positive(value: unknown, field: string, max = 2147483647): number {
	if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value)))
		throw new BadRequestError(`${field} inválido.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new BadRequestError(`${field} inválido.`);
	return parsed;
}
export async function readMonitorMessages(
	execute: MonitorExecute,
	session: SessionData,
	useLocal: boolean,
	input: MonitorHistoryInput
) {
	if (input.type !== "wpp" && input.type !== "internal") throw new BadRequestError("Tipo de conversa inválido.");
	const id = positive(input.id, "id"),
		limit = input.limit === undefined ? 50 : positive(input.limit, "limit", 100);
	const beforeId = input.beforeId === undefined ? null : positive(input.beforeId, "beforeId");
	const local = input.type === "wpp" && useLocal;
	const table = input.type === "internal" ? "internalchats" : local ? "wpp_chats" : "chats";
	const chatId = local ? "original_id" : "id";
	const scope = monitorScope(session, "c");
	const authorized = await execute(local, {
		sql: `SELECT c.${chatId} AS id FROM ${table} c WHERE ${scope.sql} AND c.${chatId} = ? LIMIT 1`,
		params: [...scope.params, id]
	});
	if (!authorized.length) throw new NotFoundError("Conversa não encontrada na monitoria.");
	const messages = input.type === "internal" ? "internalmessages" : local ? "wpp_messages" : "messages";
	const foreignKey = input.type === "internal" ? "internalchat_id" : "chat_id";
	const pageRows = await execute(local, {
		sql: `SELECT m.* FROM ${messages} m WHERE m.instance = ? AND m.${foreignKey} = ?${beforeId === null ? "" : " AND m.id < ?"} ORDER BY m.id DESC LIMIT ?`,
		params: [session.instance, id, ...(beforeId === null ? [] : [beforeId]), limit + 1]
	});
	const hasMore = pageRows.length > limit,
		selected = pageRows.slice(0, limit);
	const quotedIds = [
		...new Set(
			selected
				.filter((row) => row["quoted_id"] !== null && row["quoted_id"] !== undefined)
				.map((row) => Number(row["quoted_id"]))
		)
	];
	const quotedRows = quotedIds.length
		? await execute(local, {
				sql: `SELECT m.* FROM ${messages} m WHERE m.instance = ? AND m.${foreignKey} = ? AND m.id IN (${quotedIds.map(() => "?").join(",")}) LIMIT ?`,
				params: [session.instance, id, ...quotedIds, limit]
			})
		: [];
	const map = (row: MonitorRow) => {
		const message = Object.fromEntries(
			Object.entries(row).map(([key, value]) => [
				key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
				value
			])
		);
		message["id"] = Number(row["id"]);
		if (input.type === "internal") {
			message["internalChatId"] = id;
			delete message["internalchatId"];
		}
		const decode = (value: unknown) =>
			local || (input.type === "wpp" && session.instance === "vollo") ? safeDecode(String(value)) : String(value);
		message["body"] = decode(row["body"] ?? "") ?? "";
		message["fileName"] = row["file_name"] ? decode(row["file_name"]) : null;
		if (typeof message["mentionMetadata"] === "string") {
			try {
				message["mentionMetadata"] = JSON.parse(
					local ? (safeDecode(message["mentionMetadata"]) ?? "null") : message["mentionMetadata"]
				);
			} catch {
				message["mentionMetadata"] = null;
			}
		}
		return message;
	};
	return {
		messages: selected.reverse().map(map),
		quotedMessages: quotedRows.map(map),
		nextCursor: hasMore ? Number(pageRows[limit - 1]?.["id"]) : null
	};
}
