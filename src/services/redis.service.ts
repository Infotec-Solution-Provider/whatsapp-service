import Redis from "ioredis";

class RedisService {
	private client: Redis | null = null;
	private isConnected: boolean = false;

	constructor() {
		this.connect();
	}

	private connect() {
		try {
			const redisUrl = process.env["REDIS_URL"] || "redis://localhost:6379";
			
			this.client = new Redis(redisUrl, {
				maxRetriesPerRequest: 3,
				retryStrategy: (times) => {
					const delay = Math.min(times * 50, 2000);
					return delay;
				},
				reconnectOnError: (err) => {
					const targetError = "READONLY";
					if (err.message.includes(targetError)) {
						return true;
					}
					return false;
				}
			});

			this.client.on("connect", () => {
				console.log("✅ Redis connected successfully");
				this.isConnected = true;
			});

			this.client.on("error", (error) => {
				console.error("❌ Redis connection error:", error.message);
				this.isConnected = false;
			});

			this.client.on("close", () => {
				console.log("⚠️ Redis connection closed");
				this.isConnected = false;
			});
		} catch (error) {
			console.error("❌ Failed to initialize Redis:", error);
			this.isConnected = false;
		}
	}

	/**
	 * Verifica se o Redis está conectado
	 */
	public isReady(): boolean {
		return this.isConnected && this.client !== null;
	}

	/**
	 * Armazena um valor no Redis com expiração opcional
	 */
	public async set(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
		if (!this.isReady()) {
			console.warn("Redis not ready, skipping set operation");
			return false;
		}

		try {
			const serialized = JSON.stringify(value);
			if (ttlSeconds) {
				await this.client!.setex(key, ttlSeconds, serialized);
			} else {
				await this.client!.set(key, serialized);
			}
			return true;
		} catch (error) {
			console.error("Redis SET error:", error);
			return false;
		}
	}

	/**
	 * Busca um valor do Redis
	 */
	public async get<T>(key: string): Promise<T | null> {
		if (!this.isReady()) {
			return null;
		}

		try {
			const value = await this.client!.get(key);
			if (value === null) {
				return null;
			}
			return JSON.parse(value) as T;
		} catch (error) {
			console.error("Redis GET error:", error);
			return null;
		}
	}

	/**
	 * Busca múltiplos valores do Redis
	 */
	public async mget<T>(keys: string[]): Promise<(T | null)[]> {
		if (!this.isReady() || keys.length === 0) {
			return keys.map(() => null);
		}

		try {
			const values = await this.client!.mget(...keys);
			return values.map((value) => {
				if (value === null) {
					return null;
				}
				try {
					return JSON.parse(value) as T;
				} catch {
					return null;
				}
			});
		} catch (error) {
			console.error("Redis MGET error:", error);
			return keys.map(() => null);
		}
	}

	/**
	 * Armazena múltiplos valores no Redis
	 */
	public async mset(items: Array<{ key: string; value: any; ttl?: number }>): Promise<boolean> {
		if (!this.isReady() || items.length === 0) {
			return false;
		}

		try {
			const pipeline = this.client!.pipeline();
			
			for (const item of items) {
				const serialized = JSON.stringify(item.value);
				if (item.ttl) {
					pipeline.setex(item.key, item.ttl, serialized);
				} else {
					pipeline.set(item.key, serialized);
				}
			}
			
			await pipeline.exec();
			return true;
		} catch (error) {
			console.error("Redis MSET error:", error);
			return false;
		}
	}

	/**
	 * Remove um valor do Redis
	 */
	public async del(key: string): Promise<boolean> {
		if (!this.isReady()) {
			return false;
		}

		try {
			await this.client!.del(key);
			return true;
		} catch (error) {
			console.error("Redis DEL error:", error);
			return false;
		}
	}

	/**
	 * Remove múltiplos valores do Redis
	 */
	public async mdel(keys: string[]): Promise<boolean> {
		if (!this.isReady() || keys.length === 0) {
			return false;
		}

		try {
			await this.client!.del(...keys);
			return true;
		} catch (error) {
			console.error("Redis MDEL error:", error);
			return false;
		}
	}

	/**
	 * Verifica se uma chave existe
	 */
	public async exists(key: string): Promise<boolean> {
		if (!this.isReady()) {
			return false;
		}

		try {
			const result = await this.client!.exists(key);
			return result === 1;
		} catch (error) {
			console.error("Redis EXISTS error:", error);
			return false;
		}
	}

	/**
	 * Define o tempo de expiração de uma chave
	 */
	public async expire(key: string, seconds: number): Promise<boolean> {
		if (!this.isReady()) {
			return false;
		}

		try {
			await this.client!.expire(key, seconds);
			return true;
		} catch (error) {
			console.error("Redis EXPIRE error:", error);
			return false;
		}
	}

	/**
	 * Limpa todas as chaves que correspondem ao padrão
	 */
	public async clear(pattern: string): Promise<number> {
		if (!this.isReady()) {
			return 0;
		}

		try {
			const keys = await this.client!.keys(pattern);
			if (keys.length === 0) {
				return 0;
			}
			await this.client!.del(...keys);
			return keys.length;
		} catch (error) {
			console.error("Redis CLEAR error:", error);
			return 0;
		}
	}

	/**
	 * Fecha a conexão com o Redis
	 */
	public async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.quit();
			this.isConnected = false;
		}
	}
}

export default new RedisService();
