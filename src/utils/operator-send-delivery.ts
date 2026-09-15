import type { WppMessage } from "@prisma/client";
import type { SendMessageOptions } from "../types/whatsapp-instance.types";
import type { RemoteMessageJobResponse } from "../types/remote-client.types";
import type CreateMessageDto from "../dtos/create-message.dto";
import { WabaDeliveryError } from "./waba-send";

export interface OperatorDeliveryClient {
	instance: string;
	sendMessage(options: SendMessageOptions, isGroup?: boolean): Promise<CreateMessageDto>;
	submitMessageJob?(options: SendMessageOptions, isGroup: boolean, key: string): Promise<RemoteMessageJobResponse>;
	getMessageJob?(jobId: string): Promise<RemoteMessageJobResponse>;
}

export interface OperatorDeliveryInput {
	id: string;
	instance: string;
	deliveryMode: "REMOTE" | "DIRECT";
	remoteJobId: string | null;
}

export interface OperatorDeliveryOutcome {
	status: "PENDING" | "SENT" | "FAILED" | "UNKNOWN";
	remoteJobId?: string;
	result?: Partial<WppMessage>;
	error?: string;
}

/** Only provider identifiers may replace fields from the persisted operator message. */
export function operatorProviderResult(result: CreateMessageDto): Partial<WppMessage> {
	const ids: Partial<WppMessage> = {};
	for (const key of ["wwebjsId", "wwebjsIdStanza", "wabaId", "gupshupId"] as const) {
		if (typeof result[key] === "string" && result[key]!.length) ids[key] = result[key];
	}
	if (!Object.keys(ids).length) throw new Error("Provedor não retornou um identificador de mensagem.");
	return ids;
}

export async function deliverOperatorMessage(
	item: OperatorDeliveryInput,
	options: SendMessageOptions,
	client: OperatorDeliveryClient | undefined,
): Promise<OperatorDeliveryOutcome> {
	if (!client || client.instance !== item.instance) {
		return { status: item.deliveryMode === "DIRECT" ? "FAILED" : "PENDING", error: "Canal indisponível antes do envio." };
	}
	if (item.deliveryMode === "DIRECT") {
		try {
			const result = await client.sendMessage({ ...options, preventAutomaticRetry: true }, false);
			return { status: "SENT", result: operatorProviderResult(result) };
		} catch (error) {
			if (error instanceof WabaDeliveryError) {
				return { status: error.deliveryStatus, error: error.message };
			}
			return { status: "UNKNOWN", error: "Não foi possível confirmar o resultado do envio. Não reenviar automaticamente." };
		}
	}
	if (!client.submitMessageJob || !client.getMessageJob) {
		return { status: "UNKNOWN", error: "Contrato de envio durável indisponível neste canal." };
	}
	try {
		const job = item.remoteJobId
			? await client.getMessageJob(item.remoteJobId)
			: await client.submitMessageJob(options, false, `operator-outbound:v1:${item.id}`);
		if (job.contractVersion !== 1 || typeof job.jobId !== "string" || !job.jobId ||
			job.idempotencyKey !== `operator-outbound:v1:${item.id}` ||
			(item.remoteJobId && item.remoteJobId !== job.jobId)) {
			return { status: "UNKNOWN", error: "Resposta de reconciliação inválida." };
		}
		const remoteJobId = job.jobId;
		if (job.status === "SENT") {
			if (!job.result) return { status: "UNKNOWN", remoteJobId, error: "Envio aceito sem identificador retornado." };
			try {
				return { status: "SENT", remoteJobId, result: operatorProviderResult(job.result) };
			} catch {
				return { status: "UNKNOWN", remoteJobId, error: "Envio aceito sem identificador válido retornado." };
			}
		}
		if (job.status === "FAILED") return { status: "FAILED", remoteJobId, error: "O provedor confirmou falha no envio." };
		if (job.status === "UNKNOWN") return { status: "UNKNOWN", remoteJobId, error: "Resultado do envio incerto; não reenviar automaticamente." };
		if (job.status === "PENDING" || job.status === "PROCESSING") return { status: "PENDING", remoteJobId };
		return { status: "UNKNOWN", remoteJobId, error: "Estado remoto não reconhecido." };
	} catch (error) {
		const status = (error as { response?: { status?: number } })?.response?.status;
		// Missing known jobs and conflicts cannot be repaired by creating a new send.
		if ((item.remoteJobId && status === 404) || status === 409 || status === 400 || status === 422) {
			return { status: "UNKNOWN", error: "Tentativa não pôde ser reconciliada com segurança." };
		}
		return { status: "PENDING", error: "Aguardando confirmação do serviço de mensagens." };
	}
}
