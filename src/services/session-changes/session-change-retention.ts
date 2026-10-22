import prismaService from "../prisma.service";

/** Delete a committed prefix only; hold the same lock as publishers until floor is updated. */
export async function pruneSessionChanges(instance: string): Promise<number> {
	return prismaService.$transaction(async (tx) => {
		await tx.$queryRawUnsafe("SELECT sequence FROM session_change_streams WHERE instance = ? FOR UPDATE", instance);
		const rows = await tx.$queryRawUnsafe<Array<{ sequence: string; expired: number }>>(
			`SELECT CAST(sequence AS CHAR) sequence, created_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY expired
			 FROM session_changes WHERE instance = ? ORDER BY session_changes.sequence LIMIT 1000`, instance);
		const firstLive = rows.findIndex((row) => !row.expired);
		const prefix = rows.slice(0, firstLive < 0 ? rows.length : firstLive);
		const last = prefix.at(-1);
		if (!last) return 0;
		await tx.$executeRawUnsafe("DELETE FROM session_changes WHERE instance = ? AND sequence <= ?", instance, last.sequence);
		await tx.$executeRawUnsafe("UPDATE session_change_streams SET floor_sequence = ? WHERE instance = ?", last.sequence, instance);
		return prefix.length;
	});
}
