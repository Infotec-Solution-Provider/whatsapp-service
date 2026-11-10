import prismaService from "./prisma.service";
import parametersService from "./parameters.service";
import { isOdimAccessOnly } from "../utils/odim-access-only";

const RUN = "f3c51f9d-9c0a-4654-a630-36f13ce7df40";
const ORIGIN = "172.22.139.22/crm_sgr/";

// CRM sector IDs in the authenticated session are not central WhatsApp sector IDs.
// Expose only configured channel metadata; inactive channels stay fenced by access-only.
export async function getOdimCopiedSectorClients(instance: string, sectorId: number) {
	if (!isOdimAccessOnly(instance) || !Number.isSafeInteger(sectorId) || sectorId <= 0) return [];
	if (!(await parametersService.getInstanceBooleanParam(instance, "feature_odim_usable_copy_enabled", false))) return [];
	let sector = await prismaService.wppSector.findFirst({ where: { instance, id: sectorId }, select: { id: true } });
	if (!sector) {
		const rows = await prismaService.$queryRawUnsafe<{ target_id: number }[]>(
			"SELECT m.target_id FROM instance_migration_maps m JOIN sectors s ON s.id=m.target_id AND s.instance=m.instance WHERE m.run_id=? AND m.instance=? AND m.entity=? AND m.source_id=? LIMIT 1",
			RUN, instance, "odim-live-copy-v1/sectors", ORIGIN + sectorId
		);
		if (rows[0]) sector = { id: Number(rows[0].target_id) };
	}
	if (!sector) return [];
	return prismaService.wppClient.findMany({
		where: {
			instance, type: "WABA", sectors: { some: { id: sector.id, instance } },
			WABAPhoneId: { not: null }, WABAAccountId: { not: null }, WABAToken: { not: null }
		},
		select: { id: true, name: true, type: true }, orderBy: { id: "asc" }
	});
}
