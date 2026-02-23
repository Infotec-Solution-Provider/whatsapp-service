import { WppChat, WppContact, WppMessage } from "@prisma/client";

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

type BotLoader = () => unknown;

const botLoaders = new Map<number, BotLoader>([
  [1, () => require("./choose-sector.bot")],
  [2, () => require("./exatron-satisfaction.bot")],
  [3, () => require("./customer-linking.bot")]
]);

const loadedBots = new Map<number, BotProcessor>();

function getModuleDefault(moduleValue: unknown): unknown {
  if (
    moduleValue &&
    typeof moduleValue === "object" &&
    "default" in moduleValue
  ) {
    return (moduleValue as { default?: unknown }).default;
  }

  return moduleValue;
}

function isBotProcessor(bot: unknown): bot is BotProcessor {
  return !!bot && typeof (bot as BotProcessor).processMessage === "function";
}

function loadBot(botId: number): BotProcessor | undefined {
  const cached = loadedBots.get(botId);
  if (cached) return cached;

  const loader = botLoaders.get(botId);
  if (!loader) return undefined;

  try {
    const moduleValue = loader();
    const bot = getModuleDefault(moduleValue);

    if (!isBotProcessor(bot)) {
      return undefined;
    }

    loadedBots.set(botId, bot);
    return bot;
  } catch {
    return undefined;
  }
}

const botsRegistry = {
  get(botId: number): BotProcessor | undefined {
    return loadBot(botId);
  },

  entries(): IterableIterator<[number, BotProcessor]> {
    const entries: Array<[number, BotProcessor]> = [];

    for (const botId of botLoaders.keys()) {
      const bot = loadBot(botId);
      if (bot) {
        entries.push([botId, bot]);
      }
    }

    return entries[Symbol.iterator]();
  },

  snapshot(): Record<number, "loaded" | "unavailable"> {
    const snapshot: Record<number, "loaded" | "unavailable"> = {};

    for (const botId of botLoaders.keys()) {
      snapshot[botId] = loadBot(botId) ? "loaded" : "unavailable";
    }

    return snapshot;
  }
};

export default botsRegistry;