import { Prisma } from "@prisma/client";
import prismaService from "./prisma.service";

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
