import type { WppMessage } from "@prisma/client";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import { operatorProviderResult, type OperatorDeliveryInput, type OperatorDeliveryOutcome } from "./operator-send-delivery";
import { sendFailureCategory } from "./send-failure-category";

/** Deliberately has no send, submit, preflight or fallback capability. */
export interface OperatorReconciliationClient {
	id: number;
	instance: string;
	getMessageJob?(jobId: string): Promise<RemoteMessageJobResponse>;
}

export interface OperatorReconciliationInput extends OperatorDeliveryInput {
	clientId: number;
	message: Pick<WppMessage, "instance" | "clientId" | "wwebjsId" | "wwebjsIdStanza">;
}

/** A missing/malformed answer keeps uncertainty; it never authorizes a new send. */
export async function reconcileOperatorMessage(
	item: OperatorReconciliationInput,
	client: OperatorReconciliationClient | undefined,
): Promise<OperatorDeliveryOutcome> {
	const pending: OperatorDeliveryOutcome = { status: "UNKNOWN" };
	if (item.deliveryMode !== "REMOTE" || !item.remoteJobId || !client?.getMessageJob ||
		client.id !== item.clientId || client.instance !== item.instance ||
		item.message.instance !== item.instance || item.message.clientId !== item.clientId) return pending;
	try {
		const job = await client.getMessageJob(item.remoteJobId);
		if (!job || job.contractVersion !== 1 || job.jobId !== item.remoteJobId ||
			job.idempotencyKey !== `operator-outbound:v1:${item.id}`) return pending;
		const result = job.result;
		// Receipt-driven remote results may contain only IDs and status. Validate
		// scope when provided, without inventing fields absent from contract v1.
		if (result && ((result.instance !== undefined && result.instance !== item.instance) ||
			(result.clientId !== undefined && result.clientId !== null && result.clientId !== item.clientId))) return pending;
		if (job.status === "SENT" && result) {
			const ids = operatorProviderResult(result);
			for (const key of ["wwebjsId", "wwebjsIdStanza"] as const) {
				if (item.message[key] && ids[key] && item.message[key] !== ids[key]) return pending;
			}
			return { status: "SENT", remoteJobId: item.remoteJobId, result: ids };
		}
		if (job.status === "FAILED") return {
			status: "FAILED", remoteJobId: item.remoteJobId,
			error: "O provedor confirmou falha no envio.", failureCategory: sendFailureCategory(job.error),
		};
		return pending;
	} catch {
		// No provider text/URL/body leaks into the persisted message or logs.
		return pending;
	}
}
