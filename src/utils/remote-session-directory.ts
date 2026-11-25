interface DirectorySession {
	sessionId: string;
	clientId?: number;
	monitorRole?: "PRIMARY" | "SHADOW" | string | null;
	isDefault?: boolean;
}

/**
 * Picks the session that represents a client. wwebjs-api lists sessions by
 * session_id, so a SHADOW can come first; prefer PRIMARY, then the default
 * session, then the first match.
 */
export function pickClientSession<T extends DirectorySession>(sessions: readonly T[] | null | undefined, clientId?: number): T | undefined {
	let best: T | undefined;
	let bestScore = -1;
	for (const session of sessions || []) {
		if (clientId !== undefined && session.clientId !== clientId) continue;
		const score = (session.monitorRole === "PRIMARY" ? 2 : 0) + (session.isDefault === true ? 1 : 0);
		if (score > bestScore) {
			best = session;
			bestScore = score;
		}
	}
	return best;
}

/** Managed channels have one principal. An incomplete directory must never route a request to a host default. */
export function pickRoutedSession<T extends DirectorySession & { instance: string; enabled?: boolean }>(
	sessions: readonly T[] | null | undefined, clientId: number, instance: string, managed: boolean
): T | undefined {
	if (!managed) return pickClientSession(sessions, clientId);
	const matches = sessions?.filter(item => item.instance === instance && item.clientId === clientId && item.enabled && item.monitorRole === "PRIMARY");
	return matches?.length === 1 ? matches[0] : undefined;
}
