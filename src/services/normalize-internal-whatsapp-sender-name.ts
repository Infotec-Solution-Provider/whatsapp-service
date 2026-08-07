export default function normalizeInternalWhatsappSenderName(
	senderId: string,
	candidateName: string | null
): string | null {
	const name = candidateName?.trim();

	if (!name || name === senderId) {
		return null;
	}

	if (/^[+() .-]*\d[\d+() .-]*$/.test(name)) {
		return null;
	}

	if (/@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/i.test(name)) {
		return null;
	}

	return name.slice(0, 191);
}
