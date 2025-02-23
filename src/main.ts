import "dotenv/config";
import express from "express";
import Logger from "./entities/logger";
import WhatsappService from "./services/whatsapp.service";
import server from "./server";

const app = express();

app.use(express.json());

app.get("/", (_, res) => {
	res.status(200).json({ message: "Api is running!" });
});

app.get("/api/:instanceName/whatsapp/:phone", (req, res) => {
	const instanceName = req.params["instanceName"];
	const phone = req.params["phone"];
	const whatsappInstance = WhatsappService.getInstance(instanceName, phone);

	if (!whatsappInstance) {
		res.status(404).json({ message: "No whatsapp instance found" });
	} else {
		res.status(200).json({ message: "Found whatsapp instance", instance: whatsappInstance.phone });
	}
});

server.on("request", app);

const serverPort = Number(process.env["SERVER_LISTEN_PORT"]) || 5000;

server.listen(serverPort, () => {
	Logger.info("Server listening on port " + serverPort);
	if (process.env["SERVER_HTTPS"] === "true") {
		Logger.info("Server is running on HTTPS mode!");
	}
});
