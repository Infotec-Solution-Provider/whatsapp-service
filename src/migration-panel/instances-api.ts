import axios, { AxiosInstance } from "axios";
import { InstancesApiConfig, SourceDatabaseConfig } from "./types";

export interface InstancesServiceRecord {
	name: string;
	server?: {
		host: string;
		port: number;
		username: string;
		password?: string;
		database: string;
	};
	parameters?: Record<string, unknown>;
}

const responseData = <T>(response: { data?: { data?: T } | T }): T => {
	const body = response.data;
	if (body && typeof body === "object" && "data" in body && body.data !== undefined) {
		return body.data as T;
	}
	return body as T;
};

class InstancesApiClient {
	private readonly http: AxiosInstance;
	private token: string;
	private readonly config: InstancesApiConfig;

	constructor(config: InstancesApiConfig) {
		this.config = config;
		this.token = config.token;
		this.http = axios.create({
			baseURL: config.baseUrl,
			timeout: 20_000,
			validateStatus: (status) => status >= 200 && status < 500,
		});
	}

	public async health(): Promise<void> {
		const response = await this.http.get("/api/instances");
		if (response.status >= 400) {
			throw new Error(`instances-service respondeu HTTP ${response.status}`);
		}
	}

	public async getInstance(name: string): Promise<InstancesServiceRecord | null> {
		const response = await this.http.get(`/api/instances/${encodeURIComponent(name)}`);
		if (response.status === 404) {
			return null;
		}
		if (response.status >= 400) {
			throw new Error(`Falha ao consultar a instância no instances-service (HTTP ${response.status})`);
		}
		return responseData<InstancesServiceRecord>(response);
	}

	public async ensureInstance(
		name: string,
		source: SourceDatabaseConfig,
		parameters: Record<string, string>,
	): Promise<InstancesServiceRecord> {
		await this.authenticateIfConfigured();
		const current = await this.getInstance(name);
		const server = {
			host: source.host,
			port: source.port,
			username: source.user,
			password: source.password,
			database: source.database,
		};

		if (!current) {
			const response = await this.http.post(
				"/api/instances",
				{ name, server, parameters },
				{ headers: this.headers() },
			);
			if (response.status >= 400) {
				throw new Error(`Falha ao criar a instância no instances-service (HTTP ${response.status})`);
			}
			return responseData<InstancesServiceRecord>(response);
		}

		this.assertServerConfiguration(current, source);
		this.assertParametersConfiguration(current, parameters);
		if (this.token) {
			await this.updateServerIfNeeded(name, current, server);
			if (Object.keys(parameters).length > 0) {
				const response = await this.http.put(
					`/api/instances/${encodeURIComponent(name)}/parameters`,
					{ parameters },
					{ headers: this.headers() },
				);
				if (response.status >= 400) {
					throw new Error(`Falha ao configurar os parâmetros da instância (HTTP ${response.status})`);
				}
			}
		}

		return (await this.getInstance(name)) ?? current;
	}

	private async authenticateIfConfigured(): Promise<void> {
		if (this.token || !this.config.login || !this.config.password) {
			return;
		}
		const response = await this.http.post("/api/instances/root/auth", {
			login: this.config.login,
			password: this.config.password,
		});
		if (response.status >= 400) {
			throw new Error(`Falha na autenticação do instances-service (HTTP ${response.status})`);
		}
		const body = responseData<{ token?: string }>(response);
		if (!body.token) {
			throw new Error("instances-service não retornou token de autenticação");
		}
		this.token = body.token;
	}

	private async updateServerIfNeeded(
		name: string,
		current: InstancesServiceRecord,
		server: { host: string; port: number; username: string; password: string; database: string },
	): Promise<void> {
		const currentServer = current.server;
		const differs = !currentServer
			|| currentServer.host !== server.host
			|| currentServer.port !== server.port
			|| currentServer.username !== server.username
			|| currentServer.database !== server.database;
		if (!differs) {
			return;
		}
		const response = await this.http.put(
			`/api/instances/${encodeURIComponent(name)}/server`,
			{ server },
			{ headers: this.headers() },
		);
		if (response.status >= 400) {
			throw new Error(`Falha ao configurar o banco da instância (HTTP ${response.status})`);
		}
	}

	private assertServerConfiguration(current: InstancesServiceRecord, source: SourceDatabaseConfig): void {
		if (this.token) {
			return;
		}
		if (!current.server) {
			throw new Error("A instância já existe sem servidor configurado; informe MIGRATION_INSTANCES_TOKEN ou login/senha para configurá-la");
		}
		const sameServer = current.server.host === source.host
			&& current.server.port === source.port
			&& current.server.username === source.user
			&& current.server.database === source.database;
		if (!sameServer) {
			throw new Error("A instância já existe, mas o servidor configurado é diferente; informe MIGRATION_INSTANCES_TOKEN ou login/senha para atualizá-lo");
		}
	}

	private assertParametersConfiguration(current: InstancesServiceRecord, parameters: Record<string, string>): void {
		if (this.token || Object.keys(parameters).length === 0) {
			return;
		}
		if (!current.parameters || typeof current.parameters !== "object") {
			throw new Error("A instância já existe sem parâmetros configurados; informe MIGRATION_INSTANCES_TOKEN ou login/senha para configurá-la");
		}
		const currentParameters = current.parameters;
		const differs = Object.entries(parameters).some(([key, value]) => String(currentParameters[key] ?? "") !== value);
		if (differs) {
			throw new Error("Os parâmetros da instância existente são diferentes; informe MIGRATION_INSTANCES_TOKEN ou login/senha para atualizá-los");
		}
	}

	private headers(): Record<string, string> {
		return this.token ? { Authorization: `Bearer ${this.token}` } : {};
	}
}

export default InstancesApiClient;
