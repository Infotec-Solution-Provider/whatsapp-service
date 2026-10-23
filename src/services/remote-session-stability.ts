import { ChannelMessageHealth, MESSAGE_STALLED_MS } from "./channel-message-health";

export type SessionStability = "STABLE" | "ATTENTION" | "UNSTABLE" | "LOGGED_OUT" | "NO_DATA";

export interface StabilitySnapshot {
	state: string;
	stateChangedAt: Date;
	lastObservedAt: Date;
	consecutivePollFailures: number;
}

export interface FunctionalHealthSnapshot {
	dispatchStatus: "PASSED" | "FAILED" | "SKIPPED";
	officialReceiveStatus?: "PASSED" | "FAILED" | "SKIPPED";
	responseDispatchStatus?: "PASSED" | "FAILED" | "SKIPPED";
	receiveStatus: "PASSED" | "FAILED" | "SKIPPED";
	expiresAt: string;
	latencyMs: number | null;
	reason: string;
}

/** Transport observation only; functional delivery and historical flaps are separate. */
export function calculateTransportStability(snapshot: StabilitySnapshot | null, now = Date.now()): {
	level: SessionStability; reason: string;
} {
	if (!snapshot) return { level: "NO_DATA", reason: "Nenhuma observação da sessão foi recebida." };
	if (snapshot.state === "LOGGED_OUT") return { level: "LOGGED_OUT", reason: "A sessão precisa de um novo QR code." };
	const observationAge = now - snapshot.lastObservedAt.getTime();
	if (!Number.isFinite(observationAge) || observationAge > 90_000 || snapshot.consecutivePollFailures >= 3)
		return { level: "UNSTABLE", reason: "A sessão remota não está respondendo." };
	if (["DISCONNECTED", "ERROR"].includes(snapshot.state) && now - snapshot.stateChangedAt.getTime() > 300_000)
		return { level: "UNSTABLE", reason: "A sessão está desconectada ou com erro há mais de 5 minutos." };
	if (snapshot.state !== "CONNECTED") return { level: "ATTENTION", reason: "A sessão ainda não está conectada." };
	if (observationAge > 45_000) return { level: "ATTENTION", reason: "A observação da sessão está atrasada." };
	return { level: "STABLE", reason: "Transporte conectado com observação recente; entrega não é comprovada pelo socket." };
}

export function transportHistory(disconnections24h: number, disconnections1h: number) {
	return { disconnections24h, disconnections1h, frequentDisconnects: disconnections1h > 10,
		reason: disconnections1h > 10 ? "Mais de 10 transições de desconexão/erro na última hora." :
			"Histórico de transições observado; não representa a saúde funcional atual nem mensagens perdidas." };
}

export function calculateSessionStability(
	snapshot: StabilitySnapshot | null,
	_disconnectCount: number,
	now: number = Date.now(),
	functionalHealth: FunctionalHealthSnapshot | null = null,
	messageHealth: ChannelMessageHealth | null = null
): { level: SessionStability; reason: string } {
	const transport = calculateTransportStability(snapshot, now);
	if (!snapshot || ["NO_DATA", "LOGGED_OUT", "UNSTABLE"].includes(transport.level)) return transport;
	const observationAge = now - snapshot.lastObservedAt.getTime();
	const messageAttention: string[] = [];
	if (messageHealth) {
		const window = `nos últimos ${messageHealth.windowMinutes} minutos`;
		if (messageHealth.sendTechnicalFailed >= 3)
			return {
				level: "UNSTABLE",
				reason: `${messageHealth.sendTechnicalFailed} mensagens com falha técnica de envio ${window}.`
			};
		if (messageHealth.receiveFailed >= 3)
			return {
				level: "UNSTABLE",
				reason: `${messageHealth.receiveFailed} mensagens com falha de processamento no recebimento ${window}.`
			};
		if (
			messageHealth.oldestSendPendingAt &&
			now - Date.parse(messageHealth.oldestSendPendingAt) > MESSAGE_STALLED_MS
		) {
			return {
				level: "UNSTABLE",
				reason: `${messageHealth.sendDelayed} envio(s) atrasado(s); o mais antigo aguarda há mais de 5 minutos.`
			};
		}
		if (
			messageHealth.oldestReceivePendingAt &&
			now - Date.parse(messageHealth.oldestReceivePendingAt) > MESSAGE_STALLED_MS
		) {
			return {
				level: "UNSTABLE",
				reason: `${messageHealth.receiveDelayed} mensagem(ns) recebida(s) aguardando processamento; a mais antiga há mais de 5 minutos.`
			};
		}
		if (messageHealth.sendTechnicalFailed)
			messageAttention.push(`${messageHealth.sendTechnicalFailed} falha(s) técnica(s) de envio`);
		if (messageHealth.sendUnclassifiedFailed)
			messageAttention.push(
				`${messageHealth.sendUnclassifiedFailed} falha(s) de envio com causa não identificada`
			);
		if (messageHealth.sendUnknown) messageAttention.push(`${messageHealth.sendUnknown} envio(s) sem confirmação`);
		if (messageHealth.receiveFailed)
			messageAttention.push(
				`${messageHealth.receiveFailed} mensagem(ns) com falha no processamento de recebimento`
			);
		if (messageHealth.sendDelayed) messageAttention.push(`${messageHealth.sendDelayed} envio(s) atrasado(s)`);
		if (messageHealth.receiveDelayed)
			messageAttention.push(`${messageHealth.receiveDelayed} mensagem(ns) recebida(s) aguardando processamento`);
		if (messageHealth.receipts.pendingEvents || messageHealth.receipts.failedEvents)
			messageAttention.push(`${messageHealth.receipts.pendingEvents} evento(s) de recibo atrasado(s), ${messageHealth.receipts.failedEvents} com falha; não são mensagens perdidas`);
		if (messageHealth.receipts.dataStatus !== "COMPLETE")
			messageAttention.push("A consulta de recibos está parcial ou indisponível.");
		if (messageAttention.length)
			messageAttention.push(
				`Janela de falhas: ${messageHealth.windowMinutes} minutos; atrasos incluem mensagens ainda pendentes.`
			);
		if (messageHealth.dataStatus === "UNAVAILABLE")
			messageAttention.push("Não foi possível consultar a saúde das mensagens.");
		else if (messageHealth.dataStatus === "LIMITED")
			messageAttention.push("A consulta de saúde das mensagens atingiu o limite; contagens parciais.");
	} else messageAttention.push("A saúde das mensagens ainda não foi consultada.");
	const validProbe =
		functionalHealth &&
		Number.isFinite(Date.parse(functionalHealth.expiresAt)) &&
		Date.parse(functionalHealth.expiresAt) > now;
	if (validProbe) {
		// A responder outage cannot prove that every monitored session is broken.
		if (functionalHealth.responseDispatchStatus === "FAILED")
			messageAttention.push(
				"O WABA de teste recebeu a sondagem, mas falhou ao responder; recebimento do canal não confirmado."
			);
		else if (
			functionalHealth.dispatchStatus === "FAILED" ||
			functionalHealth.officialReceiveStatus === "FAILED" ||
			functionalHealth.receiveStatus === "FAILED"
		) {
			return {
				level: "UNSTABLE",
				reason:
					functionalHealth.dispatchStatus === "FAILED"
						? "O healthcheck falhou no envio ao WABA de teste."
						: functionalHealth.officialReceiveStatus === "FAILED"
							? "O envio do healthcheck não chegou ao webhook WABA de teste dentro do prazo."
							: "A sessão não recebeu a resposta do healthcheck dentro do prazo."
			};
		} else if (
			[
				functionalHealth.dispatchStatus,
				functionalHealth.officialReceiveStatus,
				functionalHealth.responseDispatchStatus,
				functionalHealth.receiveStatus
			].includes("SKIPPED")
		) {
			messageAttention.push("O healthcheck não concluiu todas as etapas.");
		}
	} else
		messageAttention.push(
			functionalHealth ? "O último healthcheck está vencido." : "Ainda não há resultado de healthcheck."
		);
	if (snapshot.state !== "CONNECTED") messageAttention.push("A sessão ainda não está conectada.");
	if (observationAge > 45_000) messageAttention.push("A observação da sessão está atrasada.");
	if (messageAttention.length) return { level: "ATTENTION", reason: messageAttention.join(" · ") };
	const latency = functionalHealth?.latencyMs == null ? "" : ` (${functionalHealth.latencyMs} ms)`;
	return {
		level: "STABLE",
		reason: `Sessão conectada, healthcheck aprovado${latency} e sem sinais recentes de falha técnica ou atraso de mensagens.`
	};
}
