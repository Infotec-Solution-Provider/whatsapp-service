export type SessionStability = "STABLE" | "ATTENTION" | "UNSTABLE" | "LOGGED_OUT" | "NO_DATA";

export interface StabilitySnapshot {
	state: string;
	stateChangedAt: Date;
	lastObservedAt: Date;
	consecutivePollFailures: number;
}

export function calculateSessionStability(
	snapshot: StabilitySnapshot | null,
	disconnectCount: number,
	now: number = Date.now()
): { level: SessionStability; reason: string } {
	if (!snapshot) {
		return { level: "NO_DATA", reason: "No session observation has been received" };
	}
	if (snapshot.state === "LOGGED_OUT") {
		return { level: "LOGGED_OUT", reason: "The session requires a new QR code" };
	}

	const observationAge = now - snapshot.lastObservedAt.getTime();
	const stateAge = now - snapshot.stateChangedAt.getTime();
	if (observationAge > 90_000 || snapshot.consecutivePollFailures >= 3) {
		return { level: "UNSTABLE", reason: "The remote session is not responding" };
	}
	if (disconnectCount >= 4) {
		return { level: "UNSTABLE", reason: `${disconnectCount} unexpected disconnections in 24 hours` };
	}
	if ((snapshot.state === "DISCONNECTED" || snapshot.state === "ERROR") && stateAge > 5 * 60_000) {
		return { level: "UNSTABLE", reason: `Session has remained ${snapshot.state.toLowerCase()} for more than 5 minutes` };
	}
	if (["QR_PENDING", "CONNECTING", "RECONNECTING", "DISCONNECTED", "ERROR"].includes(snapshot.state)) {
		return { level: "ATTENTION", reason: `Session is ${snapshot.state.toLowerCase()}` };
	}
	if (disconnectCount >= 2) {
		return { level: "ATTENTION", reason: `${disconnectCount} unexpected disconnections in 24 hours` };
	}
	if (observationAge > 45_000) {
		return { level: "ATTENTION", reason: "Session observation is delayed" };
	}

	return { level: "STABLE", reason: "Session is connected and responding" };
}