import { WppChatPriority } from "@prisma/client";
import { BaseStep, ChatPayload, StepConfig, StepContext, StepResult } from "./base.step";
import { distributionReads, FlowDistributionReads } from "../distribution-reads";
import { resolveAssignmentTarget } from "../assignment-target";
import { OperatorPauseAdmissionError } from "../../services/operator-pause-admission";

interface AssignConfig {
	userId?: number | string; // ID do usuário (ou -1 para admin) ou campo para resolver
	walletId?: number | string; // ID da carteira ou campo para resolver
	priority?: WppChatPriority; // Prioridade do chat
	systemMessage?: string; // Mensagem do sistema
	type?: "RECEPTIVE" | "ACTIVE"; // Tipo do chat
	validateUser?: boolean;
	fallbackUserId?: number;
	fallbackRequireAdmin?: boolean;
	decisionReason?: string;
}

/**
 * Step genérico para atribuir um chat a um usuário, carteira ou admin.
 * Suporta interpolação de variáveis (ex: userId: "${context.assignedUserId}")
 */
export class AssignStep extends BaseStep {
	constructor(config: StepConfig, private readonly reads: FlowDistributionReads = distributionReads) { super(config); }

	async execute(context: StepContext): Promise<StepResult> {
		const config = this.config as AssignConfig;

		// Permite interpolação de variáveis
		let userId =
			typeof config.userId === "string" && config.userId.startsWith("${")
				? this.resolveField(context, config.userId.slice(2, -1))
				: config.userId;
		let reason = "Destino definido na configuração da etapa.";
		if (config.validateUser === true) {
			const result = await resolveAssignmentTarget({
				userId: userId as number, fallbackUserId: config.fallbackUserId!,
				...(config.fallbackRequireAdmin !== undefined ? { fallbackRequireAdmin: config.fallbackRequireAdmin } : {})
			}, this.sectorId, async (ids) => {
				const rows = await this.reads.operators(this.instance, ids);
				const eligible = await this.reads.eligible(this.instance, ids);
				if (!eligible.size) throw new OperatorPauseAdmissionError("OPERATOR_PAUSED");
				return rows.filter(row => eligible.has(row.CODIGO));
			});
			userId = result.userId;
			reason = { target_valid: "Operador principal validado.", target_invalid_fallback: "Operador principal indisponível. Usou o substituto.", validation_unavailable: "Validação temporariamente indisponível. O fluxo conserva o destino principal." }[result.reason];
			context.logger.log("Assignment target validation", { reason: result.reason, userId, sectorId: this.sectorId });
		}

		const walletId =
			typeof config.walletId === "string" && config.walletId.startsWith("${")
				? this.resolveField(context, config.walletId.slice(2, -1))
				: config.walletId;

		const assignmentType = userId 
			? (userId === -1 ? 'ADMIN' : `USER #${userId}`)
			: walletId 
				? `WALLET #${walletId}`
				: 'DEFAULT';

		context.logger.log(`  Atribuindo: ${assignmentType}`, {
			type: config.type || 'RECEPTIVE',
			priority: config.priority || 'NORMAL',
			hasSystemMessage: !!config.systemMessage,
			...(config.decisionReason ? { reason: config.decisionReason } : {})
		});

		const chatData: ChatPayload = {
			instance: this.instance,
			type: config.type || "RECEPTIVE",
			sectorId: this.sectorId,
			contactId: context.contact.id,
			userId: (userId as number) ?? (walletId == null ? -1 : null),
			walletId: (walletId as number) ?? null
		};

		if (config.systemMessage) {
			const interpolated = this.interpolateString(context, config.systemMessage);
			chatData.systemMessage = interpolated;
			if (interpolated !== config.systemMessage) {
				context.logger.log(`  Mensagem interpolada: "${config.systemMessage}" → "${interpolated}"`);
			}
		}
		if (config.priority) {
			chatData.priority = config.priority;
		}

		return this.finalize(chatData, reason);
	}
}
