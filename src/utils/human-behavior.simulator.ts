import { Logger } from "@in.pulse-crm/utils";

export interface HumanBehaviorConfig {
	enabled: boolean; // Ativa/desativa simulação de comportamento humano
	readingSpeed: { min: number; max: number }; // Palavras por minuto
	thinkingTime: { min: number; max: number }; // Milissegundos
	typingSpeed: { min: number; max: number }; // Palavras por minuto
	sendTypingState: boolean; // Envia estado "digitando..."
	typingStateDuration: { min: number; max: number }; // Duração do typing em ms
}

/**
 * Configuração padrão do comportamento humano
 */
export const DEFAULT_HUMAN_BEHAVIOR_CONFIG: HumanBehaviorConfig = {
	enabled: true,
	readingSpeed: { min: 300, max: 400 },
	thinkingTime: { min: 500, max: 1000 },
	typingSpeed: { min: 200, max: 300 },
	sendTypingState: true,
	typingStateDuration: { min: 1000, max: 3000 }
};

/**
 * Simula comportamento humano para evitar detecção de automação
 */
export class HumanBehaviorSimulator {
	/**
	 * Simula o tempo de leitura de uma mensagem recebida
	 * @param messageLength - Tamanho da mensagem em caracteres
	 * @param config - Configuração do comportamento
	 * @returns Tempo em milissegundos
	 */
	public static calculateReadingTime(
		messageLength: number,
		config: HumanBehaviorConfig = DEFAULT_HUMAN_BEHAVIOR_CONFIG
	): number {
		if (!config.enabled) return 0;

		// Velocidade de leitura configurável
		const wordsPerMinute =
			config.readingSpeed.min + Math.random() * (config.readingSpeed.max - config.readingSpeed.min);
		const charsPerMinute = wordsPerMinute * 5;
		const baseTime = (messageLength / charsPerMinute) * 60 * 1000;

		// Adiciona variação humana (±30%)
		const variation = baseTime * (0.7 + Math.random() * 0.6);

		// Mínimo de 1 segundo, máximo de 10 segundos
		return Math.min(Math.max(variation, 1000), 10000);
	}

	/**
	 * Simula o tempo de pensamento antes de responder
	 * @param config - Configuração do comportamento
	 * @returns Tempo em milissegundos
	 */
	public static calculateThinkingTime(config: HumanBehaviorConfig = DEFAULT_HUMAN_BEHAVIOR_CONFIG): number {
		if (!config.enabled) return 0;

		// Tempo de pensamento configurável
		const baseTime = config.thinkingTime.min + Math.random() * (config.thinkingTime.max - config.thinkingTime.min);

		// Adiciona pequenos picos aleatórios (às vezes as pessoas demoram mais)
		const shouldDelay = Math.random() > 0.8;
		const extraDelay = shouldDelay ? Math.random() * 5000 : 0;

		return baseTime + extraDelay;
	}

	/**
	 * Simula o tempo de digitação baseado no tamanho do texto
	 * @param textLength - Tamanho do texto em caracteres
	 * @param config - Configuração do comportamento
	 * @returns Tempo em milissegundos
	 */
	public static calculateTypingTime(
		textLength: number,
		config: HumanBehaviorConfig = DEFAULT_HUMAN_BEHAVIOR_CONFIG
	): number {
		if (!config.enabled) return 0;

		// Velocidade de digitação configurável
		const wordsPerMinute =
			config.typingSpeed.min + Math.random() * (config.typingSpeed.max - config.typingSpeed.min);
		const charsPerMinute = wordsPerMinute * 5;
		const baseTime = (textLength / charsPerMinute) * 60 * 1000;

		// Adiciona variação humana e pausas ocasionais
		const variation = baseTime * (0.8 + Math.random() * 0.4);

		// Adiciona pausas aleatórias (correções, pausas para pensar)
		const pauseProbability = textLength / 100; // Mais pausas em textos longos
		const pauseCount = Math.floor(Math.random() * pauseProbability);
		const pauseTime = pauseCount * (500 + Math.random() * 1500);

		return Math.min(Math.max(variation + pauseTime, 1000), 5000);
	}

	/**
	 * Aguarda um tempo específico
	 * @param ms - Milissegundos para aguardar
	 */
	public static async sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Simula o fluxo completo de comportamento humano antes de enviar uma mensagem
	 * @param receivedMessageLength - Tamanho da mensagem recebida (se houver)
	 * @param messageToSend - Mensagem que será enviada
	 * @param instance - Instância para logging
	 * @param config - Configuração do comportamento
	 */
	public static async simulateHumanDelay(
		receivedMessageLength: number | null,
		messageToSend: string,
		instance: string,
		config: HumanBehaviorConfig = DEFAULT_HUMAN_BEHAVIOR_CONFIG
	): Promise<void> {
		if (!config.enabled) {
			Logger.debug(`[${instance}] Comportamento humano desabilitado`);
			return;
		}

		// 1. Se recebeu uma mensagem, simula leitura
		if (receivedMessageLength !== null && receivedMessageLength > 0) {
			const readingTime = this.calculateReadingTime(receivedMessageLength, config);
			Logger.debug(`[${instance}] Simulando leitura: ${Math.round(readingTime / 1000)}s`);
			await this.sleep(readingTime);
		}

		// 2. Simula tempo de pensamento
		const thinkingTime = this.calculateThinkingTime(config);
		Logger.debug(`[${instance}] Simulando pensamento: ${Math.round(thinkingTime / 1000)}s`);
		await this.sleep(thinkingTime);

		// 3. Simula tempo de digitação
		const typingTime = this.calculateTypingTime(messageToSend.length, config);
		Logger.debug(`[${instance}] Simulando digitação: ${Math.round(typingTime / 1000)}s`);
		await this.sleep(typingTime);
	}

	/**
	 * Adiciona delay aleatório entre ações
	 * @param minMs - Tempo mínimo em ms
	 * @param maxMs - Tempo máximo em ms
	 */
	public static async randomDelay(minMs: number = 500, maxMs: number = 2000): Promise<void> {
		const delay = minMs + Math.random() * (maxMs - minMs);
		await this.sleep(delay);
	}
}

export default HumanBehaviorSimulator;
