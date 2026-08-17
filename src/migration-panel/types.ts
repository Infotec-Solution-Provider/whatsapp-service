export type MigrationPhase =
	| "preflight"
	| "provision"
	| "load"
	| "validate"
	| "cutover"
	| "rollback";

export type MigrationProvider = "REMOTE" | "WWEBJS" | "WABA" | "GUPSHUP";

export type MigrationRunStatus =
	| "CREATED"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "ROLLED_BACK";

export type MigrationEntity =
	| "sectors"
	| "contacts"
	| "chats"
	| "messages"
	| "readyMessages";

export interface SourceDatabaseConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	ssl: boolean;
}

export interface RuntimeDatabaseConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

export interface InstancesApiConfig {
	baseUrl: string;
	token: string;
	login: string;
	password: string;
}

export interface MigrationOptions {
	importSectors: boolean;
	importContacts: boolean;
	importChats: boolean;
	importMessages: boolean;
	importReadyMessages: boolean;
	importParameters: boolean;
	generateRuntimeConfig: boolean;
	syncLocalAfterLoad: boolean;
	allowExistingTargetData: boolean;
	batchSize: number;
}

export interface MigrationInstanceConfig {
	sourceInstance: string;
	targetInstance: string;
	clientName: string;
	provider: MigrationProvider;
	phone: string;
	remoteClientUrl: string;
	wabaPhoneId: string;
	wabaAccountId: string;
	wabaToken: string;
	gupshupToken: string;
	gupshupAppName: string;
	gupshupAppId: string;
	source: SourceDatabaseConfig;
	instancesApi: InstancesApiConfig;
	runtimeDatabase: RuntimeDatabaseConfig;
	instanceParameters: Record<string, string>;
	options: MigrationOptions;
}

export interface MigrationLogEntry {
	sequence: number;
	at: string;
	level: "info" | "warning" | "error";
	phase: MigrationPhase;
	message: string;
	meta?: Record<string, unknown>;
}

export interface MigrationRunSnapshot {
	id: string;
	instance: string;
	status: MigrationRunStatus;
	currentPhase: MigrationPhase;
	createdAt: string;
	updatedAt: string;
	logs: MigrationLogEntry[];
}

export interface MigrationTableCount {
	table: string;
	available: boolean;
	count: number;
	error?: string;
}

export interface MigrationCounts {
	sectors: number;
	contacts: number;
	chats: number;
	messages: number;
	readyMessages: number;
}

export type LegacyRow = Record<string, unknown>;

export interface MigrationMapRecord {
	entity: MigrationEntity;
	sourceId: string;
	targetId: number;
}
