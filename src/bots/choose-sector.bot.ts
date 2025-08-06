import { WppChat, WppContact, WppMessage } from "@prisma/client";
import whatsappService from "../services/whatsapp.service";
import sectorsService from "../services/sectors.service";
import messagesDistributionService from "../services/messages-distribution.service";
import instancesService from "../services/instances.service";
import { SocketEventType, User } from "@in.pulse-crm/sdk";
import socketService from "../services/socket.service";
import prismaService from "../services/prisma.service";

class ChooseSectorBot {
	private readonly running: { step: number; chatId: number }[] = [];
	private readonly runningOperadorOld: { operadorOldId: number; chatId: number }[] = [];
	private chatState = new Map<string, { operadores: User[]; setor: any }>();

	private getRunningStep(chatId: number) {
		const running = this.running.find((r) => r.chatId === chatId);
		console.log(`[Step] getRunningStep -> chatId: ${chatId}, currentStep: ${running?.step ?? "undefined (default to 1)"}`);
		if (!running) return this.setRunningStep(chatId, 1);
		return running.step;
	}

	public forceStep(chatId: number, step: number, operadorOldId: number) {
		console.log(`[Force Step] chatId: ${chatId}, step: ${step}, operadorOldId: ${operadorOldId}`);
		this.setRunningStep(chatId, step);
		this.setOperadorOld(chatId, operadorOldId);
	}

	private getOperadorOld(chatId: number) {
		const running = this.runningOperadorOld.find((r) => r.chatId === chatId);
		console.log(`[Get Operador Old] chatId: ${chatId}, operadorOldId: ${running?.operadorOldId}`);
		return running?.operadorOldId ?? null;
	}

	private setOperadorOld(chatId: number, operadorOldId: number) {
		const running = this.runningOperadorOld.find((r) => r.chatId === chatId);
		if (running) {
			running.operadorOldId = operadorOldId;
		} else {
			this.runningOperadorOld.push({ chatId, operadorOldId });
		}
		console.log(`[Set Operador Old] chatId: ${chatId}, operadorOldId: ${operadorOldId}`);
		return operadorOldId;
	}

	private setRunningStep(chatId: number, step: number) {
		const running = this.running.find((r) => r.chatId === chatId);
		if (running) {
			running.step = step;
		} else {
			this.running.push({ chatId, step });
		}
		console.log(`[Set Running Step] chatId: ${chatId}, step: ${step}`);
		return step;
	}

	private removeRunningStep(chatId: number) {
		this.running = this.running.filter((r) => r.chatId !== chatId);
		this.runningOperadorOld = this.runningOperadorOld.filter((r) => r.chatId !== chatId);
		this.chatState.delete(String(chatId));
		console.log(`[Remove Running State] chatId: ${chatId}`);
	}

	public async processMessage(chat: WppChat, contact: WppContact, message: WppMessage) {
		console.log(`📩 [Bot] processMessage - chatId: ${chat.id}, message: "${message.body}"`);
		const currentStep = this.getRunningStep(chat.id);

		const sectors = await sectorsService.getSectors(chat.instance, { receiveChats: true });
		if (!sectors || sectors.length === 0) {
			console.error(`❌ Nenhum setor encontrado para a instância ${chat.instance}`);
			throw new Error(`No sectors found for instance ${chat.instance}`);
		}

		let chooseSectorMessage = `Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}`;
		if (chat.instance === "nunes") {
			chooseSectorMessage =
				`Olá,\nEstamos felizes por você entrar em contato com a Metalúrgica Nunes, Usinagem de Precisão. ` +
				`Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}`;
		}

		switch (currentStep) {
			case 1:
				this.setRunningStep(chat.id, 2);
				await whatsappService.sendBotMessage(message.from, { chat, text: chooseSectorMessage });
				break;

			case 2: {
				const input = message.body.trim();
				const isNumber = /^\d+$/.test(input);
				if (!isNumber) {
					await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Tente novamente." });
					return;
				}

				const chooseOption = Number(input);
				if (chooseOption > 0 && chooseOption <= sectors.length) {
					const chooseSector = sectors[chooseOption - 1];
					console.log(`[Setor escolhido] ${chooseSector.name}`);

					let operadores = await instancesService.executeQuery<User[]>(chat.instance, `SELECT * FROM operadores WHERE SETOR = ${chooseSector.id} ORDER BY NOME`, []);

					if (chat.instance === "nunes" && chooseSector.name === "Financeiro") {
						operadores = operadores.filter((o) => o.NOME !== "Andréia");
					}
					if (chat.instance === "nunes" && chooseSector.name === "Compras") {
						operadores = operadores.filter((o) => o.NOME !== "Jorel");
					}

					const answer = `Escolha com quem deseja falar\n${operadores.map((s, i) => `${i + 1} - ${s.NOME}`).join("\n")}\n0 - Voltar à escolha de setor`;
					await whatsappService.sendBotMessage(message.from, { chat, text: answer });
					this.chatState.set(String(chat.id), { operadores, setor: chooseSector });
					this.setRunningStep(chat.id, 3);
				} else {
					await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Tente novamente." });
				}
				break;
			}

			case 3: {
				const input = message.body.trim();
				const isNumber = /^\d+$/.test(input);
				if (!isNumber) {
					await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Tente novamente." });
					return;
				}

				const chooseOption = Number(input);
				const state = this.chatState.get(String(chat.id));
				const operadores = state?.operadores || [];
				const setor = state?.setor;

				if (chooseOption === 0) {
					await whatsappService.sendBotMessage(message.from, { chat, text: "Tudo bem, voltando para a escolha de setor..." });
					this.chatState.delete(String(chat.id));
					this.setRunningStep(chat.id, 2);
					await whatsappService.sendBotMessage(message.from, { chat, text: chooseSectorMessage });
					return;
				}

				if (chooseOption > 0 && chooseOption <= operadores.length) {
					const operador = operadores[chooseOption - 1];
					const notify = `Estamos te redirecionando para o atendente ${operador.NOME}.\nVocê será atendido em breve!`;
					const greet = `*${operador.NOME}*: Olá, em que posso ajudar?`;

					await whatsappService.sendBotMessage(message.from, { chat, text: notify });
					await whatsappService.sendBotMessage(message.from, { chat, text: greet });

					await messagesDistributionService.transferChatOperator(setor, operador, contact, chat);
					this.removeRunningStep(chat.id);
				} else {
					await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Tente novamente." });
				}
				break;
			}

			case 4: {
				const option = Number(message.body.trim().replace(/[^0-9]/g, ""));
				switch (option) {
					case 1:
						await whatsappService.sendBotMessage(message.from, { chat, text: "Certo, retornando ao menu de setores..." });
						this.setRunningStep(chat.id, 2);
						await whatsappService.sendBotMessage(message.from, { chat, text: chooseSectorMessage });
						break;
					case 2:
						await whatsappService.sendBotMessage(message.from, { chat, text: "Atendimento encerrado. Caso precise de algo, estamos à disposição!" });
						await prismaService.wppChat.update({ where: { id: chat.id }, data: { isFinished: true, finishedAt: new Date(), finishedBy: null } });
						await messagesDistributionService.addSystemMessage(chat, `Atendimento finalizado pelo cliente devido inatividade do operador.`);
						await socketService.emit(SocketEventType.WppChatFinished, `${chat.instance}:chat:${chat.id}`, { chatId: chat.id });
						this.removeRunningStep(chat.id);
						break;
					case 3:
						await whatsappService.sendBotMessage(message.from, { chat, text: "Tudo bem! Vamos continuar aguardando o atendimento." });
						const userId = this.getOperadorOld(chat.id);
						await prismaService.wppChat.update({ where: { id: chat.id }, data: { userId, botId: null } });
						this.removeRunningStep(chat.id);
						break;
					default:
						await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Responda apenas com o número da opção desejada." });
						break;
				}
				break;
			}

			default:
				console.warn(`[Bot] Etapa desconhecida: ${currentStep}`);
				break;
		}
	}
}

export default new ChooseSectorBot();