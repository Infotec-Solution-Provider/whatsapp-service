import { Logger, logRoutes } from "@in.pulse-crm/utils";
import { handleRequestError } from "@rgranatodutra/http-errors";
import cors from "cors";
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import "express-async-errors";
import cron from "node-cron";
import autoResponseController from "./controllers/auto-response.controller";
import chatsController from "./controllers/chats.controller";
import contactsController from "./controllers/contacts.controller";
import customerProfileTagsController from "./controllers/customer-profile-tags.controller";
import dashboardController from "./controllers/dashboard.controller";
import flowExecutionController from "./controllers/flow-execution.controller";
import frontendPerformanceController from "./controllers/frontend-performance.controller";
import gupshupController from "./controllers/gupshup.controller";
import internalchatsController from "./controllers/internal-chats.controller";
import internalWhatsappSendersController from "./controllers/internal-whatsapp-senders.controller";
import messageFlowsController from "./controllers/message-flows.controller";
import messageQueueController from "./controllers/message-queue.controller";
import messagesController from "./controllers/messages.controller";
import monitorController from "./controllers/monitor.controller";
import notificationsController from "./controllers/notifications.controller";
import contactActionRequestsController from "./controllers/contact-action-requests.controller";
import parametersController from "./controllers/parameters.controller";
import parsedMessagesController from "./controllers/parsed-messages.controller";
import readyMessagesController from "./controllers/ready-messages.controller";
import remoteClientController from "./controllers/remote-client.controller";
import remoteSessionMonitorController from "./controllers/remote-session-monitor.controller";
import resultsController from "./controllers/results.controller";
import schedulesController from "./controllers/schedules.controller";
import sectorsController from "./controllers/sectors.controller";
import wabaController from "./controllers/waba.controller";
import walletsController from "./controllers/wallets.controller";
import whatsappController from "./controllers/whatsapp.controller";
import { registerAllSteps } from "./message-flow/register-steps";
import gupshupWebhookQueueService from "./services/gupshup-webhook-queue.service";
import messageQueueService from "./services/message-queue.service";
import wabaWebhookQueueService from "./services/waba-webhook-queue.service";
import whatsappService from "./services/whatsapp.service";
import wwwebjsHealthCheckService from "./services/wwebjs-health-check.service";
import remoteSessionMonitorRoutine from "./routines/remote-session-monitor.routine";
import internalWhatsappMessageQueueService from "./services/internal-whatsapp-message-queue.service";
import internalChatsService from "./services/internal-chats.service";
import remoteInboundEventInboxService from "./services/remote-inbound-event-inbox.service";
import remoteClientService from "./services/remote-client.service";
import pipelineEnrollmentOutboxService from "./services/pipeline-enrollment-outbox.service";
import frontendPerformanceService from "./services/frontend-performance.service";

whatsappService.buildClients();
internalWhatsappMessageQueueService.setProcessHandler({
	process: (item) => internalChatsService.processQueuedWppGroupMessage(item)
});
remoteInboundEventInboxService.setProcessor({
	process: (item, payload) => remoteClientService.processInboundInboxItem(item, payload)
});
const app = express();

const routesToLog: Array<express.Router> = [];
const logRoute = (r: express.Router) => {
	routesToLog.push(r);

	return r;
};

app.use(cors());
// Telemetry has its own 64 KiB parser after authentication/rate limiting. It
// must be mounted before the legacy 2 GiB parsers used by the remaining APIs.
app.use(logRoute(frontendPerformanceController.router));
app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ extended: true, limit: "2gb" }));

// Serve static files for frontend
app.use(express.static("public"));

app.use(logRoute(whatsappController.router));
app.use(logRoute(chatsController.router));
app.use(logRoute(messagesController.router));
app.use(logRoute(walletsController.router));
app.use(logRoute(resultsController.router));
app.use(logRoute(contactsController.router));
app.use(logRoute(customerProfileTagsController.router));
app.use(logRoute(dashboardController.router));
app.use(logRoute(sectorsController.router));
app.use(logRoute(schedulesController.router));
app.use(logRoute(internalchatsController.router));
app.use(logRoute(internalWhatsappSendersController.router));
app.use(logRoute(readyMessagesController.router));
app.use(logRoute(notificationsController.router));
app.use(logRoute(contactActionRequestsController.router));
app.use(logRoute(monitorController.router));
app.use(logRoute(parametersController.router));
app.use(logRoute(gupshupController.router));
app.use(logRoute(autoResponseController.router));
app.use(logRoute(wabaController.router));
app.use(logRoute(messageFlowsController.router));
app.use(logRoute(flowExecutionController.router));
app.use(logRoute(remoteClientController.router));
app.use(logRoute(remoteSessionMonitorController.router));
app.use(logRoute(parsedMessagesController.router));
app.use(logRoute(messageQueueController.router));

logRoutes("", routesToLog);

// Serve frontend for any unmatched routes (SPA fallback)
app.get("/flows", (_req, res) => {
	res.sendFile("index.html", { root: "public" });
});

app.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
	console.error(err);
	next(err);
});

// @ts-ignore
app.use(handleRequestError);

const serverPort = Number(process.env["LISTEN_PORT"]) || 8005;

const server = app.listen(serverPort, () => {
	registerAllSteps();
	gupshupWebhookQueueService.startProcessor();
	wabaWebhookQueueService.startProcessor();
	messageQueueService.startWorker();
	internalWhatsappMessageQueueService.startWorker();
	remoteInboundEventInboxService.startWorker();
	pipelineEnrollmentOutboxService.startWorker();
	remoteSessionMonitorRoutine.start();
	frontendPerformanceService.startRetentionRoutine();
	Logger.info("Server listening on port " + serverPort);

	// Wwebjs session health check
	const healthCheckEnabled = process.env["WWEBJS_HEALTH_CHECK_ENABLED"] === "true";
	const healthCheckCron = process.env["WWEBJS_HEALTH_CHECK_CRON"] || "*/30 * * * *";

	if (healthCheckEnabled) {
		cron.schedule(healthCheckCron, () => {
			wwwebjsHealthCheckService.runHealthCheck().catch((err) => {
				Logger.error(`[WwebjsHealthCheck] Unhandled error in health check: ${err?.message}`);
			});
		});
		Logger.info(`[WwebjsHealthCheck] Scheduled with cron="${healthCheckCron}"`);
	}
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	Logger.info(`[Shutdown] ${signal} received; draining durable workers`);

	remoteInboundEventInboxService.stopWorker();
	pipelineEnrollmentOutboxService.stopWorker();
	internalWhatsappMessageQueueService.stopWorker();
	messageQueueService.stopWorker();
	gupshupWebhookQueueService.stopProcessor();
	wabaWebhookQueueService.stopProcessor();

	const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
	const graceful = Promise.all([
		serverClosed,
		remoteInboundEventInboxService.stopAndDrain(30_000),
		messageQueueService.stopAndDrain(30_000)
	]);
	const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
	await Promise.race([graceful, timeout]);
	process.exit(0);
};

process.once("SIGINT", () => {
	void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});
