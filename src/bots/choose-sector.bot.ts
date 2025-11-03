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
	private readonly runningOperadorOld: {
		operadorOldId: number;
		chatId: number;
	}[] = [];
	private chatState = new Map<string, { operadores: User[]; setor: any }>();

	private getRunningStep(chatId: number) {
		const running = this.running.find((r) => r.chatId === chatId);
		if (!running) return this.setRunningStep(chatId, 1);
		return running.step;
	}

	public forceStep(chatId: number, step: number, operadorOldId: number) {
		this.setRunningStep(chatId, step);
		this.setOperadorOld(chatId, operadorOldId);
	}

	private getOperadorOld(chatId: number) {
		const running = this.runningOperadorOld.find((r) => r.chatId === chatId);
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

		return operadorOldId;
	}

	private setRunningStep(chatId: number, step: number) {
		const running = this.running.find((r) => r.chatId === chatId);
		if (running) {
			running.step = step;
		} else {
			this.running.push({ chatId, step });
		}

		return step;
	}

	private removeRunningStep(chatId: number) {
		const index = this.running.findIndex((r) => r.chatId === chatId);
		if (index !== -1) {
			this.running.splice(index, 1);
		}
	}

	public async processMessage(chat: WppChat, contact: WppContact, message: WppMessage) {
		const currentStep = this.getRunningStep(chat.id);

		const sectors = await sectorsService.getSectors(chat.instance, {
			receiveChats: true
		});
		if (!sectors) {
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
				whatsappService.sendBotMessage(message.from, message.clientId!, {
					chat,
					text: chooseSectorMessage
				});
				break;

			case 2:
				const chooseOption = Number(message.body.trim().replace(/[^0-9]/g, ""));
				const isValid = chooseOption > 0 && chooseOption <= sectors.length;

				const chooseSector = isValid ? sectors[chooseOption - 1] : null;
				if (chooseSector) {
					let query = `SELECT * FROM operadores WHERE SETOR = ${chooseSector.id} ORDER BY NOME`;
					let operadores = await instancesService.executeQuery<Array<User>>(chat.instance, query, []);

					if (chat.instance === "nunes" && chooseSector.name === "Financeiro") {
						operadores = operadores.filter((o) => o.NOME !== "Andréia");
					}
					if (chat.instance === "nunes" && chooseSector.name === "Compras") {
						operadores = operadores.filter((o) => o.NOME !== "Jorel");
					}

					const answer = `Escolha com quem deseja falar\n${operadores.map((s, i) => `${i + 1} - ${s.NOME}`).join("\n")}\n0 - Voltar à escolha de setor`;
					this.setRunningStep(chat.id, 3);
					this.chatState.set(String(chat.id), {
						operadores,
						setor: chooseSector
					});
					whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: answer
					});
				} else {
					whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: "Opção inválida! Tente novamente."
					});
				}
				break;

			case 3:
				const chooseOptionOp = Number(message.body.trim().replace(/[^0-9]/g, ""));
				const state = this.chatState.get(String(chat.id));
				const operadores = state?.operadores || [];
				const sector = state?.setor;

				if (chooseOptionOp === 0) {
					this.setRunningStep(chat.id, 2);
					whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: "Tudo bem, voltando para a escolha de setor..."
					});
					setTimeout(() => {
						whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: chooseSectorMessage
						});
					}, 200);
					break;
				}

				const isValids = chooseOptionOp > 0 && chooseOptionOp <= operadores.length;
				const chooseOp = isValids ? operadores[chooseOptionOp - 1] : null;

				if (chooseOp) {
					const answer = `Estamos te redirecionado para o atendente ${chooseOp.NOME}.\nVocê será atendido em breve!`;
					const operatoranswer = `*${chooseOp.NOME}*: Olá, em que posso ajudar?`;

					this.removeRunningStep(chat.id);
					await messagesDistributionService.transferChatOperator(sector, chooseOp, contact, chat);
					whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: answer
					});
					setTimeout(() => {
						whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: operatoranswer
						});
					}, 200);
				} else {
					whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: "Opção inválida! Tente novamente."
					});
				}
				break;

			case 4:
				const option = Number(message.body.trim().replace(/[^0-9]/g, ""));

				switch (option) {
					case 1:
						this.setRunningStep(chat.id, 2);

						whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: "Certo, retornando ao menu de setores..."
						});
						setTimeout(() => {
							whatsappService.sendBotMessage(message.from, message.clientId!, {
								chat,
								text: chooseSectorMessage
							});
						}, 200);
						break;
					case 2:
						this.removeRunningStep(chat.id);

						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: {
								isFinished: true,
								finishedAt: new Date(),
								finishedBy: null
							}
						});
						const finishMsg = `Atendimento finalizado pelo cliente devido inatividade do operador.`;
						await messagesDistributionService.addSystemMessage(chat, finishMsg);
						await socketService.emit(SocketEventType.WppChatFinished, `${chat.instance}:chat:${chat.id}`, {
							chatId: chat.id
						});
						whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: "Atendimento encerrado. Caso precise de algo, estamos à disposição!"
						});
						break;

					case 3:
						this.removeRunningStep(chat.id);
						const user = this.getOperadorOld(chat.id);
						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: { userId: user, botId: null }
						});

						whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: "Tudo bem! Vamos continuar aguardando o atendimento."
						});
						break;

					default:
						whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: "Opção inválida! Responda apenas com o número da opção desejada."
						});
						break;
				}
				break;

			default:
				console.warn(`[Bot] Etapa desconhecida: ${currentStep}`);
				break;
		}
	}

	public async askIfWantsToBackToMenu(clientId: number, chat: WppChat, contact: WppContact) {
		await whatsappService.sendBotMessage(contact.phone, clientId, {
			chat,
			text: [
				"Deseja voltar ao menu de setores, finalizar conversa ou aguardar resposta do contato?",
				"",
				"*1* - Voltar ao menu de setores",
				"*2* - Finalizar conversa",
				"*3* - Aguardar resposta do contato",
				"",
				"*Responda apenas com o número da opção desejada.*"
			].join("\n")
		});
		await prismaService.wppChat.update({
			where: { id: chat.id },
			data: { botId: 1 }
		});

		this.forceStep(chat.id, 4, chat.userId || 0);
	}

	public async checkIfAlreadyAskedToBackToMenu(chat: WppChat) {
		const currentStep = this.getRunningStep(chat.id);

		return currentStep >= 2;
	}

	async shouldActivate(chat: WppChat): Promise<boolean> {
		return chat.instance === "nunes";
	}
}

export default new ChooseSectorBot();
