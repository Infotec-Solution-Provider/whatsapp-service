export interface SavedMessageWithoutFile {
	CODIGO_ATENDIMENTO: number;
	CODIGO_OPERADOR: number;
	CODIGO_NUMERO: number;
	CONTATO_NOME: string;
	CONTATO_NUMERO: string;
	CONTATO_CLIENTE: number;
	OPERADOR_NOME: string;
	TIPO: string;
	MENSAGEM: string | null;
	FROM_ME: boolean | number;
	DATA_HORA: Date;
	TIMESTAMP: number;
	ID: string;
	ID_REFERENCIA: string | null;
	STATUS: string;
	LOCAL_ID: string;
}

export interface SavedMessageWithFile extends SavedMessageWithoutFile {
	ARQUIVO_NOME: string;
	ARQUIVO_TIPO: string;
	ARQUIVO_NOME_ORIGINAL: string;
}

export type SavedMessage = SavedMessageWithoutFile | SavedMessageWithFile;

export enum ExportChatFileFormat {
	TXT = "txt",
	CSV = "csv",
	PDF = "pdf"
}

export interface ExportChatsProps {
	instance: string;
	userId: string;
	format: ExportChatFileFormat;
	startDate: string;
	endDate: string;
}

export interface ExportedChatInfo {
	userName: string;
	startDate: string;
	endDate: string;
	format: string;
	fileName: string;
	instance: string;
}

export interface DBExportedChat {
	instance: string;
	file_name: string;
	user_id: string;
	format: string;
	start_date: string;
	end_date: string;
}
