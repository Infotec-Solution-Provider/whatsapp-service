import { AxiosInstance } from "axios";
import { QueryResponse } from "./types/response.types";
import ApiClient from "./api-client";

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
	): Promise<T> {
		const response = await this.ax
			.post<
				QueryResponse<T>
			>(`/api/instances/${instance}/query`, { query, parameters })
			.catch((error) => {
				if (error.response?.data?.message) {
					throw new Error(error.response.data.message);
				}
				if (error.response?.status) {
					throw new Error(
						`Failed to execute query, status: ${error.response.status}`,
					);
				}
				throw new Error(error.message);
			});

		return response.data.result;
	}
}

export default InstancesClient;
