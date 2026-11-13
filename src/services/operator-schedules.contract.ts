import { BadRequestError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import type { UnifiedScheduleFilters } from "../types/unified-schedule.types";
import parseScheduleEdit from "./schedule-edit.contract";

export const SCHEDULE_TIME_ZONE = "America/Sao_Paulo";
const enums = {
	channels: ["WHATSAPP", "TELEFONIA"],
	repurchaseStatuses: ["green", "yellow", "red", "neutral"],
	profileLevel: ["potencial_de_compra", "consolidado", "precisa_mais_interacao", "em_observacao"],
	interactionLevel: ["sem_interacao", "pouca_interacao", "interacao_media", "interacao_alta"],
	purchaseLevel: ["sem_compras", "poucas_compras", "compras_medias", "muitas_compras"],
	ageLevel: ["sem_data_cadastro", "cliente_novo", "ate_6_meses", "ate_12_meses", "mais_de_12_meses"],
	purchaseInterestLevel: [
		"nao_analisado",
		"baixo_interesse",
		"interesse_moderado",
		"alto_interesse",
		"pronto_para_compra"
	],
	period: ["all", "overdue", "today", "next7", "custom"],
	sortOrder: ["asc", "desc"]
} as const;
const listFields = new Set(["channels", "customerCampaignIds", "repurchaseStatuses"]);
const allowedFields = new Set([
	...Object.keys(enums),
	"page",
	"perPage",
	"customerCampaignIds",
	"userId",
	"sectorId",
	"search",
	"scheduledFrom",
	"scheduledTo"
]);

export function parseScheduleQuery(input: unknown, session: SessionData, personal = false): UnifiedScheduleFilters {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new BadRequestError("Filtros de agendamento inválidos.");
	const result: Record<string, string> = {};
	for (const [key, raw] of Object.entries(input)) {
		if (
			!allowedFields.has(key) ||
			typeof raw !== "string" ||
			raw.length > (listFields.has(key) ? 2000 : key === "search" ? 200 : 100)
		)
			throw new BadRequestError(`Filtro inválido: ${key}.`);
		if (personal && (key === "userId" || key === "sectorId"))
			throw new BadRequestError("A agenda pessoal usa o usuário da sessão.");
		const value = raw.trim();
		if (!value) continue;
		if (["page", "perPage", "userId", "sectorId"].includes(key)) {
			const number = Number(value);
			if (
				!/^\d+$/.test(value) ||
				!Number.isSafeInteger(number) ||
				number < 1 ||
				(key === "perPage" && number > 100) ||
				(key === "page" && number > 1_000_000)
			)
				throw new BadRequestError(`Valor inválido para ${key}.`);
			if (
				session.role !== "ADMIN" &&
				((key === "userId" && number !== session.userId) || (key === "sectorId" && number !== session.sectorId))
			)
				throw new UnauthorizedError("Você não pode consultar a agenda de outro operador ou setor.");
			result[key] = String(number);
			continue;
		}
		if (key === "scheduledFrom" || key === "scheduledTo") {
			result[key] = parseScheduleEdit({ scheduleDate: value }).scheduleDate!.toISOString();
			continue;
		}
		if (key === "customerCampaignIds") {
			const parts = value.split(",");
			if (
				parts.length > 100 ||
				parts.some(
					(part) => !/^\d+$/.test(part.trim()) || !Number.isSafeInteger(Number(part)) || Number(part) < 1
				)
			)
				throw new BadRequestError("Campanhas inválidas.");
			result[key] = [...new Set(parts.map((part) => String(Number(part))))].join(",");
			continue;
		}
		const choices = enums[key as keyof typeof enums] as readonly string[] | undefined;
		if (choices) {
			const parts = listFields.has(key) ? value.split(",").map((part) => part.trim()) : [value];
			if (parts.length > 100 || parts.some((part) => !choices.includes(part)))
				throw new BadRequestError(`Opção inválida para ${key}.`);
			result[key] = [...new Set(parts)].join(",");
			continue;
		}
		result[key] = value;
	}
	if (result["period"] === "custom") {
		if (!result["scheduledFrom"] || !result["scheduledTo"] || result["scheduledFrom"] >= result["scheduledTo"])
			throw new BadRequestError("Informe o início e o fim do período, nessa ordem.");
	} else if (result["scheduledFrom"] || result["scheduledTo"])
		throw new BadRequestError("Datas personalizadas exigem o período custom.");
	return result as UnifiedScheduleFilters;
}

export function normalizeScheduleSearch(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLocaleLowerCase("pt-BR")
		.trim();
}

const civilFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: SCHEDULE_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23"
});
export function scheduleCivil(value: Date): string {
	const parts = Object.fromEntries(civilFormatter.formatToParts(value).map((part) => [part.type, part.value]));
	return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
}

/** Legacy DATETIME has second precision. Ceil a millisecond bound so >=/< keep
 * their exact meaning for stored whole-second values, including the current second. */
export function scheduleCivilBoundary(value: Date): string {
	return scheduleCivil(new Date(Math.ceil(value.getTime() / 1000) * 1000));
}

/** Legacy CRM DATETIME is a civil Sao Paulo value, never a UTC timestamp. */
export function scheduleCivilDate(value: string): Date {
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(value);
	if (!match) throw new BadRequestError("Data do agendamento CRM inválida.");
	const desired = Date.parse(`${match[1]}T${match[2]}Z`);
	if (!Number.isFinite(desired) || new Date(desired).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`)
		throw new BadRequestError("Data do agendamento CRM inválida.");
	let instant = desired;
	for (let i = 0; i < 3; i++)
		instant += desired - Date.parse(scheduleCivil(new Date(instant)).replace(" ", "T") + "Z");
	const result = new Date(instant);
	if (!Number.isFinite(instant) || scheduleCivil(result) !== `${match[1]} ${match[2]}`)
		throw new BadRequestError("Data do agendamento CRM inválida.");
	return result;
}

export function schedulePeriod(filters: UnifiedScheduleFilters, now: Date): { from?: Date; to?: Date } {
	switch (filters.period ?? "all") {
		case "overdue":
			return { to: now };
		case "next7":
			return { from: now, to: new Date(now.getTime() + 7 * 86400000) };
		case "today": {
			const from = scheduleCivilDate(scheduleCivil(now).slice(0, 10) + " 00:00:00");
			const tomorrowCivil = new Date(Date.parse(scheduleCivil(now).slice(0, 10) + "T00:00:00Z") + 86400000)
				.toISOString()
				.slice(0, 10);
			return { from, to: scheduleCivilDate(tomorrowCivil + " 00:00:00") };
		}
		case "custom":
			return { from: new Date(filters.scheduledFrom!), to: new Date(filters.scheduledTo!) };
		default:
			return {};
	}
}
