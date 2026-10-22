import { BadRequestError } from "@rgranatodutra/http-errors";
import positiveResourceId from "../utils/positive-resource-id";

export interface ContactEdit { name?: string; customerId?: number | null }

/** customerId is a compatibility precondition only; the dedicated link command owns changes. */
export function parseContactEdit(input: unknown): ContactEdit {
	if (!input || typeof input !== "object" || Array.isArray(input) ||
		Object.keys(input).some(key => !["name", "customerId"].includes(key))) {
		throw new BadRequestError("Campos de edição do contato inválidos.");
	}
	const value = input as Record<string, unknown>;
	const result: ContactEdit = {};
	if (Object.hasOwn(value, "name")) {
		if (typeof value["name"] !== "string" || !value["name"].trim() || value["name"].trim().length > 191) {
			throw new BadRequestError("Informe um nome de até 191 caracteres.");
		}
		result.name = value["name"].trim();
	}
	if (Object.hasOwn(value, "customerId")) result.customerId = value["customerId"] === null ? null : positiveResourceId(value["customerId"]);
	return result;
}

export function parseContactSectorIds(input: unknown): number[] | undefined {
	if (input === undefined || input === null) return undefined;
	if (!Array.isArray(input) || input.length > 100) throw new BadRequestError("Setores inválidos.");
	return [...new Set(input.map(positiveResourceId))];
}
