import { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import prisma from "./prisma.service";
import targets from "./parameter-settings-targets.service";
import { whatsappParameterSettings } from "../parameters/parameter-settings.catalog";
import { parseParameterChanges } from "../parameters/parameter-settings.contract";
import type { ParameterTarget } from "../parameters/parameter-settings.target";

type ResolvedTarget = Awaited<ReturnType<typeof targets.resolve>>;

function targetWhere(instance: string, target: ParameterTarget): Prisma.ParameterWhereInput {
	if (target.scope === "SECTOR")
		return { scope: "SECTOR", sectorId: target.sectorId!, userId: null, OR: [{ instance }, { instance: null }] };
	if (target.scope === "USER") return { scope: "USER", instance, userId: target.userId! };
	return { scope: "INSTANCE", instance, sectorId: null, userId: null };
}

class ParameterSettingsService {
	private async snapshot(
		instance: string,
		target: ResolvedTarget,
		db: Pick<Prisma.TransactionClient, "parameter"> = prisma
	) {
		const catalog = whatsappParameterSettings.filter((setting) => setting.supportedScopes!.includes(target.scope));
		const sectorId = "inheritedSectorId" in target ? target.inheritedSectorId : null;
		const [own, instanceRows, sectorRows] = await Promise.all([
			db.parameter.findMany({
				where: { ...targetWhere(instance, target), key: { in: catalog.map((setting) => setting.key) } },
				orderBy: { id: "asc" }
			}),
			target.scope !== "INSTANCE"
				? db.parameter.findMany({ where: targetWhere(instance, { scope: "INSTANCE" }), orderBy: { id: "asc" } })
				: [],
			target.scope === "USER" && sectorId
				? db.parameter.findMany({
						where: targetWhere(instance, { scope: "SECTOR", sectorId }),
						orderBy: { id: "asc" }
					})
				: []
		]);
		const toMap = (rows: { key: string; value: string }[]) =>
			Object.fromEntries(rows.map((row) => [row.key, row.value]));
		const instanceValues = toMap(instanceRows),
			sectorValues = toMap(sectorRows),
			ownValues = toMap(own);
		const inherited = Object.fromEntries(
			catalog.map((setting) => [
				setting.key,
				{
					value: sectorValues[setting.key] ?? instanceValues[setting.key] ?? setting.defaultValue,
					source:
						sectorValues[setting.key] !== undefined
							? "SECTOR"
							: instanceValues[setting.key] !== undefined
								? "INSTANCE"
								: "DEFAULT"
				}
			])
		);
		return {
			target,
			catalog,
			values: Object.fromEntries(catalog.map((setting) => [setting.key, ownValues[setting.key] ?? null])),
			inherited
		};
	}

	public async get(instance: string, input?: unknown) {
		return this.snapshot(instance, await targets.resolve(instance, input));
	}

	public async save(instance: string, body: unknown) {
		const changes = parseParameterChanges(body);
		const target = await targets.resolve(instance, (body as { target?: unknown } | null)?.target);
		for (const change of changes) {
			if (
				!whatsappParameterSettings
					.find((setting) => setting.key === change.key)!
					.supportedScopes!.includes(target.scope)
			)
				throw new BadRequestError("Esta configuração não permite o escopo selecionado.");
		}
		try {
			return await prisma.$transaction(
				async (tx) => {
					for (const change of changes) {
						const where = { ...targetWhere(instance, target), key: change.key };
						const existing = await tx.parameter.findMany({ where, orderBy: { id: "asc" } });
						if ((existing.at(-1)?.value ?? null) !== change.previousValue)
							throw new ConflictError(
								"As configurações foram alteradas por outra pessoa. Recarregue antes de salvar."
							);
						if (change.value === null) await tx.parameter.deleteMany({ where });
						else if (existing.length)
							await tx.parameter.updateMany({ where, data: { value: change.value } });
						else
							await tx.parameter.create({
								data: {
									scope: target.scope,
									instance,
									sectorId: target.scope === "SECTOR" ? target.sectorId! : null,
									userId: target.scope === "USER" ? target.userId! : null,
									key: change.key,
									value: change.value
								}
							});
					}
					return this.snapshot(instance, target, tx);
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
			);
		} catch (error) {
			if ((error as { code?: string })?.code === "P2034")
				throw new ConflictError("Houve uma alteração simultânea. Recarregue as configurações antes de salvar.");
			throw error;
		}
	}
}
export default new ParameterSettingsService();
