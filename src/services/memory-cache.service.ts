/**
 * In-Memory Cache Service
 * Alternativa ao Redis para ambientes que não suportam Redis
 */
interface CacheItem {
	value: any;
	expiresAt?: number;
}

class MemoryCacheService {
	private cache: Map<string, CacheItem> = new Map();
	private cleanupInterval: NodeJS.Timeout | null = null;

	constructor() {
		this.startCleanupRoutine();
	}

	/**
	 * Inicia rotina de limpeza de chaves expiradas a cada 60 segundos
	 */
	private startCleanupRoutine() {
		this.cleanupInterval = setInterval(() => {
			const now = Date.now();
			let cleanedCount = 0;

			for (const [key, { expiresAt }] of this.cache.entries()) {
				if (expiresAt && expiresAt < now) {
					this.cache.delete(key);
					cleanedCount++;
				}
			}

			if (cleanedCount > 0) {
				console.log(`♻️ Memory cache cleanup: removed ${cleanedCount} expired keys`);
			}
		}, 60000);
	}

	/**
	 * Verifica se o cache está pronto (sempre true)
	 */
	public isReady(): boolean {
		return true;
	}

	/**
	 * Armazena um valor no cache com expiração opcional
	 */
	public async set(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
		try {
			const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
			const cacheabeValue: CacheItem = { value };
			if (expiresAt) {
				cacheabeValue.expiresAt = expiresAt;
			}
			this.cache.set(key, cacheabeValue);
			return true;
		} catch (error) {
			console.error("Memory cache SET error:", error);
			return false;
		}
	}

	/**
	 * Busca um valor do cache
	 */
	public async get<T>(key: string): Promise<T | null> {
		try {
			const item = this.cache.get(key);

			if (!item) {
				return null;
			}

			// Verifica expiração
			if (item.expiresAt && item.expiresAt < Date.now()) {
				this.cache.delete(key);
				return null;
			}

			return item.value as T;
		} catch (error) {
			console.error("Memory cache GET error:", error);
			return null;
		}
	}

	/**
	 * Busca múltiplos valores do cache
	 */
	public async mget<T>(keys: string[]): Promise<(T | null)[]> {
		try {
			return keys.map((key) => {
				const item = this.cache.get(key);

				if (!item) {
					return null;
				}

				// Verifica expiração
				if (item.expiresAt && item.expiresAt < Date.now()) {
					this.cache.delete(key);
					return null;
				}

				return item.value as T;
			});
		} catch (error) {
			console.error("Memory cache MGET error:", error);
			return keys.map(() => null);
		}
	}

	/**
	 * Armazena múltiplos valores no cache
	 */
	public async mset(items: Array<{ key: string; value: any; ttl?: number }>): Promise<boolean> {
		try {
			for (const item of items) {
				await this.set(item.key, item.value, item.ttl);
			}
			return true;
		} catch (error) {
			console.error("Memory cache MSET error:", error);
			return false;
		}
	}

	/**
	 * Remove um valor do cache
	 */
	public async del(key: string): Promise<boolean> {
		try {
			this.cache.delete(key);
			return true;
		} catch (error) {
			console.error("Memory cache DEL error:", error);
			return false;
		}
	}

	/**
	 * Remove múltiplos valores do cache
	 */
	public async mdel(keys: string[]): Promise<boolean> {
		try {
			for (const key of keys) {
				this.cache.delete(key);
			}
			return true;
		} catch (error) {
			console.error("Memory cache MDEL error:", error);
			return false;
		}
	}

	/**
	 * Verifica se uma chave existe
	 */
	public async exists(key: string): Promise<boolean> {
		try {
			const item = this.cache.get(key);

			if (!item) {
				return false;
			}

			// Verifica expiração
			if (item.expiresAt && item.expiresAt < Date.now()) {
				this.cache.delete(key);
				return false;
			}

			return true;
		} catch (error) {
			console.error("Memory cache EXISTS error:", error);
			return false;
		}
	}

	/**
	 * Define o tempo de expiração de uma chave
	 */
	public async expire(key: string, seconds: number): Promise<boolean> {
		try {
			const item = this.cache.get(key);

			if (!item) {
				return false;
			}

			item.expiresAt = Date.now() + seconds * 1000;
			return true;
		} catch (error) {
			console.error("Memory cache EXPIRE error:", error);
			return false;
		}
	}

	/**
	 * Limpa todas as chaves que correspondem ao padrão (glob pattern simples)
	 */
	public async clear(pattern: string): Promise<number> {
		try {
			let clearedCount = 0;

			// Converte padrão glob simples para regex
			const regexPattern = pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escapa caracteres especiais
				.replace(/\*/g, ".*"); // Substitui * por .*

			const regex = new RegExp(`^${regexPattern}$`);

			for (const key of this.cache.keys()) {
				if (regex.test(key)) {
					this.cache.delete(key);
					clearedCount++;
				}
			}

			return clearedCount;
		} catch (error) {
			console.error("Memory cache CLEAR error:", error);
			return 0;
		}
	}

	/**
	 * Retorna informações sobre o cache (para debug)
	 */
	public getStats(): { size: number; keys: string[] } {
		return {
			size: this.cache.size,
			keys: Array.from(this.cache.keys())
		};
	}

	/**
	 * Limpa o cache completamente
	 */
	public async flush(): Promise<void> {
		this.cache.clear();
	}

	/**
	 * Desconecta o cache (limpa a rotina de limpeza)
	 */
	public async disconnect(): Promise<void> {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.cache.clear();
	}
}

export default new MemoryCacheService();
