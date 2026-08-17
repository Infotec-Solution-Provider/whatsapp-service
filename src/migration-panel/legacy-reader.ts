import { createPool, Pool, PoolOptions, RowDataPacket } from "mysql2/promise";
import { LegacyRow, MigrationCounts, MigrationTableCount, SourceDatabaseConfig } from "./types";

export const LEGACY_TABLE_FIELDS = {
	sectors: ["CODIGO", "NOME", "RECEBE_MENSAGENS", "INICIA_ATENDIMENTO", "START_CHATS"],
	contacts: ["CODIGO", "CODIGO_CLIENTE", "NOME", "NUMERO", "SETOR", "WHATSAPP_ID", "AVATAR_URL"],
	chats: [
		"CODIGO", "ATIVO_RECEP", "CODIGO_OPERADOR", "CODIGO_OPERADOR_ANTERIOR", "CODIGO_CLIENTE",
		"CODIGO_NUMERO", "CODIGO_CC", "CONCLUIDO", "DATA_INICIO", "DATA_FIM", "DATA_AGENDAMENTO",
		"AGUARDANDO_RETORNO", "URGENCIA_OPERADOR", "URGENCIA_AGENDAMENTO", "URGENCIA_SUPERVISOR",
		"SETOR", "TIPO", "AVATAR_URL", "RESULTADO",
	],
	messages: [
		"CODIGO", "CODIGO_ATENDIMENTO", "CODIGO_OPERADOR", "CODIGO_NUMERO", "TIPO", "MENSAGEM",
		"FROM_ME", "DATA_HORA", "TIMESTAMP", "ID", "ID_REFERENCIA", "STATUS", "ARQUIVO",
		"LOCAL_ID", "GRUPO_ID", "GRUPO_NOME", "CONTATO_NOME", "FROM", "TO",
	],
	readyMessages: ["CODIGO", "TITULO", "TEXTO_MENSAGEM", "SETOR", "ARQUIVO", "LAST_UPDATE"],
} as const;

type LegacyTable = keyof typeof LEGACY_TABLE_FIELDS;
type RowCallback = (rows: LegacyRow[]) => Promise<void>;

const TABLE_NAMES: Record<LegacyTable, string> = {
	sectors: "w_setores",
	contacts: "w_clientes_numeros",
	chats: "w_atendimentos",
	messages: "w_mensagens",
	readyMessages: "w_mensagens_prontas",
};

export interface LegacyScanResult {
	available: boolean;
	count: number;
	error?: string;
}

const quoteIdentifier = (identifier: string): string => `\`${identifier.replace(/`/g, "``")}\``;

class LegacyReader {
	private readonly pool: Pool;
	private readonly columnsCache = new Map<string, Set<string>>();

	constructor(config: SourceDatabaseConfig) {
		const options: PoolOptions = {
			host: config.host,
			port: config.port,
			user: config.user,
			password: config.password,
			database: config.database,
			waitForConnections: true,
			connectionLimit: 3,
			queueLimit: 0,
			charset: "utf8mb4",
		};
		if (config.ssl) {
			options.ssl = { rejectUnauthorized: false };
		}
		this.pool = createPool(options);
	}

	public async testConnection(): Promise<void> {
		await this.pool.query("SELECT 1 AS ok");
	}

	private async getColumns(table: string): Promise<Set<string>> {
		const cached = this.columnsCache.get(table);
		if (cached) {
			return cached;
		}

		const [rows] = await this.pool.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${quoteIdentifier(table)}`);
		const columns = new Set(
			rows.map((row) => String(row["Field"] ?? "").toUpperCase()).filter(Boolean),
		);
		this.columnsCache.set(table, columns);
		return columns;
	}

	private async getAvailableFields(table: string, fields: readonly string[]): Promise<string[]> {
		const columns = await this.getColumns(table);
		return fields.filter((field) => columns.has(field.toUpperCase()));
	}

	public async scanTable(tableKey: LegacyTable, batchSize: number, onBatch: RowCallback): Promise<LegacyScanResult> {
		const table = TABLE_NAMES[tableKey];
		try {
			const fields = await this.getAvailableFields(table, LEGACY_TABLE_FIELDS[tableKey]);
			if (!fields.includes("CODIGO")) {
				return { available: false, count: 0, error: `${table} não possui a coluna CODIGO` };
			}

			let lastId = 0;
			let total = 0;
			const selectedFields = fields.map(quoteIdentifier).join(", ");
			while (true) {
				const [rows] = await this.pool.query<RowDataPacket[]>(
					`SELECT ${selectedFields} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier("CODIGO")} > ? ORDER BY ${quoteIdentifier("CODIGO")} LIMIT ?`,
					[lastId, batchSize],
				);
				if (rows.length === 0) {
					break;
				}

				const mappedRows = rows as unknown as LegacyRow[];
				await onBatch(mappedRows);
				total += rows.length;
				const lastRow = mappedRows[rows.length - 1];
				const nextId = Number(lastRow?.["CODIGO"]);
				if (!Number.isFinite(nextId) || nextId <= lastId) {
					break;
				}
				lastId = nextId;
			}

			return { available: true, count: total };
		} catch (error) {
			return { available: false, count: 0, error: this.errorMessage(error) };
		}
	}

	public async countTables(): Promise<{ counts: MigrationCounts; tables: MigrationTableCount[] }> {
		const tableEntries = Object.entries(TABLE_NAMES) as [LegacyTable, string][];
		const tables: MigrationTableCount[] = [];
		const counts: MigrationCounts = {
			sectors: 0,
			contacts: 0,
			chats: 0,
			messages: 0,
			readyMessages: 0,
		};

		for (const [key, table] of tableEntries) {
			try {
				const [rows] = await this.pool.query<RowDataPacket[]>(
					`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`,
				);
				const count = Number(rows[0]?.["total"] ?? 0);
				counts[key] = count;
				tables.push({ table, available: true, count });
			} catch (error) {
				tables.push({ table, available: false, count: 0, error: this.errorMessage(error) });
			}
		}

		return { counts, tables };
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

export default LegacyReader;
