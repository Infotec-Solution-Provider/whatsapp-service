export const FUNCTIONAL_HEALTH_REQUEST_PREFIX = "HEALTHPROBE_REQUEST:";
export const FUNCTIONAL_HEALTH_RESPONSE_PREFIX = "HEALTHPROBE:";

export interface RegisterOfficialProbeInput {
	correlationId: string;
	officialClientId: number;
	officialInstance: string;
	requesterPhone: string;
	expiresAt: Date;
	respond(to: string, correlationId: string): Promise<void>;
}

export interface OfficialProbeSnapshot {
	receivedAt: string | null;
	responseDispatchedAt: string | null;
	responseError: string | null;
}

export interface OfficialProbeInboundInput {
	clientId: number;
	instance: string;
	from: string;
	body: string;
}

export interface OfficialProbeInboundResult {
	handled: boolean;
	reason?: string;
}

interface PendingOfficialProbe extends RegisterOfficialProbeInput {
	receivedAt: string | null;
	responseDispatchedAt: string | null;
	responseError: string | null;
	responseInFlight: Promise<void> | undefined;
}

export class FunctionalHealthProbeRegistryService {
	private readonly pending = new Map<string, PendingOfficialProbe>();

	public register(input: RegisterOfficialProbeInput): void {
		this.pruneExpired();
		this.pending.set(input.correlationId, {
			...input,
			receivedAt: null,
			responseDispatchedAt: null,
			responseError: null,
			responseInFlight: undefined
		});
	}

	public unregister(correlationId: string): void {
		this.pending.delete(correlationId);
	}

	public getSnapshot(correlationId: string): OfficialProbeSnapshot | null {
		const probe = this.pending.get(correlationId);
		if (!probe) return null;

		return {
			receivedAt: probe.receivedAt,
			responseDispatchedAt: probe.responseDispatchedAt,
			responseError: probe.responseError
		};
	}

	public async handleOfficialInbound(input: OfficialProbeInboundInput): Promise<OfficialProbeInboundResult> {
		if (!input.body.startsWith(FUNCTIONAL_HEALTH_REQUEST_PREFIX)) return { handled: false };

		const correlationId = input.body.slice(FUNCTIONAL_HEALTH_REQUEST_PREFIX.length).trim();
		const probe = correlationId ? this.pending.get(correlationId) : null;
		if (!probe) {
			return { handled: true, reason: "Functional health probe is unknown or no longer pending" };
		}
		if (probe.expiresAt.getTime() <= Date.now()) {
			this.pending.delete(correlationId);
			return { handled: true, reason: "Functional health probe expired before the official webhook arrived" };
		}
		if (probe.officialClientId !== input.clientId || probe.officialInstance !== input.instance) {
			return { handled: true, reason: "Functional health probe reached an unexpected official client" };
		}
		if (this.normalizePhone(probe.requesterPhone) !== this.normalizePhone(input.from)) {
			return { handled: true, reason: "Functional health probe was sent by an unexpected WhatsApp account" };
		}

		probe.receivedAt ||= new Date().toISOString();
		if (probe.responseDispatchedAt) {
			return { handled: true, reason: "Functional health probe was already answered" };
		}

		if (!probe.responseInFlight) {
			probe.responseInFlight = probe
				.respond(input.from, correlationId)
				.then(() => {
					probe.responseDispatchedAt = new Date().toISOString();
					probe.responseError = null;
				})
				.catch((error: unknown) => {
					probe.responseError = this.errorMessage(error);
					throw error;
				})
				.finally(() => {
					probe.responseInFlight = undefined;
				});
		}

		await probe.responseInFlight;
		return { handled: true, reason: "Functional health probe answered by the official client" };
	}

	private pruneExpired(): void {
		const now = Date.now();
		for (const [correlationId, probe] of this.pending) {
			if (probe.expiresAt.getTime() <= now) this.pending.delete(correlationId);
		}
	}

	private normalizePhone(value: string): string {
		return value.replace(/^me:/, "").split("@")[0]?.replace(/\D/g, "") || "";
	}

	private errorMessage(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, " ").slice(0, 500);
	}
}

export default new FunctionalHealthProbeRegistryService();
