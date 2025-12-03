import parametersService from "./parameters.service";
import prismaService from "./prisma.service";
import { HumanBehaviorConfig, DEFAULT_HUMAN_BEHAVIOR_CONFIG } from "../utils/human-behavior.simulator";
import { Logger } from "@in.pulse-crm/utils";

/**
 * Serviço para gerenciar configurações de comportamento humano via parâmetros
 */
class HumanBehaviorConfigService {
	private configCache = new Map<string, HumanBehaviorConfig>();

	/**
	 * Carrega a configuração de comportamento humano para uma instância
	 * @param instance - Nome da instância
	 * @returns Configuração do comportamento humano
	 */
	public async loadConfig(instance: string): Promise<HumanBehaviorConfig> {
		try {
			const params = await parametersService.getInstanceParams(instance);
			const paramMap = Object.fromEntries(params.map((p) => [p.key, p.value]));

			const config: HumanBehaviorConfig = {
				enabled: this.parseBoolean(paramMap["human_behavior.enabled"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.enabled),
				readingSpeed: {
					min: this.parseNumber(paramMap["human_behavior.reading_speed.min"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.readingSpeed.min),
					max: this.parseNumber(paramMap["human_behavior.reading_speed.max"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.readingSpeed.max)
				},
				thinkingTime: {
					min: this.parseNumber(paramMap["human_behavior.thinking_time.min"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.thinkingTime.min),
					max: this.parseNumber(paramMap["human_behavior.thinking_time.max"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.thinkingTime.max)
				},
				typingSpeed: {
					min: this.parseNumber(paramMap["human_behavior.typing_speed.min"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.typingSpeed.min),
					max: this.parseNumber(paramMap["human_behavior.typing_speed.max"], DEFAULT_HUMAN_BEHAVIOR_CONFIG.typingSpeed.max)
				},
				sendTypingState: this.parseBoolean(
					paramMap["human_behavior.send_typing_state"],
					DEFAULT_HUMAN_BEHAVIOR_CONFIG.sendTypingState
				),
				typingStateDuration: {
					min: this.parseNumber(
						paramMap["human_behavior.typing_state_duration.min"],
						DEFAULT_HUMAN_BEHAVIOR_CONFIG.typingStateDuration.min
					),
					max: this.parseNumber(
						paramMap["human_behavior.typing_state_duration.max"],
						DEFAULT_HUMAN_BEHAVIOR_CONFIG.typingStateDuration.max
					)
				}
			};

			// Valida configuração
			this.validateConfig(config);

			// Armazena no cache
			this.configCache.set(instance, config);

			Logger.info(
				`[HumanBehaviorConfig] Configuração carregada para instância ${instance}: ` +
				`enabled=${config.enabled}, readingSpeed=${config.readingSpeed.min}-${config.readingSpeed.max}wpm, ` +
				`thinkingTime=${config.thinkingTime.min}-${config.thinkingTime.max}ms, ` +
				`typingSpeed=${config.typingSpeed.min}-${config.typingSpeed.max}wpm, ` +
				`sendTypingState=${config.sendTypingState}`
			);

			return config;
		} catch (err) {
			Logger.error(
				`[HumanBehaviorConfig] Erro ao carregar configuração para ${instance}, usando padrão: ${err instanceof Error ? err.message : String(err)}`
			);
			return DEFAULT_HUMAN_BEHAVIOR_CONFIG;
		}
	}

	/**
	 * Obtém a configuração do cache ou carrega do banco
	 */
	public async getConfig(instance: string): Promise<HumanBehaviorConfig> {
		const cached = this.configCache.get(instance);
		if (cached) {
			return cached;
		}
		return this.loadConfig(instance);
	}

	/**
	 * Invalida o cache de uma instância (força recarregamento)
	 */
	public invalidateCache(instance: string): void {
		this.configCache.delete(instance);
		Logger.debug(`[HumanBehaviorConfig] Cache invalidado para instância ${instance}`);
	}

	/**
	 * Invalida todo o cache
	 */
	public invalidateAllCache(): void {
		this.configCache.clear();
		Logger.debug(`[HumanBehaviorConfig] Todo o cache foi invalidado`);
	}

	/**
	 * Parse seguro de booleano
	 */
	private parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
		if (value === undefined) return defaultValue;
		return value === "true" || value === "1" || value === "yes";
	}

	/**
	 * Parse seguro de número
	 */
	private parseNumber(value: string | undefined, defaultValue: number): number {
		if (value === undefined) return defaultValue;
		const parsed = parseInt(value, 10);
		return isNaN(parsed) ? defaultValue : parsed;
	}

	/**
	 * Valida a configuração carregada
	 */
	private validateConfig(config: HumanBehaviorConfig): void {
		// Valida ranges
		if (config.readingSpeed.min > config.readingSpeed.max) {
			throw new Error("reading_speed.min não pode ser maior que reading_speed.max");
		}
		if (config.thinkingTime.min > config.thinkingTime.max) {
			throw new Error("thinking_time.min não pode ser maior que thinking_time.max");
		}
		if (config.typingSpeed.min > config.typingSpeed.max) {
			throw new Error("typing_speed.min não pode ser maior que typing_speed.max");
		}
		if (config.typingStateDuration.min > config.typingStateDuration.max) {
			throw new Error("typing_state_duration.min não pode ser maior que typing_state_duration.max");
		}

		// Valida valores mínimos
		if (config.readingSpeed.min < 0 || config.readingSpeed.max < 0) {
			throw new Error("reading_speed deve ser >= 0");
		}
		if (config.thinkingTime.min < 0 || config.thinkingTime.max < 0) {
			throw new Error("thinking_time deve ser >= 0");
		}
		if (config.typingSpeed.min < 0 || config.typingSpeed.max < 0) {
			throw new Error("typing_speed deve ser >= 0");
		}
		if (config.typingStateDuration.min < 0 || config.typingStateDuration.max < 0) {
			throw new Error("typing_state_duration deve ser >= 0");
		}
	}

	/**
	 * Cria parâmetros padrão para uma instância no banco de dados
	 */
	public async createDefaultParameters(instance: string): Promise<void> {
		const defaultParams = [
			{ key: "human_behavior.enabled", value: "true" },
			{ key: "human_behavior.reading_speed.min", value: "200" },
			{ key: "human_behavior.reading_speed.max", value: "250" },
			{ key: "human_behavior.thinking_time.min", value: "2000" },
			{ key: "human_behavior.thinking_time.max", value: "8000" },
			{ key: "human_behavior.typing_speed.min", value: "40" },
			{ key: "human_behavior.typing_speed.max", value: "60" },
			{ key: "human_behavior.send_typing_state", value: "true" },
			{ key: "human_behavior.typing_state_duration.min", value: "1000" },
			{ key: "human_behavior.typing_state_duration.max", value: "3000" }
		];

		for (const param of defaultParams) {
			await prismaService.parameter.upsert({
				where: {
					scope_instance_sectorId_userId_key: {
						scope: "INSTANCE",
						instance,
						sectorId: null as any,
						userId: null as any,
						key: param.key
					}
				},
				create: {
					scope: "INSTANCE",
					instance,
					key: param.key,
					value: param.value
				},
				update: {
					value: param.value
				}
			});
		}

		Logger.info(`[HumanBehaviorConfig] Parâmetros padrão criados para instância ${instance}`);
		this.invalidateCache(instance);
	}
}

export default new HumanBehaviorConfigService();
