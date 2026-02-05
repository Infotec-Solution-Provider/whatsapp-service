import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import * as fs from "fs/promises";
import * as path from "path";
import CreateMessageDto from "../dtos/create-message.dto";
import internalChatsService from "../services/internal-chats.service";
import messagesService from "../services/messages.service";
import messagesDistributionService from "../services/messages-distribution.service";

interface LogFileData {
	startTime: string;
	endTime: string;
	duration: number;
	logEntries: string[];
	input: {
		_data: any;
		id: {
			fromMe: boolean;
			remote: string;
			id: string;
			participant?: string;
			_serialized: string;
		};
		body: string;
		type: string;
		timestamp: number;
		from: string;
		to: string;
		author?: string;
		hasQuotedMsg: boolean;
		mentionedIds: string[];
		[key: string]: any;
	};
	output: CreateMessageDto[];
	error: any;
	errorMessage: string;
}

/**
 * Rotina para recuperar mensagens perdidas de arquivos de log
 * @param logFilePath Caminho para o arquivo .json ou diretório contendo os logs
 * @param instance Nome da instância (ex: "nunes")
 * @param clientId ID do cliente WhatsApp
 */
export async function recoverLostMessages(
	logFilePath: string,
	instance: string,
	clientId: number
): Promise<{ recovered: number; failed: number; errors: string[] }> {
	const stats = {
		recovered: 0,
		failed: 0,
		errors: [] as string[]
	};

	try {
		const fileStats = await fs.stat(logFilePath);
		let logFiles: string[] = [];

		if (fileStats.isDirectory()) {
			// Se for um diretório, busca todos os arquivos .json
			const files = await fs.readdir(logFilePath);
			logFiles = files.filter((f) => f.endsWith(".json")).map((f) => path.join(logFilePath, f));
		} else if (logFilePath.endsWith(".json")) {
			// Se for um arquivo único
			logFiles = [logFilePath];
		} else {
			Logger.error(`Formato de arquivo não suportado: ${logFilePath}`);
			return stats;
		}

		Logger.info(`Processando ${logFiles.length} arquivo(s) de log...`);

		for (const file of logFiles) {
			try {
				await processLogFile(file, instance, clientId, stats);
			} catch (err) {
				const error = `Erro ao processar arquivo ${file}: ${sanitizeErrorMessage(err)}`;
				Logger.error(error);
				stats.errors.push(error);
				stats.failed++;
			}
		}

		Logger.info(`Recuperação concluída: ${stats.recovered} recuperadas, ${stats.failed} falharam`);
	} catch (err) {
		const errorMsg = sanitizeErrorMessage(err) || "Erro desconhecido";
		Logger.error(`Erro ao ler arquivos de log: ${errorMsg}`);
		stats.errors.push(errorMsg);
	}

	return stats;
}

async function processLogFile(
	filePath: string,
	instance: string,
	clientId: number,
	stats: { recovered: number; failed: number; errors: string[] }
) {
	const content = await fs.readFile(filePath, "utf-8");
	const logData: LogFileData = JSON.parse(content);

	// Verifica se há erro e se a mensagem foi parseada
	if (!logData.errorMessage || !logData.output || logData.output.length === 0) {
		Logger.debug(`Arquivo ${path.basename(filePath)} não contém mensagem perdida válida`);
		return;
	}

	const parsedMsg = logData.output[0];
	const isGroup = logData.input.from.includes("@g.us");

	Logger.info(`Recuperando mensagem: ${logData.input.id._serialized}`);

	if (!parsedMsg) {
		Logger.error(`Mensagem parseada não encontrada no arquivo ${path.basename(filePath)}`);
		stats.failed++;
		return;
	}

	try {
		// Extrai o nome do contato dos logs
		let contactName = logData.input._data?.notifyName || parsedMsg.from;

		if (isGroup) {
			const groupId = logData.input.from.replace("@g.us", "");
			await internalChatsService.receiveMessage(instance, groupId, parsedMsg, contactName);
			Logger.info(`✓ Mensagem de grupo recuperada: ${logData.input.id._serialized}`);
		} else {
			const savedMsg = await messagesService.insertMessage(parsedMsg);
			await messagesDistributionService.processMessage(instance, clientId, savedMsg, contactName);
			Logger.info(`✓ Mensagem individual recuperada: ${logData.input.id._serialized}`);
		}

		stats.recovered++;
	} catch (err) {
		const error = `Falha ao recuperar ${logData.input.id._serialized}: ${sanitizeErrorMessage(err)}`;
		Logger.error(error);
		stats.errors.push(error);
		stats.failed++;
	}
}

/**
 * Função helper para executar a rotina de recuperação via linha de comando
 */
export async function runRecoveryFromCLI() {
	const args = process.argv.slice(2);

	if (args.length < 3) {
		console.log("Uso: ts-node recover-lost-messages.routine.ts <caminho-logs> <instance> <clientId>");
		console.log("Exemplo: ts-node recover-lost-messages.routine.ts ./logs nunes 2");
		process.exit(1);
	}

	const [logPath, instance, clientIdStr] = args;

	if (!logPath || !instance || !clientIdStr) {
		console.error("Todos os argumentos são obrigatórios");
		process.exit(1);
	}

	const clientId = parseInt(clientIdStr, 10);

	if (isNaN(clientId)) {
		console.error("clientId deve ser um número");
		process.exit(1);
	}

	const stats = await recoverLostMessages(logPath, instance, clientId);

	console.log("\n=== Resultado da Recuperação ===");
	console.log(`Mensagens recuperadas: ${stats.recovered}`);
	console.log(`Mensagens com falha: ${stats.failed}`);

	if (stats.errors.length > 0) {
		console.log("\nErros:");
		stats.errors.forEach((err, idx) => {
			console.log(`${idx + 1}. ${err}`);
		});
	}

	process.exit(stats.failed > 0 ? 1 : 0);
}

// Permite execução direta
if (require.main === module) {
	runRecoveryFromCLI().catch((err) => {
		console.error("Erro fatal:", err);
		process.exit(1);
	});
}
