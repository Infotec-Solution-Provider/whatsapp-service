import type { WppChat } from "@prisma/client";
import { sameTenantIdentity } from "../utils/odim-access-only";
import instancesService from "./instances.service";
import { Logger } from "@in.pulse-crm/utils";

/** Personal-room fan-out only targets the currently active supervisor in this sector. */
export async function odimSupervisionObservers(chat: Pick<WppChat, "instance" | "userId" | "sectorId">): Promise<number[]> {
	if (!sameTenantIdentity(chat.instance, "odim") || !Number.isSafeInteger(chat.sectorId) || (chat.sectorId ?? 0) <= 0) return [];
	const peer = chat.userId === 6 ? 9 : chat.userId === 9 ? 6 : null;
	if (peer === null) return [];
	try {
		const rows = await instancesService.executeQuery<Array<{ CODIGO: number; NIVEL: string | null; ATIVO: string | null; SETOR: number | null }>>(
			chat.instance, "SELECT CODIGO, NIVEL, ATIVO, SETOR FROM operadores WHERE CODIGO = ? LIMIT 1", [peer]
		);
		return rows.length === 1 && rows[0]!.CODIGO === peer && rows[0]!.NIVEL === "ADMIN" &&
			rows[0]!.ATIVO === "SIM" && rows[0]!.SETOR === chat.sectorId ? [peer] : [];
	} catch {
		// A missing live hint is repaired by session changes; do not fail a completed transfer.
		Logger.error("[OdimSupervision] Unable to validate the observer; shared socket hint skipped.");
		return [];
	}
}
