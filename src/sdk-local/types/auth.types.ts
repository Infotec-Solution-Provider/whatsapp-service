import { User } from "./user.types";

export interface LoginData {
	/**
	 * Token de autenticação.
	 */
	token: string;
	/**
	 * Dados do usuário.
	 */
	user: User;
}

export interface SessionData {
	/**
	 * ID do usuário.
	 */
	userId: number;
	/**
	 * ID do setor do usuário.
	 */
	sectorId: number;
	/**
	 * Papel do usuário.
	 */
	role: string;
	/**
	 * Nome da instância.
	 */
	instance: string;

	/**
	 * Nome do usuário.
	 */
	name: string;
}

export interface UserOnlineSession {
	data: SessionData;
	isPaused: boolean;
	onlineTokens: Array<string>;
}
