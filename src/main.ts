import "dotenv/config";
import "express-async-errors";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import { Logger, logRoutes } from "@in.pulse-crm/utils";
import whatsappService from "./services/whatsapp.service";
import chatsController from "./controllers/chats.controller";
import messagesController from "./controllers/messages.controller";

whatsappService.buildClients();
const app = express();

app.use(express.json());
app.use(cors());

app.use(chatsController.router);
app.use(messagesController.router);

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
	console.error(err);
	next(err);
});

// @ts-ignore
app.use(handleRequestError);

logRoutes("", [chatsController.router, messagesController.router]);

const serverPort = Number(process.env["LISTEN_PORT"]) || 5000;

app.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
});
