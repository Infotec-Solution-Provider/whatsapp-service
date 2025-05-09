import { WppChat, WppContact, WppMessage } from "@prisma/client";
import whatsappService from "../services/whatsapp.service";
import sectorsService from "../services/sectors.service";
import messagesDistributionService from "../services/messages-distribution.service";
import instancesService from "../services/instances.service";
import { User } from "@in.pulse-crm/sdk";

class ChooseSectorBot {
	private readonly running: { step: number; chatId: number }[] = [];

	private getRunningStep(chatId: number) {
		const running = this.running.find((r) => r.chatId === chatId);
		if (!running) {
			return this.setRunningStep(chatId, 1);
		}
		return running.step;
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
		const sectors = await sectorsService.getSectors(chat.instance, {
			receiveChats: true,
		});
		let operadores: User[] = [];
		if (!sectors) {
			throw new Error(`No sectors found for instance ${chat.instance}`);
		}

		const sectorsMessage =
			`Olá,\nEstamos felizes por você entrar em contato com a Metalúrgica Nunes, Usinagem de Precisão. Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}` +
			"\nDigite o número do setor desejado!";

		switch (currentStep) {
			case 1:
				await whatsappService.sendBotMessage(message.from, {
					chat,
					text: sectorsMessage,
					quotedId: message.id
				});
				this.setRunningStep(chat.id, 2);
				break;
			case 2:
				const chooseOption = Number(
					message.body.trim().replace(/[^0-9]/g, "")
				);
				const isValid =
					chooseOption > 0 && chooseOption <= sectors.length;
				const chooseSector = isValid && sectors[+chooseOption - 1];

				if (chooseSector) {
					let setorId = sectors[+chooseOption - 1]?.id
					console.log("setorId",setorId);
					console.log("chooseSector",chooseOption);
					let query = `SELECT * FROM operadores WHERE SETOR = ${setorId} order by NOME`;
					console.log("query",query);
					console.log("instance", chat.instance);
					console.log("chooseSector", chooseSector);

					let operadores = await instancesService.executeQuery<Array<User>>(chat.instance, query, []);
					console.log("operadores",operadores);
					const answer =
						`Escolha com quem deseja falar\n${operadores.map((s, i) => `${i + 1} - ${s.NOME}`).join("\n")}`;
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: answer,
						quotedId: message.id
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
					const isValids =
					chooseOptionOp > 0 && chooseOptionOp <= operadores.length;
					const chooseOp = isValids && operadores[+chooseOptionOp - 1];

					if (chooseOp) {
						const answer =
							`Estamos te redirecionado para o atendente ${chooseOp.NOME}.\nVocê será atendido em breve!`;
						await whatsappService.sendBotMessage(message.from, {
							chat,
							text: answer,
							quotedId: message.id
						});

						if (chooseSector) {
							await messagesDistributionService.transferChatOperator(
								chooseSector,
								chooseOp,
								contact,
								chat
							);
						} else {
							throw new Error("Invalid selected.");
						}
						this.removeRunningStep(chat.id);
						break;
					}
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: "Opção inválida! Tente novamente.",
						quotedId: message.id
					});
					break;

			default:
				break;
		}
	}
}

export default new ChooseSectorBot();
