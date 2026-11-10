import type { SessionData } from "../sdk-local";
import { sameTenantIdentity } from "./odim-access-only";

/** Preserve the real author ID while restoring the shared Odim supervisor signature. */
export function operatorMessageName(session: Pick<SessionData, "instance" | "userId" | "name">): string {
	return sameTenantIdentity(session.instance, "odim") && [6, 9].includes(session.userId)
		? "Supervisão"
		: session.name;
}
