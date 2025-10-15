import { FileDirType, SessionData } from "@in.pulse-crm/sdk";
import { ReadyMessage } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@rgranatodutra/http-errors";
import filesService from "./files.service";
import prismaService from "./prisma.service";

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
		let fileId: number | undefined;
		let fileName: string | undefined;


		console.log(data);
		
		// Upload do arquivo se fornecido
		if (file) {
			const fileData = await filesService.uploadFile({
				instance: session.instance,
				fileName: file.originalname,
				buffer: file.buffer,
				mimeType: file.mimetype,
				dirType: FileDirType.PUBLIC
			});

			fileId = fileData.id;
			fileName = fileData.name;
		}

		// Criar mensagem pronta no banco
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

		return readyMessage;
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
		// Verificar se a mensagem existe
		await this.getReadyMessageById(session, readyMessageId);

		const updateData: Partial<ReadyMessage> = {};

		// Atualizar campos se fornecidos
		if (data.title !== undefined) {
			updateData.title = data.title;
		}

		if (data.message !== undefined) {
			updateData.message = data.message;
		}

		if (data.onlyAdmin !== undefined) {
			updateData.onlyAdmin = data.onlyAdmin;
		}

		// Upload de novo arquivo se fornecido
		if (file) {
			const fileData = await filesService.uploadFile({
				instance: session.instance,
				fileName: file.originalname,
				buffer: file.buffer,
				mimeType: file.mimetype,
				dirType: FileDirType.PUBLIC
			});

			updateData.fileId = fileData.id;
			updateData.fileName = fileData.name;
		}

		// Validar se há algo para atualizar
		if (Object.keys(updateData).length === 0) {
			throw new BadRequestError("Você deve enviar pelo menos um campo para atualizar.");
		}

		// Atualizar no banco
		const updatedMessage = await prismaService.readyMessage.update({
			where: { id: readyMessageId },
			data: updateData
		});

		return updatedMessage;
	}

	/**
	 * Deleta uma mensagem pronta
	 */
	public async deleteReadyMessage(session: SessionData, id: number): Promise<void> {
		// Verificar se existe
		await this.getReadyMessageById(session, id);

		// Deletar
		await prismaService.readyMessage.delete({
			where: { id }
		});
	}
}

export default new ReadyMessagesService();
