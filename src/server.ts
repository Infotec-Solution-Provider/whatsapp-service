import "dotenv/config";
import { createServer } from "node:https";
import { readFileSync } from "fs"; // Usando fs para ler os arquivos de chave e certificado
import path from "path";
import Logger from "./entities/logger";

function loadCertificates() {
	const keyPath = process.env["SERVER_HTTPS_KEY"];
	const certPath = process.env["SERVER_HTTPS_CERT"];
	const passphrase = process.env["SERVER_HTTPS_PASS"];

	if (!keyPath) {
		throw new Error("Missing SERVER_HTTPS_KEY environment variable");
	}
	if (!certPath) {
		throw new Error("Missing SERVER_HTTPS_CERT environment variable");
	}
	if (!passphrase) {
		throw new Error("Missing SERVER_HTTPS_PASS environment variable");
	}

	const key = readFileSync(path.resolve(keyPath), "utf8");
	const cert = readFileSync(path.resolve(certPath), "utf8");

	return { key, cert, passphrase };
}

function initServer() {
	if (process.env["SERVER_HTTPS"] === "true") {
		try {
			return createServer(loadCertificates());
		} catch (error: unknown) {
			if (error instanceof Error) Logger.error("Failed to create HTTPS server", error);
			else Logger.error("Failed to create HTTPS server");
		}
	}

	Logger.warning("Starting server on HTTP mode");

	return createServer();
}

export default initServer();
