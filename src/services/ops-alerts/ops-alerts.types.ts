export type OpsAlertType = "SEND_FAILED" | "SEND_SLOW" | "SESSION_DOWN" | "DISCONNECT_STORM" | "QUEUE_BACKLOG";

/** `resolved` closes an open critical alert of the same key (sent once). */
export type OpsAlertSeverity = "critical" | "high" | "warn" | "resolved";

/** Identifiers only: never message bodies, phone numbers or provider error text. */
export interface OpsAlertRefs {
	internalMessageId?: number | undefined;
	messageId?: number | undefined;
	queueId?: string | undefined;
	jobId?: string | undefined;
	library?: "BAILEYS" | "ZAPO" | null | undefined;
	/** true when a non-primary (reserve) session executed the send. */
	fallback?: boolean | null | undefined;
	durationMs?: number | undefined;
	firstAttemptAt?: string | null | undefined;
	outcome?: string | undefined;
	state?: string | undefined;
	count?: number | undefined;
	queue?: "internal" | "operator" | undefined;
	since?: string | undefined;
}

export interface OpsAlertInput {
	type: OpsAlertType;
	severity: OpsAlertSeverity;
	instance: string;
	clientId?: number | undefined;
	sessionId?: string | undefined;
	refs?: OpsAlertRefs | undefined;
	/** Short PT-BR line, no personal data. May be empty. */
	summary: string;
	occurredAt?: string | undefined;
}

export interface OpsAlertsConfig {
	enabled: boolean;
	dedupWindowMs: number;
	maxPerHour: number;
	reminderMs: number;
	maxReminders: number;
	stateFile: string;
	excludedClientIds: Set<number>;
	notifyTargets: Array<{ instance: string; userId: number }>;
	whatsappMode: "auto" | "on" | "off";
	senderUrl: string;
	whatsappTo: string;
	senderTimeoutMs: number;
	senderHealthTtlMs: number;
	senderFailureThreshold: number;
	senderBackoffMs: number;
	senderUnavailableLogMs: number;
	slowSendMs: number;
	sessionDownMs: number;
	sessionAuthDownMs: number;
	disconnectStormThreshold: number;
	stormCheckMs: number;
	backlogMs: number;
	checkIntervalMs: number;
	tickMs: number;
	scopeWindowMs: number;
	bufferSize: number;
}
