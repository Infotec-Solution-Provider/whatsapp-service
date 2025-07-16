import { WppChat, WppContact, WppMessage } from "@prisma/client";
import whatsappService from "../services/whatsapp.service";
import messagesDistributionService from "../services/messages-distribution.service";
import prismaService from "../services/prisma.service";
import { User } from "@in.pulse-crm/sdk";

const OPERATORS: Record<string, { name: string; id: number }> = {
  aline: { name: "Aline", id: 13 },
  hellen: { name: "Hellen", id: 12 },
  nathalia: { name: "Nathalia", id: 4 }
};

class ChooseSellerBot {
  private running: Array<{ contact: string; step: number }> = [];

  private getOrCreate(contact: string) {
    let session = this.running.find((s) => s.contact === contact);
    if (!session) {
      session = { contact, step: 1 };
      this.running.push(session);
    }
    return session;
  }

  private remove(contact: string) {
    this.running = this.running.filter((s) => s.contact !== contact);
  }

  public async processMessage(
    chat: WppChat,
    contact: WppContact,
    message: WppMessage
  ) {
    const session = this.getOrCreate(chat.id.toString());
    const msg = message.body.trim().toLowerCase();

    switch (session.step) {
      case 1: {
        const welcome = `Olá! 😊\n\nCom qual das nossas vendedoras você gostaria de falar?\n\nAline, Hellen ou Nathalia?\n\nCaso ainda não tenha sido atendido(a) por nenhuma delas, é só responder com: "Nova vendedora" que vamos te direcionar para o próximo atendimento disponível.\n\nFico no aguardo da sua escolha!`;
        await whatsappService.sendBotMessage(message.from, {
          chat,
          text: welcome,
          quotedId: message.id
        });
        session.step = 2;
        break;
      }

      case 2: {
        if (msg === "nova vendedora") {
          // Buscar setor no banco para usar na transferência
          const sector = await prismaService.wppSector.findUnique({
            where: { id: chat.sectorId! }
          });

          if (!sector) {
            await whatsappService.sendBotMessage(message.from, {
              chat,
              text: "Setor não encontrado. Por favor, tente novamente mais tarde.",
              quotedId: message.id
            });
            this.remove(chat.id.toString());
            break;
          }

			const operatorKeys = Object.keys(OPERATORS);
			const randomKey = operatorKeys[Math.floor(Math.random() * operatorKeys.length)]!;
			const defaultOperator = OPERATORS[randomKey];

			const fakeUser = { NOME: defaultOperator?.name, CODIGO: defaultOperator?.id } as User;


          await whatsappService.sendBotMessage(message.from, {
            chat,
            text: `Perfeito! Vamos direcionar você para o próximo atendimento disponível.`,
            quotedId: message.id
          });

          await messagesDistributionService.transferChatOperator(
            {
              id: sector.id,
              instance: sector.instance,
              name: sector.name,
              wppInstanceId: sector.wppInstanceId,
              receiveChats: sector.receiveChats,
              startChats: sector.startChats
            },
            fakeUser,
            contact,
            chat
          );

          this.remove(chat.id.toString());
          break;
        }

        const found = Object.keys(OPERATORS).find((key) =>
          msg.includes(key)
        );

        if (found) {
          const op = OPERATORS[found];
          const user = { NOME: op?.name, CODIGO: op?.id } as User;

          const sector = await prismaService.wppSector.findUnique({
            where: { id: chat.sectorId! }
          });

          if (!sector) {
            await whatsappService.sendBotMessage(message.from, {
              chat,
              text: "Setor não encontrado. Por favor, tente novamente mais tarde.",
              quotedId: message.id
            });
            this.remove(chat.id.toString());
            break;
          }

          await whatsappService.sendBotMessage(message.from, {
            chat,
            text: `Você escolheu falar com ${op?.name}.`,
            quotedId: message.id
          });

          await whatsappService.sendBotMessage(message.from, {
            chat,
            text: `*${op?.name}*: Olá! Em que posso te ajudar?`,
            quotedId: message.id
          });

          await messagesDistributionService.transferChatOperator(
            {
              id: sector.id,
              instance: sector.instance,
              name: sector.name,
              wppInstanceId: sector.wppInstanceId,
              receiveChats: sector.receiveChats,
              startChats: sector.startChats
            },
            user,
            contact,
            chat
          );

          this.remove(chat.id.toString());
          break;
        }

        await whatsappService.sendBotMessage(message.from, {
          chat,
          text: `Por gentileza, escolha uma das vendedoras abaixo:\nAline, Hellen ou Nathalia?`,
          quotedId: message.id
        });
        break;
      }
    }
  }
}

export default new ChooseSellerBot();
