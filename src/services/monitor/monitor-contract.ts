import { BadRequestError } from "@rgranatodutra/http-errors";

export type OperationalStatus =
	| "all"
	| "in_progress"
	| "waiting_agent"
	| "waiting_customer"
	| "unread"
	| "overdue"
	| "scheduled";
export type MonitorItemStatus = "in_progress" | "waiting_agent" | "waiting_customer" | "finished" | "scheduled";
export type MonitorCategory = "wpp" | "internal" | "schedule";
export interface DateRange {
	from: string | null;
	to: string | null;
}
export interface MonitorFilters {
	searchText: string;
	searchColumn: "all" | "name" | "phone" | "customer" | "message";
	categories: {
		showCustomerChats: boolean;
		showInternalChats: boolean;
		showInternalGroups: boolean;
		showSchedules: boolean;
	};
	user: number | "all";
	showBots: boolean;
	showOngoing: boolean;
	showFinished: boolean;
	showOnlyScheduled: boolean;
	showUnreadOnly: boolean;
	showPendingResponseOnly: boolean;
	operationalStatus: OperationalStatus;
	sortBy: "urgency" | "startedAt" | "finishedAt" | "lastMessage" | "scheduledAt" | "name";
	sortOrder: "asc" | "desc";
	startedAt: DateRange;
	finishedAt: DateRange;
	scheduledAt: DateRange;
	scheduledTo: DateRange;
	scheduledBy: number | "all";
	scheduledFor: number | "all";
}
export interface MonitorSearchInput {
	page?: unknown;
	pageSize?: unknown;
	filters?: unknown;
}
export interface MonitorRequest {
	page: number;
	pageSize: number;
	filters: MonitorFilters;
}
export interface MonitorOperational {
	status: MonitorItemStatus;
	lastMessageAt: string | null;
	lastMessagePreview: string | null;
	waitingSince: string | null;
	unreadCount: number | null;
	channel: string | null;
	deliveryStatus: string | null;
	slaBreached: boolean | null;
}
export interface MonitorSummary {
	inProgress: number;
	waitingAgent: number;
	waitingCustomer: number;
	unread: number;
	overdue: number;
	scheduled: number;
	slaMinutes: number | null;
}
export const SCHEDULE_WINDOW_HOURS = 24;

function record(value: unknown, field: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError(`Filtro inválido: ${field}`);
	return value as Record<string, unknown>;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !allowed.includes(value as T))
		throw new BadRequestError(`Filtro inválido: ${field}`);
	return value as T;
}
function integer(value: unknown, fallback: number, max: number, field: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new BadRequestError(`${field} deve ser inteiro entre 1 e ${max}.`);
	}
	return value;
}
function user(value: unknown, field: string): number | "all" {
	return value === undefined || value === "all" ? "all" : integer(value, 1, 2147483647, field);
}
function bool(value: unknown, fallback: boolean, field: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new BadRequestError(`Filtro inválido: ${field}`);
	return value;
}
function dateRange(value: unknown, field: string): DateRange {
	const source = record(value, field);
	const parse = (part: unknown, end: boolean): string | null => {
		if (part === undefined || part === null || part === "") return null;
		if (
			typeof part !== "string" ||
			!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(part) ||
			!Number.isFinite(Date.parse(part))
		) {
			throw new BadRequestError(`Data inválida: ${field}`);
		}
		if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
			const [year, month, day] = part.split("-").map(Number);
			const date = new Date(year!, month! - 1, day!, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
			if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day)
				throw new BadRequestError(`Data inválida: ${field}`);
			return date.toISOString();
		}
		return new Date(part).toISOString();
	};
	const from = parse(source["from"], false),
		to = parse(source["to"], true);
	if (from && to && from > to) throw new BadRequestError(`Intervalo inválido: ${field}`);
	return { from, to };
}
export function parseMonitorRequest(input: MonitorSearchInput = {}): MonitorRequest {
	const f = record(input.filters, "filters"),
		categories = record(f["categories"], "categories");
	const searchText = f["searchText"] ?? "";
	if (typeof searchText !== "string" || searchText.length > 250)
		throw new BadRequestError("Pesquisa deve ter até 250 caracteres.");
	const filters: MonitorFilters = {
		searchText: searchText.trim(),
		searchColumn: oneOf(f["searchColumn"], ["all", "name", "phone", "customer", "message"], "all", "searchColumn"),
		categories: {
			showCustomerChats: bool(categories["showCustomerChats"], true, "showCustomerChats"),
			showInternalChats: bool(categories["showInternalChats"], true, "showInternalChats"),
			showInternalGroups: bool(categories["showInternalGroups"], true, "showInternalGroups"),
			showSchedules: bool(categories["showSchedules"], true, "showSchedules")
		},
		user: user(f["user"], "user"),
		scheduledBy: user(f["scheduledBy"], "scheduledBy"),
		scheduledFor: user(f["scheduledFor"], "scheduledFor"),
		showBots: bool(f["showBots"], false, "showBots"),
		showOngoing: bool(f["showOngoing"], true, "showOngoing"),
		showFinished: bool(f["showFinished"], true, "showFinished"),
		showOnlyScheduled: bool(f["showOnlyScheduled"], false, "showOnlyScheduled"),
		showUnreadOnly: bool(f["showUnreadOnly"], false, "showUnreadOnly"),
		showPendingResponseOnly: bool(f["showPendingResponseOnly"], false, "showPendingResponseOnly"),
		operationalStatus: oneOf(
			f["operationalStatus"],
			["all", "in_progress", "waiting_agent", "waiting_customer", "unread", "overdue", "scheduled"],
			"all",
			"operationalStatus"
		),
		sortBy: oneOf(
			f["sortBy"],
			["urgency", "startedAt", "finishedAt", "lastMessage", "scheduledAt", "name"],
			"urgency",
			"sortBy"
		),
		sortOrder: oneOf(f["sortOrder"], ["asc", "desc"], "desc", "sortOrder"),
		startedAt: dateRange(f["startedAt"], "startedAt"),
		finishedAt: dateRange(f["finishedAt"], "finishedAt"),
		scheduledAt: dateRange(f["scheduledAt"], "scheduledAt"),
		scheduledTo: dateRange(f["scheduledTo"], "scheduledTo")
	};
	return {
		page: integer(input.page, 1, 1000000, "page"),
		pageSize: integer(input.pageSize, 20, 100, "pageSize"),
		filters
	};
}
export function parseSlaMinutes(value: string | undefined): number | null {
	if (!value?.trim()) return null;
	const minutes = Number(value);
	return Number.isFinite(minutes) && minutes > 0 && minutes <= 525600 ? minutes : null;
}
