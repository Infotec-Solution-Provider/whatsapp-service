import { BaseStep, StepConfig, StepContext, StepResult } from "./base.step";
import instancesService from "../../services/instances.service";
import { resolveContactCustomerForFlow } from "../../services/contact-customer-resolution.runtime";
import type { CustomerResolutionScope, ContactCustomerResolutionResult } from "../../services/contact-customer-resolution.service";
import type { WppContact } from "@prisma/client";

interface QueryConfig {
	query: string; // SQL query
	params?: any[]; // Parâmetros (suporta interpolação com ${...})
	storeAs: string; // Nome da variável para armazenar resultado
	single?: boolean; // Se true, retorna apenas primeiro resultado
	required?: boolean; // Se true e nenhum resultado, vai para fallback
}

/**
 * Step genérico para executar queries SQL e armazenar resultados no contexto.
 * Suporta interpolação de variáveis nos parâmetros.
 */
export class QueryStep extends BaseStep {
	constructor(config: StepConfig, private readonly resolveCustomer: (scope: CustomerResolutionScope, contact: WppContact) => Promise<ContactCustomerResolutionResult> = resolveContactCustomerForFlow) {
		super(config);
	}

	async execute(context: StepContext): Promise<StepResult> {
		if (this.config["operation"] !== undefined) {
			if (this.config["operation"] !== "resolveContactCustomer") throw new Error("UNKNOWN_QUERY_OPERATION");
			const storeAs = this.config["storeAs"];
			const reserved = new Set(["__proto__", "prototype", "constructor", "contact", "message", "logger", "instance", "sectorId", "customer", "legacyCampaignType", "legacySchedule"]);
			if (typeof storeAs !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(storeAs) || reserved.has(storeAs) || Object.prototype.hasOwnProperty.call(context, storeAs)) throw new Error("INVALID_CUSTOMER_RESOLUTION_STORE_AS");
			if (context.message.instance !== this.instance || (context.instance !== undefined && context.instance !== this.instance) || (context.sectorId !== undefined && context.sectorId !== this.sectorId)) throw new Error("CUSTOMER_RESOLUTION_SCOPE_MISMATCH");
			const started = Date.now();
			const result = await this.resolveCustomer({ instance: this.instance, sectorId: this.sectorId }, context.contact);
			if (result.contact.id !== context.contact.id || result.contact.instance !== this.instance) throw new Error("CUSTOMER_RESOLUTION_SCOPE_MISMATCH");
			// The caller also uses this object for bot/AI handling of the first message.
			Object.assign(context.contact, result.contact);
			context[storeAs] = result.resolution;
			context.logger.log("[customer-resolution]", { instance: this.instance, sectorId: this.sectorId, contactId: context.contact.id, status: result.resolution.status, reason: result.resolution.reason, durationMs: Date.now() - started });
			return this.continue(context);
		}
		const config = this.config as QueryConfig;

		const querySummary = config.query.length > 60 
			? config.query.substring(0, 60) + '...' 
			: config.query;
		
		context.logger.log(`  Query: ${querySummary}`, {
			storeAs: config.storeAs,
			single: config.single || false,
			required: config.required || false,
			hasParams: (config.params?.length || 0) > 0
		});

		const params = config.params ? this.resolveParams(context, config.params) : [];

		if (params.length > 0) {
			context.logger.log(`  Params: ${JSON.stringify(params)}`);
		}

		const results = (await instancesService.executeQuery(
			this.instance,
			config.query,
			params
		)) as any[];

		context.logger.log(`  Resultados: ${results.length} linha(s) retornada(s)`);

		if (config.required && results.length === 0) {
			context.logger.log(`  ⚠ Query obrigatória não retornou dados → fallback`);

			if (this.fallbackStepNumber) {
				return this.continue(context, this.fallbackStepNumber);
			}

			throw new Error(`Query required but returned no results: ${config.query}`);
		}

		// Armazena resultado no contexto
		const value = config.single ? results[0] : results;
		context[config.storeAs] = value;

		context.logger.log(`  ✓ Armazenado: context.${config.storeAs} ${config.single ? '(single)' : `(array[${results.length}])`}`);

		return this.continue(context);
	}
}
