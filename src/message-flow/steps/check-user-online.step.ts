import authService from "../../services/auth.service";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

interface CheckUserOnlineConnections {
	onTrue?: number;  // Step se o usuário estiver ONLINE
	onFalse?: number; // Step se o usuário estiver OFFLINE
}

/**
 * Step que verifica se um usuário específico está online.
 * 
 * Configuração esperada:
 * - userIdField (string): Nome do campo no contexto onde o userId está armazenado
 *   Ex: "customer.userId", "contact.operatorId", etc (obrigatório)
 * 
 * Comportamento:
 * - Busca o userId do contexto usando o campo especificado
 * - Se o usuário está online: continua para o próximo step
 * - Se o usuário NÃO está online: continua normalmente (pode usar fallback se necessário)
 * 
 * Pode ser usado em fluxos que precisam garantir que um usuário específico
 * está disponível antes de atribuir um chat para ele.
 */
export default class CheckUserOnlineStep extends BaseStep {
	constructor(config: StepConfig) {
		super(config);
	}

	/**
	 * Verifica se um usuário específico está online.
	 */
	private async isUserOnline(userId: number): Promise<boolean> {
		const sessions = await authService.getOnlineSessions(this.instance);
		return sessions.some((session) => session.data.userId === userId && session.onlineTokens.length > 0);
	}

	/**
	 * Executa o passo.
	 */
	public async execute(ctx: StepContext): Promise<StepResult> {
		const userIdField = this.config['userIdField'];

		if (!userIdField || typeof userIdField !== "string") {
			ctx.logger.log("❌ Erro: userIdField não configurado ou inválido", {
				userIdField,
				hasField: !!userIdField,
				type: typeof userIdField
			});
			throw new Error("CheckUserOnlineStep requer 'userIdField' na configuração");
		}

		// Resolve o userId do contexto usando dot notation
		const userId = this.resolveField(ctx, userIdField);

		if (!userId || typeof userId !== "number") {
			ctx.logger.log("⚠️ Aviso: userId não encontrado ou inválido no contexto", {
				userIdField,
				userId,
				hasUserId: !!userId,
				type: typeof userId
			});
			return this.continue(ctx);
		}

		ctx.logger.log(`Verificando se usuário #${userId} está online...`, {
			userId,
			userIdField,
			instance: this.instance
		});

		const connections = this.connections as CheckUserOnlineConnections;
		const isOnline = await this.isUserOnline(userId);

		if (isOnline) {
			ctx.logger.log(`✓ Usuário #${userId} está ONLINE → Step #${connections.onTrue}`, { userId });
			return this.continue(ctx, connections.onTrue);
		}

		ctx.logger.log(`✗ Usuário #${userId} está OFFLINE → Step #${connections.onFalse}`, { userId });
		return this.continue(ctx, connections.onFalse);
	}
}
