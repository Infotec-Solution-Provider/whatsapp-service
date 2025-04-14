import "dotenv/config";
import "express-async-errors";
import express from "express";
import cors from "cors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import { Logger } from "@in.pulse-crm/utils";
import whatsappService from "./services/whatsapp.service";

whatsappService.buildInstances();
const app = express();

app.use(express.json());
app.use(cors());

// @ts-ignore
app.use(handleRequestError);

const serverPort = Number(process.env["LISTEN_PORT"]) || 5000;

app.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
});
