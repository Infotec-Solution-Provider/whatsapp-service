import type { Prisma, WppContact } from "@prisma/client";
import { withDatabaseTenant } from "../utils/database-tenant-context";

type Reader = Pick<Prisma.TransactionClient, "wppChat" | "$queryRawUnsafe">;
interface Origin {
	id: number;
	channelId: number | null;
}

export function findChatForContactChannel(
	db: Reader & Pick<Prisma.TransactionClient, "wppClient">,
	channelId: number,
	contact: Pick<WppContact, "instance" | "id">
) {
	return withDatabaseTenant(contact.instance, async () => {
		const client = await db.wppClient.findFirst({
			where: { id: channelId, instance: contact.instance },
			select: { sectors: { where: { instance: contact.instance }, select: { id: true } } }
		});
		return client
			? openChatForChannel(
					db,
					contact.instance,
					contact.id,
					channelId,
					client.sectors.map((s) => s.id)
				)
			: null;
	});
}

/** A pinned session or the first public message with a provider number identifies the origin.
 * Old outbound chats may contain only internal notes until the first customer message.
 */
export async function openChatForChannel(
	db: Reader,
	instance: string,
	contactId: number,
	channelId: number,
	sectorIds: number[]
) {
	if (!sectorIds.length) return null;
	const chats = await db.wppChat.findMany({
		where: { instance, contactId, isFinished: false, sectorId: { in: sectorIds } },
		orderBy: { id: "desc" }
	});
	if (!chats.length) return null;
	const ids = chats.map((chat) => chat.id);
	const firstPublicChannel =
		"(SELECT m.client_id FROM messages m WHERE m.instance=? AND m.chat_id=c.id AND m.client_id IS NOT NULL " +
		"AND m.`from`<>'' AND m.`from` NOT REGEXP '^(system|thirdparty:)' " +
		"AND m.type NOT REGEXP '^(system|thirdparty|reaction|revoked|protocol|ciphertext|notification|call_log)(:|$)' " +
		"ORDER BY m.id LIMIT 1)";
	const scope = " WHERE c.instance=? AND c.id IN (" + ids.map(() => "?").join(",") + ")";
	let origins: Origin[];
	try {
		origins = await db.$queryRawUnsafe<Origin[]>(
			"SELECT c.id, COALESCE(s.channel_id," +
				firstPublicChannel +
				") AS channelId " +
				"FROM chats c LEFT JOIN triage_sessions s ON s.instance=? AND s.chat_id=c.id" +
				scope,
			instance,
			instance,
			instance,
			...ids
		);
	} catch (error) {
		// A disabled, unmigrated installation still knows the numbers of its ordinary chats.
		const e = error as {
			code?: string;
			errno?: number;
			message?: string;
			meta?: { code?: string; message?: string };
		};
		if (
			!(
				(e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146 || e.meta?.code === "1146") &&
				/\b(?:wpp_runtime_)?triage_sessions\b/.test(e.meta?.message ?? e.message ?? "")
			)
		)
			throw error;
		origins = await db.$queryRawUnsafe<Origin[]>(
			"SELECT c.id," + firstPublicChannel + " AS channelId FROM chats c" + scope,
			instance,
			instance,
			...ids
		);
	}
	const channels = new Map(origins.map((row) => [row.id, row.channelId]));
	return (
		chats.find((chat) => channels.get(chat.id) === channelId) ??
		chats.find((chat) => channels.has(chat.id) && channels.get(chat.id) === null) ??
		null
	);
}
