import { WppChat, WppMessage } from "@prisma/client";
import whatsappService from "../services/whatsapp.service";
import sectorsService from "../services/sectors.service";

export default class ChooseSectorBot {
	private readonly running: { step: number; chatId: number }[] = [];

	constructor(public readonly instance: string) {}

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
	}

	public async processMessage(chat: WppChat, message: WppMessage) {
		const currentStep = this.getRunningStep(chat.id);
		const sectors = await sectorsService.getSectors(chat.instance);

		if (!sectors) {
			throw new Error(`No sectors found for instance ${chat.instance}`);
		}

		const sectorsMessage =
			`Olá, tudo bem? Escolha um setor para continuar:\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join("\n")}` +
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
				const chooseOption = message.body.trim().replace(/[^0-9]/g, "");
				const chooseSector = sectors.find(
					(s) => s.id === Number(chooseOption)
				);
				if (chooseSector) {
					await whatsappService.tra
					const answer =
						"Você foi redirecionado para o setor desejado, logo um atendente irá te atender!";
					await whatsappService.sendBotMessage(message.from, {
						chat,
						text: answer,
						quotedId: message.id
					});
				}

				break;
			default:
				break;
		}
	}
}
