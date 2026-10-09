import { BadRequestError } from "@rgranatodutra/http-errors";

export type ParameterScope = "INSTANCE" | "SECTOR" | "USER";
export interface ParameterTarget {
	scope: ParameterScope;
	sectorId?: number;
	userId?: number;
}

export function parseParameterTarget(input: unknown): ParameterTarget {
	if (input === undefined) return { scope: "INSTANCE" };
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new BadRequestError("Escopo inválido.");
	const { scope = "INSTANCE", sectorId, userId } = input as Record<string, unknown>;
	const id = (value: unknown) => {
		if (
			(typeof value !== "string" && typeof value !== "number") ||
			!/^[1-9]\d*$/.test(String(value)) ||
			!Number.isSafeInteger(Number(value)) ||
			Number(value) > 2147483647
		)
			throw new BadRequestError("Selecione um setor ou usuário válido.");
		return Number(value);
	};
	if (scope === "INSTANCE" && sectorId === undefined && userId === undefined) return { scope };
	if (scope === "SECTOR" && userId === undefined) return { scope, sectorId: id(sectorId) };
	if (scope === "USER" && sectorId === undefined) return { scope, userId: id(userId) };
	throw new BadRequestError("Escopo inválido.");
}
