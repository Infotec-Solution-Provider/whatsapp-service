import { BadRequestError } from "@rgranatodutra/http-errors";

export default function positiveResourceId(value: unknown): number {
	if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) {
		throw new BadRequestError("Identificador inválido.");
	}
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new BadRequestError("Identificador inválido.");
	return id;
}
