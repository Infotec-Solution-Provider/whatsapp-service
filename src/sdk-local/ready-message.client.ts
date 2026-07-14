import ApiClient from "./api-client";
import { DataResponse } from "./types/response.types";
import {
	ReadyMessage,
	CreateReadyMessageDto,
	UpdateReadyMessageDto,
} from "./types/ready-messages.types";
import FormData from "form-data";

/**
 * Client para gerenciar mensagens prontas (templates de mensagens)
 *
 * @example
 * ```typescript
 * const client = new ReadyMessageClient(baseURL);
 * client.setAuth(token);
 *
 * // Criar mensagem pronta
 * const message = await client.createReadyMessage({
 *   title: "Boas-vindas",
 *   message: "Olá! Como posso ajudar?",
 *   sectorId: 10,
 *   onlyAdmin: false
 * });
 *
 * // Listar mensagens
 * const messages = await client.getReadyMessages();
 * ```
 */
export default class ReadyMessageClient extends ApiClient {
	/**
	 * Cria uma nova mensagem pronta
	 *
	 * @param data - Dados da mensagem (title, message, sectorId, onlyAdmin)
	 * @param file - Arquivo opcional para anexar à mensagem
	 * @returns A mensagem pronta criada
	 *
	 * @example
	 * ```typescript
	 * const message = await client.createReadyMessage({
	 *   title: "Horário de Atendimento",
	 *   message: "Nosso horário é de 8h às 18h",
	 *   sectorId: 10
	 * }, fileObject);
	 * ```
	 */
	public async createReadyMessage(
		data: CreateReadyMessageDto,
		file: File | null = null,
	): Promise<ReadyMessage> {
		const form = new FormData();

		if (file) {
			form.append("file", file);
		}

		form.append("data", JSON.stringify(data));

		const { data: res } = await this.ax.post<DataResponse<ReadyMessage>>(
			`/api/ready-messages`,
			form,
			{
				headers: {
					"Content-Type": "multipart/form-data",
				},
			},
		);

		return res.data;
	}

	/**
	 * Lista todas as mensagens prontas do setor do usuário
	 *
	 * Nota: Se o usuário for do setor TI (setor 3), retorna mensagens de todos os setores
	 *
	 * @returns Array de mensagens prontas
	 *
	 * @example
	 * ```typescript
	 * const messages = await client.getReadyMessages();
	 * console.log(`Encontradas ${messages.length} mensagens`);
	 * ```
	 */
	public async getReadyMessages(): Promise<ReadyMessage[]> {
		const url = `/api/ready-messages`;
		const { data: res } =
			await this.ax.get<DataResponse<ReadyMessage[]>>(url);

		return res.data;
	}

	/**
	 * Atualiza uma mensagem pronta existente
	 *
	 * @param id - ID da mensagem pronta
	 * @param data - Dados para atualizar (campos opcionais)
	 * @param file - Novo arquivo opcional
	 * @returns A mensagem pronta atualizada
	 *
	 * @example
	 * ```typescript
	 * const updated = await client.updateReadyMessage(
	 *   123,
	 *   { title: "Novo Título" },
	 *   newFile
	 * );
	 * ```
	 */
	public async updateReadyMessage(
		id: number,
		data: UpdateReadyMessageDto,
		file?: File,
	): Promise<ReadyMessage> {
		const formData = new FormData();

		if (file) {
			formData.append("file", file);
		}

		// Converter para o formato que o backend espera (UPPERCASE)
		const backendData: any = {};
		if (data.title !== undefined) backendData.TITULO = data.title;
		if (data.message !== undefined)
			backendData.TEXTO_MENSAGEM = data.message;
		if (data.onlyAdmin !== undefined)
			backendData.APENAS_ADMIN = data.onlyAdmin;

		formData.append("data", JSON.stringify(backendData));

		const { data: res } = await this.ax.put<DataResponse<ReadyMessage>>(
			`/api/ready-messages/${id}`,
			formData,
			{
				headers: {
					"Content-Type": "multipart/form-data",
				},
			},
		);

		return res.data;
	}

	/**
	 * Deleta uma mensagem pronta
	 *
	 * @param id - ID da mensagem pronta a ser deletada
	 *
	 * @example
	 * ```typescript
	 * await client.deleteReadyMessage(123);
	 * console.log("Mensagem deletada com sucesso!");
	 * ```
	 */
	public async deleteReadyMessage(id: number): Promise<void> {
		const url = `/api/ready-messages/${id}`;
		await this.ax.delete<DataResponse<void>>(url);
	}

	/**
	 * Define o token de autenticação para as requisições
	 *
	 * @param token - Token JWT de autenticação
	 *
	 * @example
	 * ```typescript
	 * client.setAuth("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...");
	 * ```
	 */
	public setAuth(token: string): void {
		this.ax.defaults.headers.common["Authorization"] = `Bearer ${token}`;
	}
}
