import { SessionData } from "@in.pulse-crm/sdk";
import prismaService from "./prisma.service";

class ParametersService {
	public async getUserParams(instance: string, userId: number) {
		const userParams = await prismaService.parameter.findMany({
			where: {
				scope: "USER",
				instance,
				userId
			}
		});

		return userParams;
	}

	public async getSectorParams(sectorId: number) {
		const sectorParams = await prismaService.parameter.findMany({
			where: {
				scope: "SECTOR",
				sectorId
			}
		});

		return sectorParams;
	}

	public async getInstanceParams(instance: string) {
		const instanceParams = await prismaService.parameter.findMany({
			where: { instance }
		});

		return instanceParams;
	}

	public async getSessionParams({ instance, sectorId, userId }: SessionData) {
		const [instanceParams, sectorParams, userParams] = await Promise.all([
			this.getInstanceParams(instance),
			this.getSectorParams(sectorId),
			this.getUserParams(instance, userId)
		]);

		// helper para transformar array em objeto
		const toParamMap = (params: { key: string; value: string }[]) =>
			Object.fromEntries(params.map((p) => [p.key, p.value]));

		// prioridade: instancia < setor < usuario
		const mergedParams = {
			...toParamMap(instanceParams),
			...toParamMap(sectorParams),
			...toParamMap(userParams)
		};

		return mergedParams;
	}
}

export default new ParametersService();
