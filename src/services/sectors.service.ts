import { Prisma } from "@prisma/client";
import prismaService from "./prisma.service";

/** Validate the receiving sector against the actual number in the assignment transaction. */
export async function lockReceivingSector(tx:Pick<Prisma.TransactionClient,"$queryRawUnsafe">,instance:string,channelId:number,sectorId:number) {
	const rows=await tx.$queryRawUnsafe<{id:number}[]>(
		"SELECT s.id FROM clients c JOIN _sector_clients sc ON sc.A=c.id JOIN sectors s ON s.id=sc.B "+
		"WHERE c.instance=? AND c.id=? AND c.is_active=1 AND s.instance=? AND s.id=? AND s.receive_chats=1 FOR UPDATE",
		instance,channelId,instance,sectorId);
	return rows.length===1;
}

class SectorsService {
	public async getSectors(
		instance: string,
		filters: Prisma.WppSectorWhereInput = {}
	) {
		const sectors = await prismaService.wppSector.findMany({
			where: {
				instance,
				...filters
			},
			orderBy: {
				name: 'asc' // ou 'desc' se quiser em ordem decrescente
			  }
		});

		return sectors;
	}
}

export default new SectorsService();
