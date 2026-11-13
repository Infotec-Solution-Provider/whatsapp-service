import { InternalServerError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { Prisma } from "@prisma/client";
import type { CustomerProfileSummaryPayload, SessionData } from "../sdk-local";
import customerProfileTagsService from "./customer-profile-tags.service";
import instancesService from "./instances.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";
import {
	normalizeScheduleSearch,
	parseScheduleQuery,
	scheduleCivilBoundary,
	scheduleCivilDate,
	schedulePeriod,
	SCHEDULE_TIME_ZONE
} from "./operator-schedules.contract";
import type {
	UnifiedScheduleChannel,
	UnifiedScheduleFilters,
	UnifiedScheduleItem,
	UnifiedScheduleRepurchaseMetrics,
	UnifiedScheduleRepurchaseStatus,
	UnifiedSchedulesResponse
} from "../types/unified-schedule.types";

type Warning = { code: string; message: string };
interface CustomerRow {
	CODIGO: number;
	RAZAO: string | null;
	FANTASIA: string | null;
	COD_CAMPANHA: number | null;
	ORIGEM: number | null;
	BLOCK_COMPRAS: string | null;
	CUSTOMER_CAMPAIGN_NAME: string | null;
	CUSTOMER_ORIGIN_DESCRIPTION: string | null;
}
interface ScheduleRow {
	id: number;
	channel: UnifiedScheduleChannel;
	scheduleAt: string;
	scheduledBy: number | null;
	scheduledFor: number | null;
	description: string | null;
	contactName: string | null;
	contactPhone: string | null;
	customerId: number | null;
	telephonyCampaignId: number | null;
	telephonyCampaignName: string | null;
	wppContactId?: number;
	wppChatId?: number | null;
}
interface Source {
	channel: UnifiedScheduleChannel;
	read(offset: number, limit: number, ids?: number[]): Promise<ScheduleRow[]>;
	invalid(): Promise<number>;
}
interface Enrichment {
	customers: Map<number, CustomerRow>;
	profiles: Map<number, CustomerProfileSummaryPayload>;
	repurchases: Map<number, UnifiedScheduleRepurchaseMetrics>;
	unavailable: boolean;
}
const batchSize = 200;
const profileFields = [
	"profileLevel",
	"interactionLevel",
	"purchaseLevel",
	"ageLevel",
	"purchaseInterestLevel"
] as const;

export class UnifiedSchedulesService {
	constructor(
		private readonly database = prismaService,
		private readonly crm = instancesService,
		private readonly parameters = parametersService,
		private readonly profiles = customerProfileTagsService,
		private readonly clock = () => new Date(),
		private readonly observe: (event: Record<string, unknown>) => void = (event) =>
			console.info("[operator-schedules]", JSON.stringify(event))
	) {}

	async getMySchedules(session: SessionData, raw: unknown): Promise<UnifiedSchedulesResponse> {
		return this.read(session, parseScheduleQuery(raw, session, true), true);
	}
	async getUnifiedSchedules(session: SessionData, raw: unknown): Promise<UnifiedSchedulesResponse> {
		return this.read(session, parseScheduleQuery(raw, session), false);
	}

	private async read(
		session: SessionData,
		filters: UnifiedScheduleFilters,
		personal: boolean
	): Promise<UnifiedSchedulesResponse> {
		const startedAt = performance.now();
		const stages: Array<{
			channel: UnifiedScheduleChannel;
			candidates: number;
			queryMs: number;
			enrichmentMs: number;
		}> = [];
		const referenceAt = this.clock(),
			warnings: Warning[] = [];
		let commercialAccessUnavailable = false;
		const warn = (code: string, message: string) => {
			if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message });
		};
		const [params, financial] = await Promise.all([
			this.parameters.getSessionParams(session),
			session.role === "ADMIN"
				? Promise.resolve(true)
				: this.crm
						.executeQuery<Array<{ VISUALIZA_COMPRAS: string | null }>>(
							session.instance,
							"SELECT VISUALIZA_COMPRAS FROM operadores WHERE CODIGO=? AND (ATIVO IS NULL OR ATIVO<>'NAO') LIMIT 1",
							[session.userId],
							{ timeoutMs: 10000 }
						)
						.then((rows) => rows[0]?.VISUALIZA_COMPRAS === "SIM")
						.catch(() => {
							commercialAccessUnavailable = true;
							warn(
								"COMMERCIAL_ACCESS_UNAVAILABLE",
								"Não foi possível verificar o acesso aos dados comerciais."
							);
							return false;
						})
		]);
		const hasProfileFilter = profileFields.some((field) => Boolean(filters[field]));
		const commercialFilter = hasProfileFilter || Boolean(filters.repurchaseStatuses);
		if (commercialFilter && commercialAccessUnavailable)
			throw new InternalServerError("Não foi possível verificar o acesso aos dados comerciais. Tente novamente.");
		if (commercialFilter && !financial)
			throw new UnauthorizedError("Seu perfil não permite filtros de informações comerciais.");
		const channels: UnifiedScheduleChannel[] = [
			"WHATSAPP",
			...(params["use_old_crm_schedule"] === "true" ? ["TELEFONIA" as const] : [])
		];
		const selected = filters.channels ? (filters.channels.split(",") as UnifiedScheduleChannel[]) : channels;
		const requested = selected.filter((channel) => channels.includes(channel));
		if (selected.some((channel) => !channels.includes(channel)))
			warn("CHANNEL_UNAVAILABLE", "Um canal selecionado não está habilitado neste ambiente.");
		const sources = requested.map((channel) => this.source(channel, session, filters, personal, referenceAt));
		for (const source of sources) {
			const invalid = await source.invalid().catch(() => {
				throw new InternalServerError("Não foi possível consultar os agendamentos. Tente novamente.");
			});
			if (invalid)
				warn("INVALID_SCHEDULE_DATES", `${invalid} agendamento(s) sem data válida foram desconsiderados.`);
		}
		const eligible = new Map<UnifiedScheduleChannel, number[]>(),
			campaigns = new Map<string, { id: string; label: string }>();
		// Exact global predicates are evaluated in bounded batches before paging.
		// Retain candidate identifiers, never full enriched histories.
		for (const source of sources) {
			const matching: number[] = [];
			const stage = { channel: source.channel, candidates: 0, queryMs: 0, enrichmentMs: 0 };
			stages.push(stage);
			for (let offset = 0; ; offset += batchSize) {
				let rows: ScheduleRow[];
				const readStartedAt = performance.now();
				try {
					rows = await source.read(offset, batchSize);
				} catch {
					throw new InternalServerError("Um canal de agendamentos não respondeu. Tente novamente.");
				}
				if (!rows.length) break;
				stage.queryMs += performance.now() - readStartedAt;
				stage.candidates += rows.length;
				const enrichmentStartedAt = performance.now();
				const enrichment = await this.enrich(
					session,
					rows,
					financial,
					hasProfileFilter || Boolean(filters.search),
					Boolean(filters.repurchaseStatuses),
					warnings,
					Boolean(filters.search) || commercialFilter || Boolean(filters.customerCampaignIds),
					referenceAt
				);
				stage.enrichmentMs += performance.now() - enrichmentStartedAt;
				for (const row of rows) {
					const customer = row.customerId ? enrichment.customers.get(row.customerId) : undefined;
					if (customer?.COD_CAMPANHA && customer.CUSTOMER_CAMPAIGN_NAME)
						campaigns.set(String(customer.COD_CAMPANHA), {
							id: String(customer.COD_CAMPANHA),
							label: customer.CUSTOMER_CAMPAIGN_NAME
						});
					if (this.matches(row, customer, enrichment, filters, financial, session.role === "ADMIN"))
						matching.push(row.id);
				}
				if (rows.length < batchSize) break;
			}
			eligible.set(source.channel, matching);
		}
		const totalRows = [...eligible.values()].reduce((sum, ids) => sum + ids.length, 0),
			perPage = Number(filters.perPage ?? 25),
			totalPages = Math.max(1, Math.ceil(totalRows / perPage)),
			page = Math.min(Number(filters.page ?? 1), totalPages);
		let rows: ScheduleRow[];
		try {
			rows = await this.page(sources, eligible, (page - 1) * perPage, perPage, filters.sortOrder ?? "asc");
		} catch {
			throw new InternalServerError("Não foi possível carregar a página de agendamentos. Tente novamente.");
		}
		const enrichment = await this.enrich(session, rows, financial, true, true, warnings, false, referenceAt);
		try {
			this.observe({
				instance: session.instance,
				userId: session.userId,
				scope: personal ? "mine" : "unified",
				channels: requested,
				totalRows,
				page,
				perPage,
				elapsedMs: Math.round(performance.now() - startedAt),
				stages: stages.map((stage) => ({
					...stage,
					queryMs: Math.round(stage.queryMs),
					enrichmentMs: Math.round(stage.enrichmentMs)
				})),
				warnings: warnings.map((warning) => warning.code)
			});
		} catch {
			/* Diagnostics must not change an otherwise successful read. */
		}
		return {
			message: "Unified schedules retrieved successfully!",
			data: rows.map((row) => this.item(row, enrichment, financial, session.role === "ADMIN")),
			page: { current: page, totalRows },
			pagination: {
				current: page,
				perPage,
				totalRows,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1
			},
			filters: {
				customerCampaigns: [...campaigns.values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR"))
			},
			referenceAt: referenceAt.toISOString(),
			timeZone: SCHEDULE_TIME_ZONE,
			warnings,
			capabilities: { channels, commercial: financial }
		};
	}

	private source(
		channel: UnifiedScheduleChannel,
		session: SessionData,
		filters: UnifiedScheduleFilters,
		personal: boolean,
		now: Date
	): Source {
		const userId = personal ? session.userId : Number(filters.userId ?? session.userId),
			bounds = schedulePeriod(filters, now),
			direction = filters.sortOrder ?? "asc";
		if (channel === "WHATSAPP") {
			const where: Prisma.WppScheduleWhereInput = {
				instance: session.instance,
				chatId: null,
				scheduledFor: userId,
				...(!personal ? { sectorId: Number(filters.sectorId ?? session.sectorId) } : {}),
				contact: { isDeleted: false, ...(session.role === "ADMIN" ? {} : { isOnlyAdmin: false }) },
				...(bounds.from || bounds.to
					? {
							scheduleDate: {
								...(bounds.from ? { gte: bounds.from } : {}),
								...(bounds.to ? { lt: bounds.to } : {})
							}
						}
					: {})
			};
			return {
				channel,
				invalid: async () => 0,
				read: async (offset, limit, ids) => {
					if (ids && !ids.length) return [];
					const rows = await this.database.wppSchedule.findMany({
						where: { ...where, ...(ids ? { id: { in: ids } } : {}) },
						select: {
							id: true,
							scheduleDate: true,
							scheduledBy: true,
							scheduledFor: true,
							description: true,
							contactId: true,
							chatId: true,
							contact: { select: { name: true, phone: true, customerId: true } }
						},
						orderBy: [{ scheduleDate: direction }, { id: "asc" }],
						skip: offset,
						take: limit
					});
					return rows.map((row) => ({
						id: row.id,
						channel,
						scheduleAt: row.scheduleDate.toISOString(),
						scheduledBy: row.scheduledBy,
						scheduledFor: row.scheduledFor,
						description: row.description,
						contactName: row.contact?.name ?? null,
						contactPhone: row.contact?.phone ?? null,
						customerId: row.contact?.customerId ?? null,
						telephonyCampaignId: null,
						telephonyCampaignName: null,
						wppContactId: row.contactId,
						wppChatId: row.chatId
					}));
				}
			};
		}
		const valid =
			"YEAR(cc.DT_AGENDAMENTO)>=1000 AND MONTH(cc.DT_AGENDAMENTO) BETWEEN 1 AND 12 AND DAY(cc.DT_AGENDAMENTO) BETWEEN 1 AND DAY(LAST_DAY(cc.DT_AGENDAMENTO))";
		const base = "cc.OPERADOR=? AND cc.DT_AGENDAMENTO IS NOT NULL AND (cc.CONCLUIDO='NAO' OR cc.CONCLUIDO IS NULL)";
		return {
			channel,
			invalid: async () => {
				const rows = await this.crm.executeQuery<Array<{ total: number }>>(
					session.instance,
					`SELECT COUNT(*) AS total FROM campanhas_clientes cc WHERE ${base} AND NOT COALESCE((${valid}),0)`,
					[userId],
					{ timeoutMs: 10000 }
				);
				return Number(rows[0]?.total ?? 0);
			},
			read: async (offset, limit, ids) => {
				if (ids && !ids.length) return [];
				type TelephonyRow = {
					CODIGO: number;
					CLIENTE: number | null;
					CAMPANHA: number | null;
					date: string;
					OPERADOR: number | null;
					OPERADOR_LIGACAO: number | null;
					phone: string | null;
					name: string | null;
					campaign: string | null;
					operatorName: string | null;
				};
				const conditions = [base, valid],
					values: unknown[] = [userId];
				if (bounds.from) {
					conditions.push("cc.DT_AGENDAMENTO>=?");
					values.push(scheduleCivilBoundary(bounds.from));
				}
				if (bounds.to) {
					conditions.push("cc.DT_AGENDAMENTO<?");
					values.push(scheduleCivilBoundary(bounds.to));
				}
				if (ids) {
					conditions.push("cc.CODIGO IN (?)");
					values.push(ids);
				}
				const rows = await this.crm.executeQuery<TelephonyRow[]>(
					session.instance,
					"SELECT /*+ MAX_EXECUTION_TIME(5000) */ cc.CODIGO,cc.CLIENTE,cc.CAMPANHA,DATE_FORMAT(cc.DT_AGENDAMENTO,'%Y-%m-%d %H:%i:%s') AS date,cc.OPERADOR,cc.OPERADOR_LIGACAO,COALESCE(cc.TELEFONE_LIGADO,cc.FONE1,cc.FONE2,cc.FONE3) AS phone,COALESCE(cli.RAZAO,cli.FANTASIA) AS name,camp.NOME AS campaign,op.NOME AS operatorName FROM campanhas_clientes cc LEFT JOIN clientes cli ON cli.CODIGO=cc.CLIENTE LEFT JOIN campanhas camp ON camp.CODIGO=cc.CAMPANHA LEFT JOIN operadores op ON op.CODIGO=cc.OPERADOR WHERE " +
						conditions.map((condition) => `(${condition})`).join(" AND ") +
						` ORDER BY cc.DT_AGENDAMENTO ${direction.toUpperCase()},cc.CODIGO ASC LIMIT ? OFFSET ?`,
					[...values, limit, offset],
					{ timeoutMs: 10000 }
				);
				return rows.map((row) => ({
					id: Number(row.CODIGO),
					channel,
					scheduleAt: scheduleCivilDate(row.date).toISOString(),
					scheduledBy: personal ? row.OPERADOR_LIGACAO : row.OPERADOR,
					scheduledFor: personal ? row.OPERADOR : row.OPERADOR_LIGACAO,
					description: row.operatorName ? `Operador: ${row.operatorName}` : null,
					contactName: row.name,
					contactPhone: row.phone,
					customerId: row.CLIENTE,
					telephonyCampaignId: row.CAMPANHA,
					telephonyCampaignName: row.campaign
				}));
			}
		};
	}

	private async enrich(
		session: SessionData,
		rows: ScheduleRow[],
		financial: boolean,
		needProfiles: boolean,
		needRepurchase: boolean,
		warnings: Warning[],
		required: boolean,
		now: Date
	): Promise<Enrichment> {
		const ids = [...new Set(rows.flatMap((row) => (row.customerId ? [row.customerId] : [])))],
			enrichment: Enrichment = {
				customers: new Map(),
				profiles: new Map(),
				repurchases: new Map(),
				unavailable: false
			};
		if (!ids.length) return enrichment;
		const unavailable = () => {
			enrichment.unavailable = true;
			if (!warnings.some((warning) => warning.code === "ENRICHMENT_UNAVAILABLE"))
				warnings.push({
					code: "ENRICHMENT_UNAVAILABLE",
					message: "Alguns dados complementares estão indisponíveis. Tente atualizar a lista."
				});
		};
		try {
			const customers = await this.crm.executeQuery<CustomerRow[]>(
				session.instance,
				"SELECT c.CODIGO,c.RAZAO,c.FANTASIA,c.COD_CAMPANHA,c.ORIGEM,c.BLOCK_COMPRAS,camp.NOME AS CUSTOMER_CAMPAIGN_NAME,org.DESCRICAO AS CUSTOMER_ORIGIN_DESCRIPTION FROM clientes c LEFT JOIN campanhas camp ON camp.CODIGO=c.COD_CAMPANHA LEFT JOIN origens_sgr org ON org.CODIGO=c.ORIGEM WHERE c.CODIGO IN (?)",
				[ids],
				{ timeoutMs: 10000 }
			);
			enrichment.customers = new Map(customers.map((customer) => [Number(customer.CODIGO), customer]));
		} catch {
			if (required) throw new InternalServerError("Não foi possível aplicar os filtros no CRM. Tente novamente.");
			unavailable();
			return enrichment;
		}
		const visibleIds = financial
			? ids.filter((id) => {
					const customer = enrichment.customers.get(id);
					return Boolean(customer) && (session.role === "ADMIN" || customer?.BLOCK_COMPRAS !== "SIM");
				})
			: [];
		if (!visibleIds.length) return enrichment;
		if (needProfiles)
			try {
				const profiles = await this.profiles.getCustomerProfileSummariesReadOnly(
					session.instance,
					visibleIds,
					now
				);
				enrichment.profiles = new Map(profiles.map((profile) => [profile.customerId, profile]));
			} catch {
				if (required)
					throw new InternalServerError("Não foi possível aplicar os filtros de perfil. Tente novamente.");
				unavailable();
			}
		if (needRepurchase)
			try {
				enrichment.repurchases = await this.repurchase(session.instance, visibleIds, now);
			} catch {
				if (required)
					throw new InternalServerError("Não foi possível aplicar os filtros de recompra. Tente novamente.");
				unavailable();
			}
		return enrichment;
	}

	private matches(
		row: ScheduleRow,
		customer: CustomerRow | undefined,
		enrichment: Enrichment,
		filters: UnifiedScheduleFilters,
		financial: boolean,
		admin: boolean
	): boolean {
		const visible = Boolean(customer) && financial && (admin || customer?.BLOCK_COMPRAS !== "SIM"),
			profile = visible && row.customerId ? enrichment.profiles.get(row.customerId) : undefined,
			repurchase = visible && row.customerId ? enrichment.repurchases.get(row.customerId) : undefined;
		if (
			filters.customerCampaignIds &&
			!filters.customerCampaignIds.split(",").includes(String(customer?.COD_CAMPANHA))
		)
			return false;
		if (profileFields.some((field) => filters[field]) && !visible) return false;
		if (filters.profileLevel && profile?.profileLevel !== filters.profileLevel) return false;
		if (filters.interactionLevel && profile?.tags.interaction.tagValue !== filters.interactionLevel) return false;
		if (filters.purchaseLevel && profile?.tags.purchase.tagValue !== filters.purchaseLevel) return false;
		if (filters.ageLevel && profile?.tags.age.tagValue !== filters.ageLevel) return false;
		if (filters.purchaseInterestLevel && profile?.purchaseInterest.level !== filters.purchaseInterestLevel)
			return false;
		if (
			filters.repurchaseStatuses &&
			(!visible || !filters.repurchaseStatuses.split(",").includes(repurchase?.semaphoreStatus ?? "neutral"))
		)
			return false;
		if (filters.search) {
			const text = normalizeScheduleSearch(
				[
					row.contactName,
					row.contactPhone,
					row.description,
					customer?.RAZAO,
					customer?.FANTASIA,
					customer?.CUSTOMER_CAMPAIGN_NAME,
					customer?.CUSTOMER_ORIGIN_DESCRIPTION,
					row.telephonyCampaignName,
					profile?.label,
					profile?.purchaseInterest.label,
					profile?.tags.interaction.label,
					profile?.tags.purchase.label,
					profile?.tags.age.label
				]
					.filter(Boolean)
					.join(" ")
			);
			const search = normalizeScheduleSearch(filters.search),
				digits = filters.search.replace(/\D/g, "");
			const phoneSearch = digits.length >= 3 && /^[\s\d()+.\-/]+$/.test(filters.search);
			if (
				!text.includes(search) &&
				!(phoneSearch && (row.contactPhone ?? "").replace(/\D/g, "").includes(digits))
			)
				return false;
		}
		return true;
	}

	private async repurchase(
		instance: string,
		ids: number[],
		now: Date
	): Promise<Map<number, UnifiedScheduleRepurchaseMetrics>> {
		type PurchaseAggregate = { customerId: number; averageDays: number | string | null; lastAt: string | null };
		// MySQL 5.5-compatible aggregate: no per-customer HTTP calls or purchase histories in Node.
		const rows = await this.crm.executeQuery<PurchaseAggregate[]>(
			instance,
			"SELECT /*+ MAX_EXECUTION_TIME(5000) */ ordered.CLIENTE AS customerId,AVG(CASE WHEN ordered.previousAt IS NULL THEN NULL ELSE GREATEST(1,ROUND(TIMESTAMPDIFF(SECOND,ordered.previousAt,ordered.DATA)/86400)) END) AS averageDays,DATE_FORMAT(MAX(ordered.DATA),'%Y-%m-%d %H:%i:%s') AS lastAt FROM (SELECT p.CLIENTE,p.DATA,(SELECT previous.DATA FROM compras previous WHERE previous.CLIENTE=p.CLIENTE AND previous.DATA IS NOT NULL AND YEAR(previous.DATA)>=1000 AND (previous.DATA<p.DATA OR (previous.DATA=p.DATA AND previous.CODIGO<p.CODIGO)) ORDER BY previous.DATA DESC,previous.CODIGO DESC LIMIT 1) AS previousAt FROM compras p WHERE p.CLIENTE IN (?) AND p.DATA IS NOT NULL AND YEAR(p.DATA)>=1000) ordered GROUP BY ordered.CLIENTE",
			[ids],
			{ timeoutMs: 10000 }
		);
		const byId = new Map(rows.map((row) => [Number(row.customerId), row]));
		return new Map(
			ids.map((id) => {
				const row = byId.get(id),
					averageRepurchaseDays = row?.averageDays == null ? null : Number(row.averageDays),
					last = row?.lastAt ? scheduleCivilDate(row.lastAt) : null;
				const daysSinceLastPurchase = last
					? Math.max(0, Math.round((now.getTime() - last.getTime()) / 86400000))
					: null;
				const next =
					last && averageRepurchaseDays ? new Date(last.getTime() + averageRepurchaseDays * 86400000) : null;
				const proximityRatio =
					averageRepurchaseDays && daysSinceLastPurchase != null
						? daysSinceLastPurchase / averageRepurchaseDays
						: null;
				const semaphoreStatus: UnifiedScheduleRepurchaseStatus =
					proximityRatio == null
						? "neutral"
						: proximityRatio < 0.75
							? "red"
							: proximityRatio <= 1
								? "yellow"
								: "green";
				return [
					id,
					{
						averageRepurchaseDays,
						daysSinceLastPurchase,
						nextRepurchaseDate: next?.toISOString() ?? null,
						proximityRatio,
						semaphoreStatus,
						overdueDays: next ? Math.max(0, Math.round((now.getTime() - next.getTime()) / 86400000)) : null
					}
				];
			})
		);
	}

	private item(row: ScheduleRow, enrichment: Enrichment, financial: boolean, admin: boolean): UnifiedScheduleItem {
		const customer = row.customerId ? enrichment.customers.get(row.customerId) : undefined,
			visible = Boolean(customer) && financial && (admin || customer?.BLOCK_COMPRAS !== "SIM");
		return {
			id: `${row.channel}-${row.id}`,
			channel: row.channel,
			scheduleId: row.id,
			scheduleAt: row.scheduleAt,
			scheduledBy: row.scheduledBy,
			scheduledFor: row.scheduledFor,
			description: row.description,
			contactName: row.contactName,
			contactPhone: row.contactPhone,
			customerId: row.customerId,
			customerName: customer?.RAZAO ?? null,
			customerFantasyName: customer?.FANTASIA ?? null,
			customerCampaignId: customer?.COD_CAMPANHA ?? null,
			customerCampaignName: customer?.CUSTOMER_CAMPAIGN_NAME ?? null,
			customerOriginId: customer?.ORIGEM ?? null,
			customerOriginDescription: customer?.CUSTOMER_ORIGIN_DESCRIPTION ?? null,
			telephonyCampaignId: row.telephonyCampaignId,
			telephonyCampaignName: row.telephonyCampaignName,
			profileSummary: visible && row.customerId ? (enrichment.profiles.get(row.customerId) ?? null) : null,
			repurchase: visible && row.customerId ? (enrichment.repurchases.get(row.customerId) ?? null) : null,
			meta: {
				...(row.wppContactId !== undefined
					? { wppContactId: row.wppContactId, wppChatId: row.wppChatId ?? null }
					: {}),
				...(row.channel === "TELEFONIA" ? { telephonyRecordId: row.id } : {}),
				commercialRestricted: !visible,
				enrichmentUnavailable: enrichment.unavailable
			}
		};
	}

	private compare(a: ScheduleRow, b: ScheduleRow, direction: "asc" | "desc"): number {
		return (
			(Date.parse(a.scheduleAt) - Date.parse(b.scheduleAt)) * (direction === "asc" ? 1 : -1) ||
			a.channel.localeCompare(b.channel) ||
			a.id - b.id
		);
	}
	private async page(
		sources: Source[],
		eligible: Map<UnifiedScheduleChannel, number[]>,
		start: number,
		size: number,
		direction: "asc" | "desc"
	): Promise<ScheduleRow[]> {
		const active = sources.filter((source) => eligible.get(source.channel)?.length),
			read = (source: Source, offset: number, limit: number) =>
				source.read(offset, limit, eligible.get(source.channel));
		if (!active.length) return [];
		if (active.length === 1) return read(active[0]!, start, size);
		const [first, second] = active as [Source, Source],
			countA = eligible.get(first.channel)!.length,
			countB = eligible.get(second.channel)!.length;
		let low = Math.max(0, start - countB),
			high = Math.min(start, countA),
			firstOffset = low;
		while (low <= high) {
			const a = Math.floor((low + high) / 2),
				b = start - a,
				[aa, bb] = await Promise.all([read(first, Math.max(0, a - 1), 2), read(second, Math.max(0, b - 1), 2)]);
			const previousA = a > 0 ? aa[0] : undefined,
				nextA = aa[a > 0 ? 1 : 0],
				previousB = b > 0 ? bb[0] : undefined,
				nextB = bb[b > 0 ? 1 : 0];
			if (previousA && nextB && this.compare(previousA, nextB, direction) > 0) high = a - 1;
			else if (previousB && nextA && this.compare(previousB, nextA, direction) > 0) low = a + 1;
			else {
				firstOffset = a;
				break;
			}
			firstOffset = low;
		}
		return (await Promise.all([read(first, firstOffset, size), read(second, start - firstOffset, size)]))
			.flat()
			.sort((a, b) => this.compare(a, b, direction))
			.slice(0, size);
	}
}

export default new UnifiedSchedulesService();
