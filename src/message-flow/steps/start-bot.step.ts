import { BaseStep, FLOW_ACTIONS, StepContext } from "../base/base.step";

export default class StartBotStep extends BaseStep {
	async execute(context: StepContext) {
		const bot = await context[FLOW_ACTIONS]?.startBot(this.config["botId"]);
		if (!bot) {
			return this.continue(context, this.fallbackStepNumber, "Bot indisponível para este acionamento. Seguiu a contingência.");
		}
		return this.finalize({
			instance: this.instance, sectorId: this.sectorId, contactId: context.contact.id,
			type: "RECEPTIVE", startedBot: bot
		}, `Bot ${bot.name} selecionado na versão ${bot.version}.`);
	}
}
