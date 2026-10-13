import type { SendFailureCategory } from "../utils/send-failure-category";

export const MESSAGE_HEALTH_WINDOW_MS = 15 * 60_000;
export const MESSAGE_DELAY_MS = 60_000;
export const MESSAGE_STALLED_MS = 5 * 60_000;

export interface ChannelMessageHealth {
	windowMinutes: number;
	observedAt: string;
	dataStatus: "COMPLETE" | "LIMITED" | "UNAVAILABLE";
	sendFailed: number;
	sendTechnicalFailed: number;
	sendMessageFailed: number;
	sendUnclassifiedFailed: number;
	sendUnknown: number;
	sendDelayed: number;
	receiveFailed: number;
	receiveDelayed: number;
	oldestSendPendingAt: string | null;
	oldestReceivePendingAt: string | null;
}

export interface MessageHealthIssue {
	clientId: number;
	key: string;
	direction: "SEND" | "RECEIVE";
	status: "FAILED" | "UNKNOWN" | "PENDING";
	startedAt: Date;
	occurredAt: Date;
	category?: SendFailureCategory;
}

export function emptyMessageHealth(
	now: number,
	dataStatus: ChannelMessageHealth["dataStatus"] = "COMPLETE"
): ChannelMessageHealth {
	return {
		windowMinutes: MESSAGE_HEALTH_WINDOW_MS / 60_000,
		observedAt: new Date(now).toISOString(),
		dataStatus,
		sendFailed: 0,
		sendTechnicalFailed: 0,
		sendMessageFailed: 0,
		sendUnclassifiedFailed: 0,
		sendUnknown: 0,
		sendDelayed: 0,
		receiveFailed: 0,
		receiveDelayed: 0,
		oldestSendPendingAt: null,
		oldestReceivePendingAt: null
	};
}

/** Deduplicate messages across retries and processing stages, independently for each signal. */
export function collectMessageHealth(
	clientIds: number[],
	issues: MessageHealthIssue[],
	now: number,
	dataStatus: ChannelMessageHealth["dataStatus"] = "COMPLETE"
): Map<number, ChannelMessageHealth> {
	const result = new Map(clientIds.map((id) => [id, emptyMessageHealth(now, dataStatus)]));
	const seen = new Set<string>();
	for (const issue of issues) {
		const health = result.get(issue.clientId);
		if (!health) continue;
		const key = `${issue.clientId}:${issue.direction}:${issue.status}:${issue.key}`;
		if (issue.status === "PENDING") {
			if (now - issue.startedAt.getTime() <= MESSAGE_DELAY_MS) continue;
			const oldestKey = issue.direction === "SEND" ? "oldestSendPendingAt" : "oldestReceivePendingAt";
			const previous = health[oldestKey];
			if (!previous || issue.startedAt.getTime() < Date.parse(previous))
				health[oldestKey] = issue.startedAt.toISOString();
			if (seen.has(key)) continue;
			if (issue.direction === "SEND") health.sendDelayed++;
			else health.receiveDelayed++;
		} else {
			if (seen.has(key)) continue;
			if (issue.occurredAt.getTime() < now - MESSAGE_HEALTH_WINDOW_MS || issue.occurredAt.getTime() > now)
				continue;
			if (issue.direction === "RECEIVE") health.receiveFailed++;
			else if (issue.status === "UNKNOWN") health.sendUnknown++;
			else {
				health.sendFailed++;
				if (issue.category === "CHANNEL") health.sendTechnicalFailed++;
				else if (issue.category === "MESSAGE") health.sendMessageFailed++;
				else health.sendUnclassifiedFailed++;
			}
		}
		seen.add(key);
	}
	return result;
}
