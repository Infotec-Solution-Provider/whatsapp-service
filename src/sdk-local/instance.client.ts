import { QueryResponse } from "./types/response.types";
import ApiClient from "./api-client";
import { isAxiosError } from "axios";

export interface InstanceQueryOptions {
	/** Per-request network timeout; omitting it preserves the SDK default. */
	timeoutMs?: number;
}

export class InstanceQueryUnavailableError extends Error {
	constructor(public readonly instance: string, message: string) {
		super(message);
	}
}

const CONNECTION_CODES = new Set([
	"ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT",
	"ECONNABORTED", "EAI_AGAIN", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST"
]);

function isUnavailableQueryError(error: unknown): boolean {
	const transportError = isAxiosError(error) ? error : error instanceof Error ? error.cause : undefined;
	if (!isAxiosError<{ error?: { code?: string } }>(transportError)) return false;
	if (!transportError.response) return CONNECTION_CODES.has(transportError.code ?? "");

	const { status, data } = transportError.response;
	// The instances API uses HTTP 500 for both MySQL connection errors and SQL/business errors.
	return status === 502 || status === 503 || status === 504 ||
		(status === 500 && CONNECTION_CODES.has(data?.error?.code ?? ""));
}

/**
 * Classe InstanceSDK para interagir com a API de instâncias.
 */
class InstancesClient extends ApiClient {

	/**
	 * Executa uma consulta na instância especificada.
	 * @param {string} instance Nome da instância do Inpulse.
	 * @param {string} query Consulta a ser executada.
	 * @param {any[]} parameters Parâmetros da consulta.
	 * @returns {Promise<T>} Resultado da consulta.
	 */
	public async executeQuery<T>(
		instance: string,
		query: string,
		parameters: any[],
		options?: InstanceQueryOptions,
	): Promise<T> {
		if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > ApiClient.DEFAULT_TIMEOUT_MS)) {
			throw new Error("INVALID_INSTANCE_QUERY_TIMEOUT");
		}
		const response = await this.ax
			.post<
				QueryResponse<T>
			>(`/api/instances/${instance}/query`, { query, parameters }, options?.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs })
			.catch((error) => {
				const status = error.response?.status;
				const fallbackMessage = status ? `Failed to execute query, status: ${status}` : error.message;
				const message = error.response?.data?.message || fallbackMessage;
				if (isUnavailableQueryError(error)) throw new InstanceQueryUnavailableError(instance, message);
				throw new Error(message);
			});

		return response.data.result;
	}
}

export default InstancesClient;
