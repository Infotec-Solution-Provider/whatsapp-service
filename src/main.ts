import "dotenv/config";
import express from "express";
import Logger from "./entities/logger";
import server from "./server";
import toolsController from "./controllers/tools.controller";

const app = express();

app.use(express.json());

app.use(toolsController.router);

server.on("request", app);

const serverPort = Number(process.env["SERVER_LISTEN_PORT"]) || 5000;

server.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
});
