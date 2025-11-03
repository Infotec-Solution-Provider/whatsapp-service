import { WppChat, WppContact, WppMessage } from "@prisma/client";
import whatsappService from "../services/whatsapp.service";
import messagesDistributionService from "../services/messages-distribution.service";
import prismaService from "../services/prisma.service";
import { User } from "@in.pulse-crm/sdk";
import ProcessingLogger from "../utils/processing-logger";
import CheckAvailableUsersStep from "../message-flow/steps/check-available-users.step";
import instancesService from "../services/instances.service";

const OPERATORS: Record<string, { name: string; id: number }> = {
	"1": { name: "Aline", id: 13 },
	"2": { name: "Nathalia", id: 4 }
};

class ChooseSellerBot {
	private running: Array<{
		contact: string;
		step: number;
		stepCount: number;
		prevStep: () => void;
		nextStep: () => void;
		countStep: () => void;
	}> = [];

	private getOrCreate(contact: string) {
		let session = this.running.find((s) => s.contact === contact);
		if (!session) {
			session = {
				contact,
				step: 1,
				stepCount: 0,
				prevStep: function () {
					this.stepCount = 0;
					this.step--;
				},
				nextStep: function () {
					this.stepCount = 0;
					this.step++;
				},
				countStep: function () {
					this.stepCount++;
				}
			};
			this.running.push(session);
		}
		return session;
	}

	private remove(contact: string) {
		this.running = this.running.filter((s) => s.contact !== contact);
	}

	public async processMessage(chat: WppChat, contact: WppContact, message: WppMessage) {
		const session = this.getOrCreate(chat.id.toString());
		const msg = message.body.trim().toLowerCase();
		session.countStep();

		switch (session.step) {
			case 1: {
				const welcome =
					"Olá! 😊\n\nCom qual das nossas vendedoras você gostaria de falar?\n\n1 - Aline\n2 - Nathalia\n\nFico no aguardo da sua escolha!";

				await whatsappService.sendBotMessage(message.from, message.clientId!, {
					chat,
					text: welcome,
					quotedId: message.id
				});
				session.nextStep();
				break;
			}

			case 2: {
				const validOption = msg.split(" ").find((s) => ["1", "2"].includes(s));

				const op = validOption && OPERATORS[validOption];

				if (op) {
					const user = { NOME: op.name, CODIGO: op.id } as User;

					const sector = await prismaService.wppSector.findUnique({
						where: { id: chat.sectorId! }
					});

					if (!sector) {
						await whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: "Setor não encontrado. Por favor, tente novamente mais tarde.",
							quotedId: message.id
						});
						this.remove(chat.id.toString());
						break;
					}

					await whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: `Estamos transferindo você para ${op?.name}...\nVocê será atendido em instantes.`,
						quotedId: message.id
					});

					await messagesDistributionService.transferChatOperator(sector, user, contact, chat);

					this.remove(chat.id.toString());
					break;
				} else if (!validOption && session.stepCount === 1) {
					const repeat = "Por gentileza, escolha uma das vendedoras abaixo:\n\n1 - Aline\n2 - Nathalia";

					await whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: repeat,
						quotedId: message.id
					});
					break;
				} else {
					const logger = new ProcessingLogger("vollo", "bot-flow", chat.id.toString(), message);
					const step = new CheckAvailableUsersStep({
						instance: message.instance,
						sectorId: chat.sectorId!,
						stepNumber: 1,
						nextStepNumber: 1
					});

					const result = await step.run({ contact, logger });
					const users = await instancesService.executeQuery<User[]>(chat.instance, `SELECT * FROM users`, []);
					const sector = await prismaService.wppSector.findUniqueOrThrow({
						where: {
							id: chat.sectorId!
						}
					});

					if (!sector) {
						await whatsappService.sendBotMessage(message.from, message.clientId!, {
							chat,
							text: "Setor não encontrado. Por favor, tente novamente mais tarde.",
							quotedId: message.id
						});
						this.remove(chat.id.toString());
						break;
					}

					const user =
						result.isFinal && result.chatData
							? users.find((u) => u.CODIGO === result.chatData!.userId) ||
								({ NOME: "Supervisão", CODIGO: -1 } as User)
							: ({ NOME: "Supervisão", CODIGO: -1 } as User);

					await whatsappService.sendBotMessage(message.from, message.clientId!, {
						chat,
						text: `Estamos transferindo você para um atendente...\nVocê será atendido em instantes.`,
						quotedId: message.id
					});

					await messagesDistributionService.transferChatOperator(sector, user, contact, chat);

					this.remove(chat.id.toString());
					break;
				}
			}
		}
	}

	async shouldActivate(chat: WppChat): Promise<boolean> {
		return chat.instance === "vollo";
	}
}

export default new ChooseSellerBot();
