import { MigrationInstanceConfig, MigrationOptions, MigrationProvider } from "./types";

export interface MigrationPanelSettings {
	host: string;
	port: number;
	token: string;
	instancesApiUrl: string;
	instancesToken: string;
	instancesLogin: string;
	instancesPassword: string;
	outputDir: string;
}

const asString = (value: unknown, fallback = ""): string => {
	if (typeof value === "string") {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return fallback;
};

const asBoolean = (value: unknown, fallback: boolean): boolean => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return ["1", "true", "yes", "sim", "on"].includes(value.toLowerCase());
	}
	return fallback;
};

const asPositiveInt = (value: unknown, fallback: number): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseProvider = (value: unknown): MigrationProvider => {
	const provider = asString(value, "REMOTE").toUpperCase();
	if (provider === "REMOTE" || provider === "WWEBJS" || provider === "WABA" || provider === "GUPSHUP") {
		return provider;
	}
	throw new Error("provider deve ser REMOTE, WWEBJS, WABA ou GUPSHUP");
};

const parseParameters = (value: unknown): Record<string, string> => {
	if (value === undefined || value === null || value === "") {
		return {};
	}
	const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("instanceParameters deve ser um objeto JSON");
	}
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, asString(item)]),
	);
};

export const readPanelSettings = (env: NodeJS.ProcessEnv = process.env): MigrationPanelSettings => ({
	host: env["MIGRATION_PANEL_HOST"]?.trim() || "127.0.0.1",
	port: asPositiveInt(env["MIGRATION_PANEL_PORT"], 8095),
	token: env["MIGRATION_PANEL_TOKEN"]?.trim() || "",
	instancesApiUrl: env["MIGRATION_INSTANCES_API_URL"]?.trim() || env["INSTANCES_API_URL"]?.trim() || "http://localhost:8000",
	instancesToken: env["MIGRATION_INSTANCES_TOKEN"]?.trim() || "",
	instancesLogin: env["MIGRATION_INSTANCES_LOGIN"]?.trim() || "",
	instancesPassword: env["MIGRATION_INSTANCES_PASSWORD"] || "",
	outputDir: env["MIGRATION_OUTPUT_DIR"]?.trim() || "./migration-output",
});

export const parseMigrationConfig = (
	payload: unknown,
	settings: MigrationPanelSettings,
): MigrationInstanceConfig => {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("O corpo da migração deve ser um objeto JSON");
	}

	const input = payload as Record<string, unknown>;
	const sourceInput = (input["source"] && typeof input["source"] === "object")
		? input["source"] as Record<string, unknown>
		: {};
	const apiInput = (input["instancesApi"] && typeof input["instancesApi"] === "object")
		? input["instancesApi"] as Record<string, unknown>
		: {};
	const runtimeInput = (input["runtimeDatabase"] && typeof input["runtimeDatabase"] === "object")
		? input["runtimeDatabase"] as Record<string, unknown>
		: {};
	const optionsInput = (input["options"] && typeof input["options"] === "object")
		? input["options"] as Record<string, unknown>
		: {};

	const sourceInstance = asString(input["sourceInstance"] || input["instance"]);
	const targetInstance = asString(input["targetInstance"] || input["instance"], sourceInstance);
	const clientName = asString(input["clientName"], targetInstance);
	if (!sourceInstance || !targetInstance || !clientName) {
		throw new Error("sourceInstance, targetInstance e clientName são obrigatórios");
	}
	if (targetInstance.length < 3 || targetInstance.length > 16 || /[\r\n/\\]/.test(targetInstance)) {
		throw new Error("targetInstance deve ter entre 3 e 16 caracteres e não pode conter barras ou quebras de linha");
	}

	const source: MigrationInstanceConfig["source"] = {
		host: asString(sourceInput["host"]),
		port: asPositiveInt(sourceInput["port"], 3306),
		user: asString(sourceInput["user"] || sourceInput["username"]),
		password: asString(sourceInput["password"]),
		database: asString(sourceInput["database"]),
		ssl: asBoolean(sourceInput["ssl"], false),
	};
	if (!source.host || !source.user || !source.database) {
		throw new Error("source.host, source.user e source.database são obrigatórios");
	}

	const instancesApi: MigrationInstanceConfig["instancesApi"] = {
		baseUrl: asString(apiInput["baseUrl"], settings.instancesApiUrl).replace(/\/$/, ""),
		token: asString(apiInput["token"], settings.instancesToken),
		login: asString(apiInput["login"], settings.instancesLogin),
		password: asString(apiInput["password"], settings.instancesPassword),
	};
	if (!instancesApi.baseUrl) {
		throw new Error("instancesApi.baseUrl é obrigatório");
	}
	const runtimeDatabase = {
		host: asString(runtimeInput["host"]) || source.host,
		port: asPositiveInt(runtimeInput["port"], source.port),
		user: asString(runtimeInput["user"] || runtimeInput["username"]) || source.user,
		password: asString(runtimeInput["password"], source.password),
		database: asString(runtimeInput["database"]) || "wwebjs-api",
	};

	const options: MigrationOptions = {
		importSectors: asBoolean(optionsInput["importSectors"], true),
		importContacts: asBoolean(optionsInput["importContacts"], true),
		importChats: asBoolean(optionsInput["importChats"], true),
		importMessages: asBoolean(optionsInput["importMessages"], true),
		importReadyMessages: asBoolean(optionsInput["importReadyMessages"], true),
		importParameters: asBoolean(optionsInput["importParameters"], true),
		generateRuntimeConfig: asBoolean(optionsInput["generateRuntimeConfig"], true),
		syncLocalAfterLoad: asBoolean(optionsInput["syncLocalAfterLoad"], false),
		allowExistingTargetData: asBoolean(optionsInput["allowExistingTargetData"], false),
		batchSize: Math.min(asPositiveInt(optionsInput["batchSize"], 500), 5000),
	};

	return {
		sourceInstance,
		targetInstance,
		clientName,
		provider: parseProvider(input["provider"]),
		phone: asString(input["phone"]),
		remoteClientUrl: asString(input["remoteClientUrl"]),
		wabaPhoneId: asString(input["wabaPhoneId"]),
		wabaAccountId: asString(input["wabaAccountId"]),
		wabaToken: asString(input["wabaToken"]),
		gupshupToken: asString(input["gupshupToken"]),
		gupshupAppName: asString(input["gupshupAppName"]),
		gupshupAppId: asString(input["gupshupAppId"]),
		source,
		instancesApi,
		runtimeDatabase,
		instanceParameters: parseParameters(input["instanceParameters"]),
		options,
	};
};

export const redactMigrationConfig = (config: MigrationInstanceConfig): Record<string, unknown> => ({
	...config,
	source: { ...config.source, password: "[redacted]" },
	runtimeDatabase: { ...config.runtimeDatabase, password: "[redacted]" },
	instancesApi: {
		...config.instancesApi,
		token: config.instancesApi.token ? "[redacted]" : "",
		password: config.instancesApi.password ? "[redacted]" : "",
	},
	wabaToken: config.wabaToken ? "[redacted]" : "",
	gupshupToken: config.gupshupToken ? "[redacted]" : "",
});
