import type { WppClient } from "@prisma/client";
import db from "../services/prisma.service";
import { hasTriageIngress } from "./runtime";

/** Published numbers and paused numbers with open sessions use the provider's actual inbound asset. */
export async function resolveTriageWabaChannel(legacy: WppClient, phoneNumberId?: string, accountId?: string) {
	const candidates = phoneNumberId
		? await db.wppClient.findMany({
				where: {
					instance: legacy.instance,
					type: "WABA",
					isActive: true,
					WABAPhoneId: phoneNumberId,
					...(accountId ? { OR: [{ WABAAccountId: accountId }, { WABAAccountId: null }] } : {})
				},
				take: 2
			})
		: [];
	const only = candidates.length === 1 ? candidates[0] : null;
	if (only?.id === legacy.id) return legacy;
	const defaultActive = await hasTriageIngress(legacy.instance, legacy.id);
	const scoped =
		defaultActive ||
		(
			await Promise.all(
				candidates.filter((c) => c.id !== legacy.id).map((c) => hasTriageIngress(legacy.instance, c.id))
			)
		).some(Boolean);
	if (!scoped) return legacy;
	if (!only) throw new Error("TRIAGE_WABA_CHANNEL_MISMATCH");
	return only;
}
