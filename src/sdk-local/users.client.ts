import { DataResponse, PaginatedResponse } from "./types/response.types";
import { CreateUserDTO, UpdateUserDTO, User } from "./types/user.types";
import ApiClient from "./api-client";
import { RequestFilters } from "./types";

/**
 * SDK para operações de usuários.
 */
export default class UsersClient extends ApiClient {
	/**
	 * Obtém a lista de usuários.
	 * @param filters - Filtros opcionais para a query.
	 * @returns Uma resposta paginada contendo os usuários.
	 */
	public async getUsers(filters?: RequestFilters<User>) {
		let baseUrl = `/api/users`;

		if (filters) {
			const params = new URLSearchParams(filters);
			baseUrl += `?${params.toString()}`;
		}

		const response = await this.ax.get<PaginatedResponse<User>>(baseUrl);

		return response.data;
	}

	/**
	 * Obtém um usuário pelo ID.
	 * @param userId - O ID do usuário.
	 * @returns Uma resposta contendo os dados do usuário.
	 */
	public async getUserById(userId: number) {
		const { data: res } = await this.ax.get<DataResponse<User>>(
			`/api/users/${userId}`,
		);

		return res.data;
	}

	/**
	 * Cria um novo usuário.
	 * @param data - Os dados para criação do usuário.
	 * @returns Uma resposta contendo os dados do usuário criado.
	 * @throws Um erro se a criação do usuário falhar.
	 */
	public async createUser(data: CreateUserDTO) {
		try {
			const { data: res } = await this.ax.post<DataResponse<User>>(
				`/api/users`,
				data,
			);

			return res.data;
		} catch (error) {
			throw new Error("Failed to create user", { cause: error });
		}
	}

	/**
	 * Atualiza um usuário existente.
	 * @param userId - O ID do usuário.
	 * @param data - Os dados para atualização do usuário.
	 * @returns Uma resposta contendo os dados do usuário atualizado.
	 * @throws Um erro se a atualização do usuário falhar.
	 */
	public async updateUser(userId: string, data: UpdateUserDTO) {
		try {
			const { data: res } = await this.ax.patch<DataResponse<User>>(
				`/api/users/${userId}`,
				data,
			);

			return res.data;
		} catch (error) {
			throw new Error("Failed to update user", { cause: error });
		}
	}

	/**
	 * Sets the authorization token for HTTP requests.
	 *
	 * @param token - The authentication token to be used in the `Authorization` header.
	 */
	public setAuth(token: string) {
		this.ax.defaults.headers.common["Authorization"] = `Bearer ${token}`;
	}
}
