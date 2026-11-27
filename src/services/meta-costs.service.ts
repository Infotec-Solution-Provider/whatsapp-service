import { randomUUID } from "node:crypto";
import type { SessionData } from "../sdk-local/types/auth.types";
import ProcessingLogger from "../utils/processing-logger";
import instances from "./instances.service";
import {
	MetaCostReceiptLimitError, MetaCostReceiptRepository, type MetaCostReceiptChannel, type MetaCostReceiptReport
} from "./meta-cost-receipts";
import { META_COST_TIME_ZONE, parseMetaCostPeriod, summarizeMetaReceiptCosts } from "./meta-costs.calculation";
import { MetaGraphError } from "./meta-management.graph";
import management from "./meta-management.service";
import database, { type DatabaseClient } from "./prisma.service";

type Period = ReturnType<typeof parseMetaCostPeriod>;

interface Operator {
	CODIGO: number;
	NOME: string;
	ATIVO: string | null;
}

const emptyReceipts: MetaCostReceiptReport = { buckets: [], confirmed: 0, unattributed: 0, missingPricing: 0 };
const receiptsTtlMs = 60_000;
const receiptCacheKeys = 64;

export class MetaCostsService {
	private readonly receiptCache = new Map<string, { expiresAt: number; report: Promise<MetaCostReceiptReport> }>();

	constructor(
		private readonly db: Pick<DatabaseClient, "metaOperatorBudget" | "$executeRawUnsafe"> = database,
		private readonly crm: Pick<typeof instances, "executeQuery"> = instances,
		private readonly receipts: Pick<MetaCostReceiptRepository, "listMonthly"> = new MetaCostReceiptRepository(),
		private readonly meta: Pick<typeof management, "listCostReceiptChannels" | "getChannelPricing"> = management
	) {}

	private getReceipts(instance: string, channels: readonly MetaCostReceiptChannel[], period: Period) {
		if (!channels.length || period.end <= period.start) return Promise.resolve(emptyReceipts);
		const key = JSON.stringify([instance, period.month, channels]);
		const current = this.receiptCache.get(key);
		if (current && current.expiresAt > Date.now()) return current.report;
		for (const [cachedKey, value] of this.receiptCache) {
			if (value.expiresAt <= Date.now()) this.receiptCache.delete(cachedKey);
		}
		if (this.receiptCache.size >= receiptCacheKeys) {
			throw new MetaGraphError(503, "META_COST_REPORT_BUSY", "O levantamento de custos está ocupado. Tente novamente em instantes.");
		}
		const report = this.receipts.listMonthly(instance, channels, period);
		const entry = { expiresAt: Number.POSITIVE_INFINITY, report };
		this.receiptCache.set(key, entry);
		void report.then(
			() => { entry.expiresAt = Date.now() + receiptsTtlMs; },
			() => { this.receiptCache.delete(key); }
		);
		return report;
	}

	private async receiptEstimate(instance: string, period: Period) {
		let channelCount = 0;
		try {
			const channels = await this.meta.listCostReceiptChannels(instance);
			channelCount = channels.length;
			const receiptReport = await this.getReceipts(instance, channels, period);
			const { estimate, operatorSpend } = summarizeMetaReceiptCosts(receiptReport, period.month, channelCount);
			return { estimate: { ...estimate, status: "available" as const, reason: null }, operatorSpend };
		} catch (error) {
			const reason = error instanceof MetaCostReceiptLimitError
				? "O mês excede o volume disponível para estimativa pelos recibos."
				: "Os recibos estão temporariamente indisponíveis para este mês.";
			const log = new ProcessingLogger(instance, "meta-cost-receipts", randomUUID(), { month: period.month });
			log.failed({ code: error instanceof MetaCostReceiptLimitError ? error.code : "META_COST_RECEIPTS_UNAVAILABLE" });
			const { estimate, operatorSpend } = summarizeMetaReceiptCosts(emptyReceipts, period.month, channelCount);
			return { estimate: { ...estimate, status: "unavailable" as const, reason }, operatorSpend };
		}
	}

	public async getCosts(instance: string, period: Period) {
		const [{ estimate, operatorSpend }, budgets, active] = await Promise.all([
			this.receiptEstimate(instance, period),
			this.db.metaOperatorBudget.findMany({
				where: { instance, month: period.month }, select: { operatorId: true, budgetCents: true }
			}),
			this.crm.executeQuery<Operator[]>(instance, "SELECT CODIGO, NOME, ATIVO FROM operadores WHERE ATIVO='SIM'", [])
		]);
		const operators = new Map(active.map(operator => [Number(operator.CODIGO), operator]));
		const budgetByOperator = new Map(budgets.map(budget => [budget.operatorId, budget.budgetCents]));
		const historical = [...new Set([...budgetByOperator.keys(), ...operatorSpend.keys()])].filter(id => !operators.has(id));
		for (let offset = 0; offset < historical.length; offset += 200) {
			const ids = historical.slice(offset, offset + 200);
			const rows = await this.crm.executeQuery<Operator[]>(
				instance, `SELECT CODIGO, NOME, ATIVO FROM operadores WHERE CODIGO IN (${ids.map(() => "?").join(", ")})`, ids
			);
			for (const row of rows) operators.set(Number(row.CODIGO), row);
		}
		const ids = new Set([...operators.keys(), ...historical]);
		return {
			month: period.month, timeZone: META_COST_TIME_ZONE, estimate,
			operators: [...ids].map(operatorId => {
				const operator = operators.get(operatorId);
				return {
					operatorId, name: operator?.NOME?.trim() || `Operador #${operatorId}`, active: operator?.ATIVO === "SIM",
					budgetCents: budgetByOperator.get(operatorId) ?? null, spentCents: 0, paidMessages: 0, unpricedMessages: 0,
					...operatorSpend.get(operatorId)
				};
			}).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "pt-BR") || a.operatorId - b.operatorId)
		};
	}

	public async getOfficialCosts(instance: string, clientId: number, period: Period) {
		const response = { month: period.month, timeZone: META_COST_TIME_ZONE };
		if (period.end <= period.start || period.start.getTime() < Date.now() - 365 * 24 * 60 * 60 * 1000) {
			return { ...response, report: null };
		}
		try {
			return { ...response, report: await this.meta.getChannelPricing(instance, clientId, period) };
		} catch (error) {
			if (!(error instanceof MetaGraphError) || ["META_CHANNEL_NOT_FOUND", "META_ASSET_MISMATCH"].includes(error.code)) throw error;
			return { ...response, report: null };
		}
	}

	public async setBudget(session: SessionData, month: string, operatorId: number, budgetCents: number | null) {
		const { instance, userId } = session;
		if (budgetCents === null) {
			await this.db.metaOperatorBudget.deleteMany({ where: { instance, month, operatorId } });
		} else {
			const [operator] = await this.crm.executeQuery<Array<{ CODIGO: number }>>(
				instance, "SELECT CODIGO FROM operadores WHERE CODIGO=? AND ATIVO='SIM' LIMIT 1", [operatorId]
			);
			if (!operator) {
				throw new MetaGraphError(404, "META_COST_OPERATOR_NOT_FOUND", "Selecione um operador ativo desta empresa.");
			}

			await this.db.$executeRawUnsafe(
				`INSERT INTO meta_operator_budgets (instance, month, operator_id, budget_cents, updated_by, updated_at)
				 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
				 ON DUPLICATE KEY UPDATE budget_cents=?, updated_by=?, updated_at=UTC_TIMESTAMP()`,
				instance, month, operatorId, budgetCents, userId, budgetCents, userId
			);
		}
		new ProcessingLogger(instance, "meta-operator-budget", randomUUID(), { month, operatorId, actorUserId: userId })
			.success({ budgetCents });
		return { budgetCents };
	}
}

export default new MetaCostsService();
