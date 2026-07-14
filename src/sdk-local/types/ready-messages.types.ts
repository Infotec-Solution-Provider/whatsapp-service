/**
 * Mensagem Pronta (Ready Message)
 * Representa templates de mensagens que podem ser usadas rapidamente no atendimento
 */
export interface ReadyMessage {
	id: number;
	instance: string;
	sectorId: number | null;
	title: string;
	message: string;
	fileId: number | null;
	fileName: string | null;
	onlyAdmin: boolean;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * DTO para criação de mensagem pronta
 */
export interface CreateReadyMessageDto {
	title: string;
	message: string;
	sectorId?: number | null; 
	onlyAdmin?: boolean;
}

/**
 * DTO para atualização de mensagem pronta
 */
export interface UpdateReadyMessageDto {
	title?: string;
	message?: string;
	onlyAdmin?: boolean;
	sectorId?: number | null;
}
