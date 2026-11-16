type Peer = { id: string; kind: "bare" | "phone" | "lid" | "group" };
function peer(value: unknown): Peer | null {
	if (typeof value !== "string") return null;
	const raw = value.trim().replace(/^me:/, "");
	const match = /^([^@]+)(?:@(c\.us|s\.whatsapp\.net|lid|g\.us))?$/i.exec(raw);
	if (!match) return null;
	const domain = match[2]?.toLowerCase();
	const id = match[1]!.split(":")[0]!;
	if (!id) return null;
	return { id, kind: domain === "lid" ? "lid" : domain === "g.us" ? "group" : domain ? "phone" : "bare" };
}
const phone = (value: string): string | null => {
	if (!/^\+?[\d ()-]+$/.test(value)) return null;
	const digits = value.replace(/\D/g, "");
	return digits ? (digits.startsWith("55") ? digits : `55${digits}`) : null;
};
/** Contact WhatsApp IDs may be stored bare; explicit LID/group domains never match a phone field. */
export function pauseSendTargetMatches(to: unknown, storedPhone: unknown, storedWhatsappId: unknown): boolean {
	const target = peer(to), whatsapp = peer(storedWhatsappId);
	if (!target) return false;
	if (whatsapp && target.id === whatsapp.id &&
		(target.kind === whatsapp.kind || target.kind === "bare" || whatsapp.kind === "bare")) return true;
	if (target.kind !== "phone" && target.kind !== "bare") return false;
	const targetPhone = phone(target.id);
	const stored = typeof storedPhone === "string" ? phone(storedPhone) : null;
	if (!targetPhone || !stored) return false;
	if (targetPhone === stored) return true;
	// Same Brazilian ninth-digit alternatives already used by contact lookup.
	const alternate = targetPhone.length === 13 ? targetPhone.slice(0, 4) + targetPhone.slice(5)
		: targetPhone.length === 12 ? targetPhone.slice(0, 4) + "9" + targetPhone.slice(4) : null;
	return alternate === stored;
}
