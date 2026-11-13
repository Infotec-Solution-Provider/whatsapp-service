/** Provider names enrich placeholders; they never replace an operator's chosen name. */
export function incomingContactName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, 191).join("");
	return name || null;
}

export function wabaContactName(contacts: unknown, sender: unknown): string | null {
	if (typeof sender !== "string" || !/^\d{6,20}$/.test(sender) || !Array.isArray(contacts)) return null;
	const names = new Set<string>();
	for (const entry of contacts) {
		if (entry?.wa_id !== sender) continue;
		const name = incomingContactName(entry?.profile?.name);
		if (name) names.add(name);
	}
	return names.size === 1 ? names.values().next().value! : null;
}

export function placeholderContactName(
	contact: { name: string; phone: string | null; whatsappId: string | null },
	value: unknown
): string | null {
	const candidate = incomingContactName(value);
	if (!candidate || candidate === contact.name) return null;
	const digits = (text: string) => text.replace(/\D/g, "");
	const identities = [contact.phone, contact.whatsappId].filter((id): id is string => !!id);
	const placeholder = !contact.name.trim() || identities.some(id =>
		contact.name === id || (/^[+()\d\s.-]+$/.test(contact.name) && digits(contact.name) === digits(id)));
	// A formatted phone supplied by the identity fallback is not a profile name.
	if (!placeholder || identities.some(id => digits(candidate) === digits(id) && /^[+()\d\s.-]+$/.test(candidate))) return null;
	return candidate;
}
