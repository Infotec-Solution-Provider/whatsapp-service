import { BadRequestError } from "@rgranatodutra/http-errors";
import prisma from "./prisma.service";
import instances from "./instances.service";
import { parseParameterTarget } from "../parameters/parameter-settings.target";

interface TargetUser {
	CODIGO: number;
	NOME: string;
	SETOR: number | null;
	ATIVO: string | null;
}

class ParameterSettingsTargetsService {
	public async resolve(instance: string, input?: unknown) {
		const target = parseParameterTarget(input);
		if (target.scope === "INSTANCE") return { ...target, name: instance };
		if (target.scope === "SECTOR") {
			const sector = await prisma.wppSector.findFirst({
				where: { id: target.sectorId!, instance },
				select: { id: true, name: true }
			});
			if (!sector) throw new BadRequestError("Setor não encontrado nesta instância.");
			return { ...target, name: sector.name };
		}
		const [user] = await instances.executeQuery<TargetUser[]>(
			instance,
			"SELECT CODIGO, NOME, SETOR, ATIVO FROM operadores WHERE CODIGO = ?",
			[target.userId!]
		);
		if (!user) throw new BadRequestError("Usuário não encontrado nesta instância.");
		const sector = user.SETOR
			? await prisma.wppSector.findFirst({
					where: { id: Number(user.SETOR), instance },
					select: { id: true, name: true }
				})
			: null;
		return {
			...target,
			name: user.NOME,
			inheritedSectorId: sector?.id ?? null,
			inheritedSectorName: sector?.name ?? null
		};
	}

	public async list(instance: string, rawSearch: unknown = "", scope: unknown = "USER") {
		if (scope !== "SECTOR" && scope !== "USER") throw new BadRequestError("Escopo de busca inválido.");
		if (typeof rawSearch !== "string" || rawSearch.length > 100) throw new BadRequestError("Busca inválida.");
		const search = rawSearch.trim();
		// Bound values, a fixed limit and an explicit projection keep credentials out of this response.
		const [sectors, users] = await Promise.all([
			prisma.wppSector.findMany({
				where: { instance },
				select: { id: true, name: true },
				orderBy: { name: "asc" }
			}),
			scope === "USER"
				? instances.executeQuery<TargetUser[]>(
						instance,
						"SELECT CODIGO, NOME, SETOR, ATIVO FROM operadores WHERE (LOCATE(?, NOME) > 0 OR CAST(CODIGO AS CHAR) = ?) ORDER BY NOME, CODIGO LIMIT 51",
						[search, search]
					)
				: []
		]);
		return {
			sectors,
			users: users
				.slice(0, 50)
				.map((user) => ({ id: Number(user.CODIGO), name: user.NOME, active: user.ATIVO !== "NAO" })),
			hasMoreUsers: users.length > 50
		};
	}
}
export default new ParameterSettingsTargetsService();
