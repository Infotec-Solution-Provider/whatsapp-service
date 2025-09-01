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
import parametersController from "./controllers/parameters.controller";
import gupshupController from "./controllers/gupshup.controller";
import autoResponseController from "./controllers/auto-response.controller";

whatsappService.buildClients();
const app = express();

const routesToLog: Array<express.Router> = [];
const logRoute = (r: express.Router) => {
	routesToLog.push(r);

	return r;
};

app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ extended: true, limit: "2gb" }));
app.use(cors());

app.use(logRoute(whatsappController.router));
app.use(logRoute(chatsController.router));
app.use(logRoute(messagesController.router));
app.use(logRoute(walletsController.router));
app.use(logRoute(resultsController.router));
app.use(logRoute(contactsController.router));
app.use(logRoute(sectorsController.router));
app.use(logRoute(schedulesController.router));
app.use(logRoute(internalchatsController.router));
app.use(logRoute(readyMessagesController.router));
app.use(logRoute(notificationsController.router));
app.use(logRoute(monitorController.router));
app.use(logRoute(parametersController.router));
app.use(logRoute(gupshupController.router));

logRoutes("", routesToLog);

app.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
	console.error(err);
	next(err);
});

// @ts-ignore
app.use(handleRequestError);

const serverPort = Number(process.env["LISTEN_PORT"]) || 8005;

app.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
});
