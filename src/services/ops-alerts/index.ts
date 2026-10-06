import { Logger } from "@in.pulse-crm/utils";
import axios from "axios";
import prismaService from "../prisma.service";
import { loadOpsAlertsConfig } from "./ops-alerts.config";
import { OpsAlertsMonitor } from "./ops-alerts.monitor";
import { OpsAlertsService } from "./ops-alerts.service";
import { WhatsappAlertSender } from "./whatsapp-alert-sender";

export type { OpsAlertInput, OpsAlertRefs, OpsAlertSeverity, OpsAlertType } from "./ops-alerts.types";

const config = loadOpsAlertsConfig();
const log = (message: string) => Logger.info(message);

const sender = new WhatsappAlertSender(
	config,
	{
		get: (url, options) => axios.get(url, { ...options, headers: { "Cache-Control": "no-store" } }),
		post: (url, body, options) => axios.post(url, body, options)
	},
	log
);

export const opsAlerts = new OpsAlertsService(config, {
	log: (entry) => Logger.info(`[ops-alert] ${JSON.stringify(entry)}`),
	notify: (title, text) => {
		if (!config.notifyTargets.length) return;
		void prismaService.notification
			.createMany({
				data: config.notifyTargets.map((target) => ({
					instance: target.instance,
					userId: target.userId,
					title,
					description: text,
					type: "ALERT" as const
				}))
			})
			.catch((error: unknown) =>
				log(`[ops-alert] in-app notification failed: ${error instanceof Error ? error.message : String(error)}`)
			);
	},
	whatsapp: (text) => sender.send(text)
});

export const opsAlertsMonitor = new OpsAlertsMonitor(opsAlerts, config, prismaService, log);

export function startOpsAlerts(): void {
	if (!config.enabled) {
		Logger.info("[ops-alert] disabled (OPS_ALERTS_ENABLED=false)");
		return;
	}
	opsAlerts.start();
	opsAlertsMonitor.start();
	Logger.info(
		`[ops-alert] started (whatsapp=${config.whatsappMode}, sender=${config.senderUrl}, notify=${config.notifyTargets.length} target(s))`
	);
}

export function stopOpsAlerts(): void {
	opsAlertsMonitor.stop();
	opsAlerts.stop();
}

export default opsAlerts;
