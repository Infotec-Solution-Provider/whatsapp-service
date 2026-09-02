export type PublicMessageDirection = "INBOUND" | "OUTBOUND" | "INTERNAL";

export type PublicMessageSenderType =
	| "CONTACT"
	| "ATTENDANT"
	| "WHATSAPP_ACCOUNT"
	| "BOT"
	| "SYSTEM"
	| "THIRD_PARTY";

interface DirectionSource {
	from: string;
	userId?: number | null;
}

export function getPublicMessageDirection(message: DirectionSource): {
	direction: PublicMessageDirection;
	senderType: PublicMessageSenderType;
} {
	if (message.from.startsWith("bot:")) {
		return { direction: "OUTBOUND", senderType: "BOT" };
	}

	if (message.from.startsWith("system")) {
		return { direction: "INTERNAL", senderType: "SYSTEM" };
	}

	if (message.from.startsWith("thirdparty:")) {
		return { direction: "INTERNAL", senderType: "THIRD_PARTY" };
	}

	if (message.from.startsWith("user:")) {
		return { direction: "OUTBOUND", senderType: "ATTENDANT" };
	}

	if (message.from.startsWith("me:")) {
		return {
			direction: "OUTBOUND",
			senderType: message.userId === null || message.userId === undefined ? "WHATSAPP_ACCOUNT" : "ATTENDANT"
		};
	}

	return { direction: "INBOUND", senderType: "CONTACT" };
}

export function withPublicMessageDirection<T extends DirectionSource>(message: T): T & {
	direction: PublicMessageDirection;
	senderType: PublicMessageSenderType;
} {
	return { ...message, ...getPublicMessageDirection(message) };
}
