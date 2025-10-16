import { FileDirType, SessionData } from "@in.pulse-crm/sdk";
import { ReadyMessage } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import filesService from "./files.service";
import prismaService from "./prisma.service";
import ProcessingLogger from "../utils/processing-logger";
import generateUID from "../utils/generate-uid";

interface CreateReadyMessageDto {
	sectorId: number;
	title: string;
	message: string;
	onlyAdmin?: boolean;
}

interface UpdateReadyMessageDto {
	title?: string;
	message?: string;
	onlyAdmin?: boolean;
}

class ReadyMessagesService {
	/**
	 * Cria uma nova mensagem pronta
	 */
	public async createReadyMessage(
		session: SessionData,
		data: CreateReadyMessageDto,
		file: Express.Multer.File | null = null
	): Promise<ReadyMessage> {
		const processId = generateUID();
		const process = new ProcessingLogger(session.instance, "ready-message/create", processId, {
			sessionData: { userId: session.userId, sectorId: session.sectorId, instance: session.instance },
			inputData: data,
			hasFile: !!file,
			fileInfo: file ? { 
				originalname: file.originalname, 
				mimetype: file.mimetype, 
				size: file.size 
			} : null
		});

		try {
			process.log("Iniciando criação de mensagem pronta");
			
			let fileId: number | undefined;
			let fileName: string | undefined;

			// Upload do arquivo se fornecido
			if (file) {
				process.log(`Iniciando upload de arquivo: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);
				
				const fileData = await filesService.uploadFile({
					instance: session.instance,
					fileName: file.originalname,
					buffer: file.buffer,
					mimeType: file.mimetype,
					dirType: FileDirType.PUBLIC
				});

				fileId = fileData.id;
				fileName = fileData.name;
				
				process.log(`Arquivo enviado com sucesso`, { fileId, fileName });
			} else {
				process.log("Nenhum arquivo fornecido");
			}

			// Criar mensagem pronta no banco
			process.log("Criando mensagem pronta no banco de dados");
			
			const readyMessage = await prismaService.readyMessage.create({
				data: {
					instance: session.instance,
					sectorId: data.sectorId,
					title: data.title,
					message: data.message,
					onlyAdmin: data.onlyAdmin || false,
					fileId: fileId ?? null,
					fileName: fileName ?? null
				}
			});

			process.log("Mensagem pronta criada com sucesso", { readyMessageId: readyMessage.id });
			process.success(readyMessage);

			return readyMessage;
		} catch (error) {
			process.log(`Erro durante criação de mensagem pronta: ${error instanceof Error ? error.message : String(error)}`);
			process.failed(error);
			throw error;
		}
	}

	/**
	 * Lista todas as mensagens prontas
	 * Se não for TI (setor 3), filtra por setor
	 */
	public async getReadyMessages(session: SessionData): Promise<ReadyMessage[]> {
		const isTI = session.sectorId === 3;

		const readyMessages = await prismaService.readyMessage.findMany({
			where: {
				instance: session.instance,
				...(isTI ? {} : { sectorId: session.sectorId })
			},
			orderBy: {
				title: "asc"
			}
		});

		return readyMessages;
	}

	/**
	 * Busca uma mensagem pronta por ID
	 */
	public async getReadyMessageById(session: SessionData, id: number): Promise<ReadyMessage> {
		const readyMessage = await prismaService.readyMessage.findFirst({
			where: {
				id,
				instance: session.instance
			}
		});

		if (!readyMessage) {
			throw new NotFoundError("Mensagem pronta não encontrada!");
		}

		return readyMessage;
	}

	/**
	 * Atualiza uma mensagem pronta
	 */
	public async updateReadyMessage(
		session: SessionData,
		readyMessageId: number,
		data: UpdateReadyMessageDto,
		file?: Express.Multer.File
	): Promise<ReadyMessage> {
		const processId = generateUID();
		const process = new ProcessingLogger(session.instance, "ready-message/update", processId, {
			sessionData: { userId: session.userId, sectorId: session.sectorId, instance: session.instance },
			readyMessageId,
			inputData: data,
			hasFile: !!file,
			fileInfo: file ? { 
				originalname: file.originalname, 
				mimetype: file.mimetype, 
				size: file.size 
			} : null
		});

		try {
			process.log(`Iniciando atualização de mensagem pronta ID: ${readyMessageId}`);

			// Verificar se a mensagem existe
			process.log("Verificando se mensagem existe");
			const existingMessage = await this.getReadyMessageById(session, readyMessageId);
			process.log("Mensagem encontrada", { existingId: existingMessage.id, existingTitle: existingMessage.title });

			const updateData: Partial<ReadyMessage> = {};

			// Atualizar campos se fornecidos
			if (data.title !== undefined) {
				updateData.title = data.title;
				process.log(`Atualizando título: ${existingMessage.title} -> ${data.title}`);
			}

			if (data.message !== undefined) {
				updateData.message = data.message;
				process.log("Atualizando conteúdo da mensagem");
			}

			if (data.onlyAdmin !== undefined) {
				updateData.onlyAdmin = data.onlyAdmin;
				process.log(`Atualizando onlyAdmin: ${existingMessage.onlyAdmin} -> ${data.onlyAdmin}`);
			}

			// Upload de novo arquivo se fornecido
			if (file) {
				process.log(`Iniciando upload de novo arquivo: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);
				
				const fileData = await filesService.uploadFile({
					instance: session.instance,
					fileName: file.originalname,
					buffer: file.buffer,
					mimeType: file.mimetype,
					dirType: FileDirType.PUBLIC
				});

				updateData.fileId = fileData.id;
				updateData.fileName = fileData.name;
				
				process.log(`Novo arquivo enviado com sucesso`, { 
					oldFileId: existingMessage.fileId,
					newFileId: fileData.id, 
					newFileName: fileData.name 
				});
			}

			// Validar se há algo para atualizar
			if (Object.keys(updateData).length === 0) {
				process.log("Nenhum campo para atualizar fornecido");
				process.failed("Nenhum campo para atualizar");
				throw new BadRequestError("Você deve enviar pelo menos um campo para atualizar.");
			}

			process.log("Atualizando mensagem no banco de dados", { fieldsToUpdate: Object.keys(updateData) });

			// Atualizar no banco
			const updatedMessage = await prismaService.readyMessage.update({
				where: { id: readyMessageId },
				data: updateData
			});

			process.log("Mensagem atualizada com sucesso", { updatedMessageId: updatedMessage.id });
			process.success(updatedMessage);

			return updatedMessage;
		} catch (error) {
			process.log(`Erro durante atualização de mensagem pronta: ${error instanceof Error ? error.message : String(error)}`);
			process.failed(error);
			throw error;
		}
	}

	/**
	 * Deleta uma mensagem pronta
	 */
	public async deleteReadyMessage(session: SessionData, id: number): Promise<void> {
		const processId = generateUID();
		const process = new ProcessingLogger(session.instance, "ready-message/delete", processId, {
			sessionData: { userId: session.userId, sectorId: session.sectorId, instance: session.instance },
			readyMessageId: id
		});

		try {
			process.log(`Iniciando exclusão de mensagem pronta ID: ${id}`);

			// Verificar se existe
			process.log("Verificando se mensagem existe");
			const existingMessage = await this.getReadyMessageById(session, id);
			process.log("Mensagem encontrada", { 
				id: existingMessage.id, 
				title: existingMessage.title,
				hasFile: !!existingMessage.fileId
			});

			// Deletar
			process.log("Deletando mensagem do banco de dados");
			await prismaService.readyMessage.delete({
				where: { id }
			});

			process.log("Mensagem deletada com sucesso");
			process.success({ deletedId: id });
		} catch (error) {
			process.log(`Erro durante exclusão de mensagem pronta: ${error instanceof Error ? error.message : String(error)}`);
			process.failed(error);
			throw error;
		}
	}
}

export default new ReadyMessagesService();
