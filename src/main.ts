import "dotenv/config";
import "express-async-errors";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import { Logger, logRoutes } from "@in.pulse-crm/utils";
import whatsappService from "./services/whatsapp.service";
import chatsController from "./controllers/chats.controller";
import messagesController from "./controllers/messages.controller";
import walletsController from "./controllers/wallets.controller";
import resultsController from "./controllers/results.controller";
import contactsController from "./controllers/contacts.controller";
import sectorsController from "./controllers/sectors.controller";
import schedulesController from "./controllers/schedules.controller";
import internalchatsController from "./controllers/internal-chats.controller";
import whatsappController from "./controllers/whatsapp.controller";
import readyMessagesController from "./controllers/ready-messages.controller";
import notificationsController from "./controllers/notifications.controller";
import monitorController from "./controllers/monitor.controller";

whatsappService.buildClients();
const app = express();

app.use(express.json());
app.use(cors());

app.use(whatsappController.router);
app.use(chatsController.router);
app.use(messagesController.router);
app.use(walletsController.router);
app.use(resultsController.router);
app.use(contactsController.router);
app.use(sectorsController.router);
app.use(schedulesController.router);
app.use(internalchatsController.router);
app.use(readyMessagesController.router);
app.use(notificationsController.router);
app.use(monitorController.router);

app.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
	console.error(err);
	next(err);
});

// @ts-ignore
app.use(handleRequestError);

logRoutes("", [
	whatsappController.router,
	chatsController.router,
	messagesController.router,
	walletsController.router,
	resultsController.router,
	contactsController.router,
	sectorsController.router,
	schedulesController.router,
	internalchatsController.router,
	readyMessagesController.router,
	notificationsController.router,
	monitorController.router
]);

const serverPort = Number(process.env["LISTEN_PORT"]) || 8005;

app.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
});
