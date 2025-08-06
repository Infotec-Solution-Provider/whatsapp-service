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
		if (!running) return this.setRunningStep(chatId, 1);
		return running.operadorOldId;
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
		const index = this.running.findIndex((r) => r.chatId === chatId);
		if (index !== -1) {
			this.running.splice(index, 1);
		}
		console.log(`[Remove Running Step] chatId: ${chatId}`);
	}

	public async processMessage(chat: WppChat, contact: WppContact, message: WppMessage) {
		console.log(`📩 [Bot] processMessage - chatId: ${chat.id}, message: "${message.body}"`);
		const currentStep = this.getRunningStep(chat.id);

		console.log(`[Step ${currentStep}] Recuperando setores da instância: ${chat.instance}`);
		const sectors = await sectorsService.getSectors(chat.instance, { receiveChats: true });
		if (!sectors) {
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
				console.log(`[Step 1] Enviando mensagem de escolha de setor`);
				await whatsappService.sendBotMessage(message.from, { chat, text: chooseSectorMessage });
				break;

			case 2:
				const chooseOption = Number(message.body.trim().replace(/[^0-9]/g, ""));
				const isValid = chooseOption > 0 && chooseOption <= sectors.length;
				console.log(`[Step 2] Opção recebida: ${chooseOption}, válida: ${isValid}`);

				const chooseSector = isValid ? sectors[chooseOption - 1] : null;
				if (chooseSector) {
					console.log(`[Step 2] Setor escolhido: ${chooseSector.name} (ID: ${chooseSector.id})`);
					let query = `SELECT * FROM operadores WHERE SETOR = ${chooseSector.id} ORDER BY NOME`;
					let operadores = await instancesService.executeQuery<Array<User>>(chat.instance, query, []);
					console.log(`[Step 2] Operadores encontrados: ${operadores.map(o => o.NOME).join(", ")}`);

					if (chat.instance === "nunes" && chooseSector.name === "Financeiro") {
						operadores = operadores.filter((o) => o.NOME !== "Andréia");
						console.log(`[Step 2] Andréia removida dos operadores do setor Financeiro`);
					}
					if (chat.instance === "nunes" && chooseSector.name === "Compras") {
						operadores = operadores.filter((o) => o.NOME !== "Jorel");
						console.log(`[Step 2] Jorel removido dos operadores do setor Compras`);
					}

					const answer = `Escolha com quem deseja falar\n${operadores.map((s, i) => `${i + 1} - ${s.NOME}`).join("\n")}\n0 - Voltar à escolha de setor`;
					await whatsappService.sendBotMessage(message.from, { chat, text: answer });
					this.chatState.set(String(chat.id), { operadores, setor: chooseSector });
					this.setRunningStep(chat.id, 3);
				} else {
					console.warn(`[Step 2] Opção inválida`);
					await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Tente novamente." });
				}
				break;

			case 3:
				const chooseOptionOp = Number(message.body.trim().replace(/[^0-9]/g, ""));
				const state = this.chatState.get(String(chat.id));
				const operadores = state?.operadores || [];
				const sector = state?.setor;

				if (chooseOptionOp === 0) {
					console.log(`[Step 3] Usuário optou por voltar à escolha de setor`);
					await whatsappService.sendBotMessage(message.from, { chat, text: "Tudo bem, voltando para a escolha de setor..." });
					await whatsappService.sendBotMessage(message.from, { chat, text: chooseSectorMessage });
					this.setRunningStep(chat.id, 2);
					break;
				}

				const isValids = chooseOptionOp > 0 && chooseOptionOp <= operadores.length;
				const chooseOp = isValids ? operadores[chooseOptionOp - 1] : null;

				if (chooseOp) {
					console.log(`[Step 3] Operador escolhido: ${chooseOp.NOME}`);
					const answer = `Estamos te redirecionado para o atendente ${chooseOp.NOME}.\nVocê será atendido em breve!`;
					const operatoranswer = `*${chooseOp.NOME}*: Olá, em que posso ajudar?`;

					await whatsappService.sendBotMessage(message.from, { chat, text: answer });
					await whatsappService.sendBotMessage(message.from, { chat, text: operatoranswer });

					console.log(`[Step 3] Transferindo chat para operador ${chooseOp.NOME}`);
					await messagesDistributionService.transferChatOperator(sector, chooseOp, contact, chat);

					this.removeRunningStep(chat.id);
				} else {
					console.warn(`[Step 3] Opção inválida para operador`);
					await whatsappService.sendBotMessage(message.from, { chat, text: "Opção inválida! Tente novamente." });
				}
				break;

			case 4:
				const option = Number(message.body.trim().replace(/[^0-9]/g, ""));
				console.log(`[Step 4] Opção recebida: ${option}`);

				switch (option) {
					case 1:
						console.log(`[Step 4] Retornando ao menu de setores`);
						await whatsappService.sendBotMessage(message.from, { chat, text: "Certo, retornando ao menu de setores..." });
						await whatsappService.sendBotMessage(message.from, { chat, text: chooseSectorMessage });
						this.setRunningStep(chat.id, 2);
						break;

					case 2:
						console.log(`[Step 4] Encerrando atendimento`);
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Atendimento encerrado. Caso precise de algo, estamos à disposição!",
						});
						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: { isFinished: true, finishedAt: new Date(), finishedBy: null }
						});
						const finishMsg = `Atendimento finalizado pelo cliente devido inatividade do operador.`;
						await messagesDistributionService.addSystemMessage(chat, finishMsg);
						await socketService.emit(SocketEventType.WppChatFinished, `${chat.instance}:chat:${chat.id}`, { chatId: chat.id });
						this.removeRunningStep(chat.id);
						break;

					case 3:
						console.log(`[Step 4] Cliente deseja continuar aguardando`);
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Tudo bem! Vamos continuar aguardando o atendimento.",
						});
						this.removeRunningStep(chat.id);
						const user = this.getOperadorOld(chat.id);
						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: { userId: user, botId: null }
						});
						break;

					default:
						console.warn(`[Step 4] Opção inválida`);
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Opção inválida! Responda apenas com o número da opção desejada.",
						});
						break;
				}
				break;

			default:
				console.warn(`[Bot] Etapa desconhecida: ${currentStep}`);
				break;
		}
	}
}

export default new ChooseSectorBot();
