import { distributionReads, FlowDistributionReads } from "../distribution-reads";
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

interface CheckUserOnlineConnections {
	onTrue?: number;  // Step se o usuário estiver ONLINE
	onFalse?: number; // Step se o usuário estiver OFFLINE
}

export function onlineOperatorSource(config: Record<string, unknown>): string | number {
	// Previously only the field affected execution, even when a legacy config carried other keys.
	const field = config["userIdField"];
	if (typeof field === "string" && field.trim()) return field;
	const id = config["userId"];
	if (typeof id === "number" && Number.isInteger(id) && id > 0 && id <= 2147483647) return id;
	throw new Error("Selecione um operador do setor ou informe o campo do fluxo que contém o código do operador.");
}

export default class CheckUserOnlineStep extends BaseStep {
	constructor(config: StepConfig, private readonly reads: FlowDistributionReads = distributionReads) {
		super(config);
	}

	/**
	 * Verifica se um usuário específico está online.
	 */
	private async isUserOnline(userId: number, requireSameSector: boolean): Promise<boolean> {
		const sessions = await this.reads.sessions(this.instance);
		if (!sessions.some(session => session.data.userId === userId && session.onlineTokens.length > 0 &&
			(!requireSameSector || session.data.sectorId === this.sectorId))) return false;
		return (await this.reads.eligible(this.instance, [userId])).has(userId);
	}

	/**
	 * Executa o passo.
	 */
	public async execute(ctx: StepContext): Promise<StepResult> {
		const source = onlineOperatorSource(this.config);
		const userId = typeof source === "number" ? source : this.resolveField(ctx, source);
		const connections = this.connections as CheckUserOnlineConnections;

		if (!userId || typeof userId !== "number") {
			ctx.logger.log("⚠️ Aviso: userId não encontrado ou inválido no contexto → Step #" + connections.onFalse, {
				source,
				userId,
				hasUserId: !!userId,
				type: typeof userId
			});
			return this.continue(ctx, connections.onFalse, "Usuário ausente ou inválido no contexto.");
		}

		ctx.logger.log(`Verificando se usuário #${userId} está online...`, {
			userId,
			source,
			instance: this.instance
		});

		const isOnline = await this.isUserOnline(userId, typeof source === "number");

		if (isOnline) {
			ctx.logger.log(`✓ Usuário #${userId} está ONLINE → Step #${connections.onTrue}`, { userId });
			return this.continue(ctx, connections.onTrue, "Usuário online e elegível.");
		}

		ctx.logger.log(`✗ Usuário #${userId} está OFFLINE → Step #${connections.onFalse}`, { userId });
		return this.continue(ctx, connections.onFalse, "Usuário offline ou indisponível.");
	}
}
