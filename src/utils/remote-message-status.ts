import type { WppMessageStatus } from "@prisma/client";

/**
 * Delays before retrying a REMOTE receipt whose message is not linked to the
 * provider id yet. wwebjs-api can deliver receipts (including error acks) before
 * the outbound job result stores `wwebjs_id_stanza`, which happens on the next
 * job poll.
 */
export const REMOTE_STATUS_RETRY_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];

const DELIVERY_RANK: Partial<Record<string, number>> = { PENDING: 0, SENT: 1, RECEIVED: 2, READ: 3 };

/**
 * Receipts may arrive late or out of order (retries, relays from a fallback
 * session), so a message never moves backwards: READ does not return to
 * RECEIVED, and an error ack only applies before the message was delivered.
 */
export function shouldApplyRemoteStatus(current: WppMessageStatus, next: string): boolean {
	if (current === next || current === "REVOKED") return false;
	if (next === "ERROR") return current === "PENDING" || current === "SENT" || current === "UNKNOWN";
	if (current === "ERROR") return next === "RECEIVED" || next === "READ";

	const currentRank = DELIVERY_RANK[current];
	const nextRank = DELIVERY_RANK[next];
	if (currentRank !== undefined && nextRank !== undefined) return nextRank > currentRank;
	// Statuses outside the delivery ladder keep the previous behavior.
	return true;
}
