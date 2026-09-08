import type { WppMessage } from "@prisma/client";
import { OperatorSendRequestError } from "./operator-send-request";

interface QuoteScope {
	instance: string;
	contactId: number;
	clientId: number;
	clientType: string;
}

type QuoteMessage = Pick<
	WppMessage,
	"instance" | "contactId" | "clientId" | "wwebjsId" | "wwebjsIdStanza" | "wabaId" | "gupshupId"
>;

export function resolveOperatorQuotedMessage(scope: QuoteScope, quoted: QuoteMessage | null): string {
	if (
		!quoted ||
		quoted.instance !== scope.instance ||
		quoted.contactId !== scope.contactId ||
		quoted.clientId !== scope.clientId
	) {
		throw new OperatorSendRequestError("Mensagem citada inválida nesta conversa ou canal.");
	}
	const providerId =
		scope.clientType === "WWEBJS"
			? quoted.wwebjsId
			: quoted.wwebjsIdStanza || quoted.wwebjsId || quoted.wabaId || quoted.gupshupId;
	if (!providerId) {
		throw new OperatorSendRequestError("Mensagem citada ainda não possui confirmação do provedor.");
	}
	return providerId;
}
