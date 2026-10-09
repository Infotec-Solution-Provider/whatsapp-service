import { Prisma } from "@prisma/client";
import { ConflictError } from "@rgranatodutra/http-errors";
import prismaService from "./prisma.service";
import { whatsappParameterSettings } from "../parameters/parameter-settings.catalog";
import { parseParameterChanges } from "../parameters/parameter-settings.contract";

const target = (instance: string) => ({ scope: "INSTANCE" as const, instance, sectorId: null, userId: null });

class ParameterSettingsService {
	public async get(instance: string) {
		const parameters = await prismaService.parameter.findMany({
			where: { ...target(instance), key: { in: whatsappParameterSettings.map((setting) => setting.key) } },
			orderBy: { id: "asc" }
		});
		return {
			catalog: whatsappParameterSettings,
			values: Object.fromEntries(
				whatsappParameterSettings.map((setting) => [
					setting.key,
					parameters.filter((parameter) => parameter.key === setting.key).at(-1)?.value ?? null
				])
			)
		};
	}

	public async save(instance: string, body: unknown) {
		const changes = parseParameterChanges(body);
		try {
			return await prismaService.$transaction(
				async (tx) => {
					for (const change of changes) {
						const where = { ...target(instance), key: change.key };
						const existing = await tx.parameter.findMany({ where, orderBy: { id: "asc" } });
						if ((existing.at(-1)?.value ?? null) !== change.previousValue) {
							throw new ConflictError(
								"As configurações foram alteradas por outra pessoa. Recarregue antes de salvar."
							);
						}
						if (change.value === null) await tx.parameter.deleteMany({ where });
						else if (existing.length)
							await tx.parameter.updateMany({ where, data: { value: change.value } });
						else await tx.parameter.create({ data: { ...where, value: change.value } });
					}
					const parameters = await tx.parameter.findMany({
						where: {
							...target(instance),
							key: { in: whatsappParameterSettings.map((setting) => setting.key) }
						},
						orderBy: { id: "asc" }
					});
					return {
						catalog: whatsappParameterSettings,
						values: Object.fromEntries(
							whatsappParameterSettings.map((setting) => [
								setting.key,
								parameters.filter((parameter) => parameter.key === setting.key).at(-1)?.value ?? null
							])
						)
					};
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
			);
		} catch (error) {
			if ((error as { code?: string })?.code === "P2034") {
				throw new ConflictError("Houve uma alteração simultânea. Recarregue as configurações antes de salvar.");
			}
			throw error;
		}
	}
}

export default new ParameterSettingsService();
