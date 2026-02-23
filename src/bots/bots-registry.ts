import { WppChat, WppContact, WppMessage } from "@prisma/client";
import chooseSectorBot from "./choose-sector.bot";
import exatronSatisfactionBot from "./exatron-satisfaction.bot";
import customerLinkingBot from "./customer-linking.bot";

export interface BotProcessor {
  processMessage(
    chat: WppChat,
    contact: WppContact,
    message: WppMessage,
  ): Promise<void>;
  startBot?(
    chat: WppChat,
    contact: WppContact,
    to: string,
    quotedId?: number,
  ): Promise<void>;
  shouldActivate?(chat: WppChat, contact: WppContact): Promise<boolean>;
}

const botsRegistry = new Map<number, BotProcessor>()

botsRegistry.set(1, chooseSectorBot);
botsRegistry.set(2, exatronSatisfactionBot);
botsRegistry.set(3, customerLinkingBot);


export default botsRegistry;