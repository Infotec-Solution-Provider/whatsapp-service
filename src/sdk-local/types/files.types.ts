import { DataResponse } from "./response.types";

export type FileExistsByHashResponse = DataResponse<{
    /**
     * Indica se um arquivo com o hash especificado existe.
     */
    exists: boolean;
    /**
     * Os dados do arquivo encontrado, caso exista.
     */
    file?: File;
}>;

export interface UploadFileOptions {
    /**
     * Nome da instância onde o arquivo está armazenado.
     */
    instance: string;

    /**
     * Tipo de diretório onde o arquivo está armazenado.
     */
    dirType: FileDirType;

    /**
     * Nome do arquivo.
     */
    fileName: string;

    /**
     * Buffer com o conteúdo do arquivo.
     */
    buffer: Buffer;

    /**
     * Tipo MIME do arquivo.
     */
    mimeType: string;

    /**
     * Identificador de rastreio para correlacionar logs ponta a ponta.
     */
    traceId?: string;

    /**
     * Hash SHA-256 pré-calculado do conteúdo, quando disponível.
     */
    contentHash?: string;
}

/**
 * Enum que representa os tipos de diretórios de arquivos.
 * 
 * @enum {string}
 * @property {string} PUBLIC - Representa o diretório público.
 * @property {string} MODELS - Representa o diretório de modelos.
 */
export enum FileDirType {
    PUBLIC = "public",
    MODELS = "models",
}

/**
 * Representa um arquivo no sistema.
 */
export interface File {
    /**
     * Identificador único para o arquivo.
     */
    id: number;

    /**
     * Identificador único para o arquivo no armazenamento.
     */
    id_storage: string;

    /**
     * Identificador único para o armazenamento.
     */
    storage_id: number;

    /**
     * Nome do arquivo.
     */
    name: string;

    /**
     * Tipo MIME do arquivo.
     */
    mime_type: string;

    /**
     * Tamanho do arquivo em bytes.
     */
    size: number;

    /**
     * Tipo de diretório onde o arquivo está armazenado.
     */
    dir_type: FileDirType;

    /**
     * Data e hora em que o arquivo foi criado.
     */
    created_at: Date;

    public_id: string;
}