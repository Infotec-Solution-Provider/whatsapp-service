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
		console.log("Getting Running step for chat id", chatId);

		const running = this.running.find((r) => r.chatId === chatId);
		console.log("findRunning for chatId " + chatId, ": ", running)

		if (!running) {
			return this.setRunningStep(chatId, 1);
		}
		return running.step;
	}

	public forceStep(chatId: number, step: number, operadorOldId: number) {
		this.setRunningStep(chatId, step);
		this.setOperadorOld(chatId, operadorOldId);
	}

	private getOperadorOld(chatId: number) {
		const running = this.runningOperadorOld.find(
			(r) => r.chatId === chatId
		);
		if (!running) {
			return this.setRunningStep(chatId, 1);
		}
		return running.operadorOldId;
	}

	private setOperadorOld(chatId: number, operadorOldId: number) {
		const running = this.runningOperadorOld.find(
			(r) => r.chatId === chatId
		);
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

	public async processMessage(
		chat: WppChat,
		contact: WppContact,
		message: WppMessage
	) {
		const currentStep = this.getRunningStep(chat.id);
		console.log(`chatId: ${chat.id} || currentStep: ${currentStep}`);

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
				await whatsappService.sendBotMessage(message.from, {
					chat,
					text: chooseSectorMessage,
					quotedId: message.id
				});

				break;
			case 2:
				const chooseOption = Number(
					message.body.trim().replace(/[^0-9]/g, "")
				);

				console.log("chooseOption", chooseOption);

				const isValid =
					chooseOption > 0 && chooseOption <= sectors.length;
				console.log("isValid", isValid)

				const chooseSector = isValid && sectors[+chooseOption - 1];
				console.log("chooseSector", chooseSector);

				if (chooseSector) {
					let setorId = sectors[+chooseOption - 1];
					let query = `SELECT * FROM operadores WHERE SETOR = ${setorId?.id} order by NOME`;

					let operadores = await instancesService.executeQuery<
						Array<User>
					>(chat.instance, query, []);

					if (
						setorId?.name === "Financeiro" &&
						chat.instance === "nunes"
					) {
						operadores = operadores.filter(
							(o) => o.NOME !== "Andréia"
						);
					}
					if (
						setorId?.name === "Compras" &&
						chat.instance === "nunes"
					) {
						operadores = operadores.filter(
							(o) => o.NOME !== "Jorel"
						);
					}

					const answer =
						`Escolha com quem deseja falar\n${operadores.map((s, i) => `${i + 1} - ${s.NOME}`).join("\n")}` +
						`\n0 - Voltar à escolha de setor`;

					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: answer,
						quotedId: message.id
					});
					this.chatState.set(String(chat.id), {
						operadores,
						setor: chooseSector
					});
					this.setRunningStep(chat.id, 3);
					break;
				}
				await whatsappService.sendBotMessage(message.from, {
					chat,
					text: "Opção inválida! Tente novamente.",
					quotedId: message.id
				});
				break;
			case 3:
				const chooseOptionOp = Number(
					message.body.trim().replace(/[^0-9]/g, "")
				);
				if (chooseOptionOp === 0) {
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: "Tudo bem, voltando para a escolha de setor...",
						quotedId: message.id
					});
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: chooseSectorMessage,
						quotedId: message.id
					});
					this.setRunningStep(chat.id, 2);
					break;
				}
				const state = this.chatState.get(String(chat.id));
				const operadores = state?.operadores || [];
				const sector = state?.setor;
				const isValids =
					chooseOptionOp > 0 && chooseOptionOp <= operadores.length;
				const chooseOp = isValids && operadores[+chooseOptionOp - 1];

				if (chooseOp) {
					const answer = `Estamos te redirecionado para o atendente ${chooseOp.NOME}.\nVocê será atendido em breve!`;
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: answer,
						quotedId: message.id
					});
					const operatoranswer = `*${chooseOp.NOME}*: Olá, em que posso ajudar?`;
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: operatoranswer,
						quotedId: message.id
					});

					await messagesDistributionService.transferChatOperator(
						sector,
						chooseOp,
						contact,
						chat
					);

					this.removeRunningStep(chat.id);
					break;
				}
				await whatsappService.sendBotMessage(message.from, {
					chat,
					text: "Opção inválida! Tente novamente.",
					quotedId: message.id
				});
				break;
			case 4:
				const option = Number(
					message.body.trim().replace(/[^0-9]/g, "")
				);

				switch (option) {
					case 1:
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Certo, retornando ao menu de setores...",
							quotedId: message.id
						});
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: chooseSectorMessage,
							quotedId: message.id
						});
						this.setRunningStep(chat.id, 2);
						break;

					case 2:
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Atendimento encerrado. Caso precise de algo, estamos à disposição!",
							quotedId: message.id
						});
						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: {
								isFinished: true,
								finishedAt: new Date(),
								finishedBy: null
							}
						});
						const event = SocketEventType.WppChatFinished;
						let finishMsg: string = `Atendimento finalizado pelo cliente devido inatividade do operador.`;

						await messagesDistributionService.addSystemMessage(
							chat,
							finishMsg
						);

						await socketService.emit(
							event,
							`${"nunes"}:chat:${chat.id}`,
							{
								chatId: chat.id
							}
						);

						this.removeRunningStep(chat.id);
						break;
					case 3:
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Tudo bem! Vamos continuar aguardando o atendimento.",
							quotedId: message.id
						});
						this.removeRunningStep(chat.id);
						let user = this.getOperadorOld(chat.id);
						await prismaService.wppChat.update({
							where: { id: chat.id },
							data: { userId: user, botId: null }
						});
						break;

					default:
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: "Opção inválida! Responda apenas com o número da opção desejada.",
							quotedId: message.id
						});
						break;
				}
				break;
			default:
				break;
		}
	}
}

export default new ChooseSectorBot();
