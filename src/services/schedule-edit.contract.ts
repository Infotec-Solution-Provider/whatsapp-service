import { BadRequestError } from "@rgranatodutra/http-errors";

export interface ScheduleEdit { description?: string | null; scheduleDate?: Date }

export default function parseScheduleEdit(input: unknown): ScheduleEdit {
	if (!input || typeof input !== "object" || Array.isArray(input) ||
		!Object.keys(input).length || Object.keys(input).some(key => !["description", "scheduleDate"].includes(key))) {
		throw new BadRequestError("Altere somente a data ou a descrição do agendamento.");
	}
	const value = input as Record<string, unknown>;
	const result: ScheduleEdit = {};
	if (Object.hasOwn(value, "description")) {
		if (value["description"] !== null && (typeof value["description"] !== "string" || value["description"].length > 191)) {
			throw new BadRequestError("Use uma descrição de até 191 caracteres.");
		}
		result.description = value["description"] as string | null;
	}
	if (Object.hasOwn(value, "scheduleDate")) {
		const raw = value["scheduleDate"];
		if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
			throw new BadRequestError("Informe a data com fuso horário.");
		}
		const date = new Date(raw);
		// Validate calendar components independently of Date's normalization of invalid dates.
		const day = raw.slice(0, 10), calendar = new Date(`${day}T00:00:00Z`);
		if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) {
			throw new BadRequestError("Data de agendamento inválida.");
		}
		result.scheduleDate = date;
	}
	return result;
}
