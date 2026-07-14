import ApiClient from "./api-client";
import { ChatsReport, ExecuteSqlReportOptions, ExportSqlReportOptions, GenerateChatsReportOptions, SQLReportRow } from "./types/reports.types";
import { DataResponse, MessageResponse } from "./types/response.types";

/**
 * ReportsClient class to handle reports related API calls.
 *
 * This class extends the ApiClient class and provides methods to interact with the reports API.
 * It includes methods to get, generate, and delete chat reports.
 */
export default class ReportsClient extends ApiClient {
	/**
	 * Retrieves chat reports from the server.
	 *
	 * @returns A promise that resolves to an array of chat reports wrapped in a `DataResponse` object.
	 */
	public async getChatsReports() {
		const url = `/api/reports/chats`;
		const { data: res } =
			await this.ax.get<DataResponse<Array<ChatsReport>>>(url);

		return res.data;
	}

	/**
	 * Generates a report for chat interactions based on the provided options.
	 *
	 * @param body - The options for generating the chats report, including filters and parameters.
	 * @returns A promise that resolves to the data of the generated chats report.
	 */
	public async generateChatsReport(body: GenerateChatsReportOptions) {
		const url = `/api/reports/chats`;
		const { data: res } = await this.ax.post<
			DataResponse<ChatsReport>
		>(url, body);

		return res.data;
	}

	/**
	 * Deletes a chat report by its unique identifier.
	 *
	 * @param chatsReportId - The unique identifier of the chat report to be deleted.
	 */
	public async deleteChatsReport(chatsReportId: number) {
		const url = `/api/reports/chats/${chatsReportId}`;
		await this.ax.delete<MessageResponse>(url);
	}
	/**
	 * Desative a report sql by its unique identifier.
	 *
	 * @param reportId - The unique identifier of the chat report to be deleted.
	 */

	public async deleteHistoryReport(reportId: number) {
		const url = `/api/reports-history/${reportId}`;
		await this.ax.delete<MessageResponse>(url);
	}
		/**
	 * Execute a report sql interactions based on the provided options.
	 *
	 * @param body - The options for execute the report sql.
	 * @returns A promise that resolves to the data of the generated chats report.
	 */

		public async executeSqlReport(body: ExecuteSqlReportOptions) {
			const url = `/api/execute-report-sql`;
			const { data: res } = await this.ax.post<DataResponse<SQLReportRow[]>>(url, body);
			return res.data;
		}

		/**
	 * Retrieves chat reports from the server.
	 *
	 * @returns A promise that resolves to an array of chat reports wrapped in a `DataResponse` object.
	 */
	public async getSqlReportsHistory() {
		const url = `/api/reports-history`;
		const { data: res } =
			await this.ax.get<DataResponse<Array<any>>>(url);

		return res.data;
	}
			/**
	 * Export a report sql interactions based on the provided options.
	 *
	 * @param body - The options for export the report sql.
	 * @returns A promise that resolves to the data of the generated chats report.
	 */

		public async exportReportSql(body: ExportSqlReportOptions) {
			const url = `/api/export-report-sql`;
			const response = await this.ax.post(url, body, {
				responseType: 'blob',
			});
			return response.data as Blob;
		}


	/**
	 * Sets the authorization token for the HTTP client.
	 *
	 * @param token - The Bearer token to be used for authentication.
	 *                This token will be included in the `Authorization` header
	 *                of all HTTP requests made by the client.
	 */
	public setAuth(token: string) {
		this.ax.defaults.headers.common["Authorization"] =
			`Bearer ${token}`;
	}
}
