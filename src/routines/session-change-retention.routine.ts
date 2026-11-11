import { Logger } from "@in.pulse-crm/utils";
import prismaService from "../services/prisma.service";
import { pruneSessionChanges } from "../services/session-changes/session-change-retention";

let running = false;
let afterInstance = "";
export default async function retainSessionChanges() {
	if (running) return;
	running = true;
	try {
		const instances = await prismaService.$queryRawUnsafe<Array<{ instance: string }>>(
			"SELECT instance FROM session_change_streams WHERE instance > ? ORDER BY instance LIMIT 20", afterInstance);
		for (const row of instances) await pruneSessionChanges(row.instance);
		afterInstance = instances.length === 20 ? instances.at(-1)!.instance : "";
	} catch (error) {
		Logger.error("[message-sync] journal retention failed", error as Error);
	} finally { running = false; }
}
