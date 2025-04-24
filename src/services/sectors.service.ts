import prismaService from "./prisma.service";

class SectorsService {
	public async getSectors(instance: string) {
		const sectors = await prismaService.wppSector.findMany({
			where: {
				instance
			}
		});

		return sectors;
	}
}

export default new SectorsService();
