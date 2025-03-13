import "dotenv/config";
import "express-async-errors";
import express from "express";
import cors from "cors";
import server from "./server";
import Logger from "./entities/logger";
import toolsController from "./controllers/tools.controller";
import filesController from "./controllers/files.controller";
import { handleRequestError } from "@rgranatodutra/http-errors";
import InstanceMiddleware from "./middlewares/instance.middleware";

const app = express();
const ROUTE_PREFIX = "/api/:instance";

declare module "express-serve-static-core" {
	interface Request {
		instance?: string;
	}
}

app.use(express.json());
app.use(cors());

app.use(ROUTE_PREFIX, InstanceMiddleware.fillRequestInstance);
app.use(ROUTE_PREFIX, toolsController.router);
app.use(ROUTE_PREFIX, filesController.router);

// @ts-ignore
app.use(handleRequestError);

server.on("request", app);

const serverPort = Number(process.env["SERVER_LISTEN_PORT"]) || 5000;

app.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
});
