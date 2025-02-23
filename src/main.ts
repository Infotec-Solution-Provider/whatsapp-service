import "dotenv/config";
import express from "express";
import Logger from "./entities/logger";
import WhatsappService from "./services/whatsapp.service";

const app = express();
const appPort = Number(process.env["APP_PORT"]) || 5000;

WhatsappService.getInstance("develop", "555184449218");

app.listen(appPort, () => {
	Logger.info("Server running on port " + appPort);
});
