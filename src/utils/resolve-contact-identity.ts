import { Formatter, PhoneUtils } from "@in.pulse-crm/utils";

export interface ResolvedContactIdentity {
	name: string;
	phone: string | null;
	whatsappId: string;
}

export default function resolveContactIdentity(
	identifier: string,
	contactName?: string | null
): ResolvedContactIdentity {
	const whatsappId = identifier.trim().replace(/^me:/, "");
	const digits = whatsappId.replace(/\D/g, "");
	const isExplicitLid = /@lid$/i.test(whatsappId);
	const phone = !isExplicitLid && PhoneUtils.isValid(digits) ? digits : null;
	const name = contactName?.trim() || (phone ? Formatter.phone(phone) : whatsappId);

	return { name, phone, whatsappId };
}
