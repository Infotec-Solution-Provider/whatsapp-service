/** Authenticated mirror status for a known central outbound; never synthesizes messages. Caller owns transaction. */
export async function applyOdimOwnedProviderStatus(db: any, item: any): Promise<{ id: number; changed: boolean; chatId: number | null } | null> {
	const next = ({ sent: "SENT", delivered: "RECEIVED", read: "READ", failed: "ERROR" } as Record<string, string>)[item?.status];
	if (!next || typeof item.id !== "string" || !item.id.startsWith("wamid.") || !/^\d{10,15}$/.test(item.recipient_id || "") || !/^\d{10}$/.test(String(item.timestamp))) return null;
	const [rows] = await db.execute("SELECT m.id,m.status,m.chat_id FROM messages m JOIN clients c ON c.id=m.client_id AND c.instance=m.instance WHERE m.instance='odim' AND m.waba_id=? AND m.`to`=? AND m.`from` LIKE 'me:%' AND c.type='WABA' AND c.waba_account_id IS NOT NULL FOR UPDATE", [item.id, item.recipient_id]);
	if (rows.length !== 1) return null;
	const old = rows[0], rank: Record<string, number> = { PENDING: 0, UNKNOWN: 0, ERROR: 0, SENT: 1, RECEIVED: 2, READ: 3 };
	const changed = next === "ERROR" ? (rank[old.status] ?? 0) < 2 && old.status !== "ERROR" : (rank[next] ?? 0) > (rank[old.status] ?? 0);
	if (changed) await db.execute("UPDATE messages SET status=?,status_timestamp=? WHERE id=? AND instance='odim' AND waba_id=?", [next, String(Number(item.timestamp) * 1000), old.id, item.id]);
	return { id: old.id, changed, chatId: old.chat_id };
}
