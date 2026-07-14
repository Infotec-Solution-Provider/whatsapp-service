import { sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { DataResponse } from "./types/response.types";
import ApiClient from "./api-client";
import { LoginData, SessionData, UserOnlineSession } from "./types/auth.types";

/**
 * Classe AuthSDK para interagir com a API de autenticação.
 */
export default class AuthClient extends ApiClient {
	/**
	 * Realiza o login do usuário.
	 * @param instance Nome da instância do Inpulse.
	 * @param username Nome de usuário.
	 * @param password Senha do usuário.
	 * @returns  Dados de login.
	 */
	public async login(instance: string, username: string, password: string) {
		const { data: res } = await this.ax.post<
			DataResponse<LoginData>
		>(`/api/auth/login`, { LOGIN: username, SENHA: password, instance });

		return res.data;
	}

	/**
	 * Busca os dados da sessão.
	 * @param authToken Token de autenticação.
	 * @returns Dados da sessão.
	 */
	public async fetchSessionData(authToken: string) {
		const { data: res } = await this.ax
			.get<DataResponse<SessionData>>(`/api/auth/session`, {
				headers: {
					authorization: authToken,
				},
			})
			.catch((error) => {
				const message = sanitizeErrorMessage(error);
				throw new Error("Failed to fetch session data! " + message);
			});

		return res.data;
	}

	/**
	 * Verifica se o usuário está autenticado.
	 * @param instanceName Nome da instância do Inpulse.
	 * @param authToken Token de autenticação.
	 * @returns Verdadeiro se o usuário estiver autenticado, falso caso contrário.
	 */
	public async isAuthenticated(
		instanceName: string,
		authToken: string,
	): Promise<boolean> {
		try {
			const session = await this.fetchSessionData(authToken);

			return !!session.userId && session.instance === instanceName;
		} catch {
			return false;
		}
	}

	/**
	 * Verifica se o usuário está autorizado.
	 * @param instanceName Nome da instância do Inpulse.
	 * @param authToken Token de autenticação.
	 * @param authorizedRoles Lista de papéis autorizados.
	 * @returns Verdadeiro se o usuário estiver autorizado, falso caso contrário.
	 */
	public async isAuthorized(
		instanceName: string,
		authToken: string,
		authorizedRoles: string[],
	) {
		try {
			const session = await this.fetchSessionData(authToken);

			return (
				authorizedRoles.includes(session.role) &&
				session.instance === instanceName
			);
		} catch {
			return false;
		}
	}

	public async getOnlineSessions(instance: string) {
		const { data: res } = await this.ax.get<
			DataResponse<UserOnlineSession[]>
		>("/api/online-sessions", {
			params: {
				instance,
			},
		});

		return res.data;
	}

	public async initOnlineSession(authToken: string) {
		await this.ax.post(
			"/api/online-sessions",
			{},
			{
				headers: {
					Authorization: authToken,
				},
			},
		);
	}

	public async finishOnlineSession(authToken: string) {
		await this.ax.delete("/api/online-sessions", {
			headers: {
				Authorization: authToken,
			},
		});
	}
}
