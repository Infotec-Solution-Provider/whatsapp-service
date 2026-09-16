import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createMessageSendTrace, markMessageSendStage } from "./message-send-trace.middleware";
import upload from "./multer.middleware";

async function run() {
	const entries: Record<string, unknown>[] = [];
	const app = express();
	let submissions = 0;
	app.post("/api/whatsapp/:clientId/messages", createMessageSendTrace((entry) => entries.push(entry)),
		(req, res, next) => {
			if (!req.headers.authorization) { res.sendStatus(401); return; }
			markMessageSendStage(res, "multipart"); next();
		}, upload.single("file"), (_req, res) => {
			submissions++;
			markMessageSendStage(res, "persisted", { messageId: 42 });
			res.sendStatus(202);
		});
	app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
		res.sendStatus(400);
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/whatsapp/7/messages`;
	try {
		let response = await fetch(url, { method: "POST", headers: { "Idempotency-Key": "attempt-auth" } });
		assert.equal(response.status, 401);
		assert.equal(submissions, 0);
		assert.ok(entries.some((entry) => entry["traceId"] === "attempt-auth" && entry["stage"] === "authentication" && entry["httpStatus"] === 401));
		response = await fetch(url, { method: "POST", headers: {
			Authorization: "secret-token", "Idempotency-Key": "attempt-multipart", "Content-Type": "multipart/form-data",
		}, body: "private content" });
		assert.equal(response.status, 400);
		assert.equal(submissions, 0);
		assert.ok(entries.some((entry) => entry["traceId"] === "attempt-multipart" && entry["stage"] === "multipart" && entry["httpStatus"] === 400));
		const form = new FormData(); form.append("text", "private content");
		response = await fetch(url, { method: "POST", headers: { Authorization: "secret-token", "Idempotency-Key": "attempt-success" }, body: form });
		assert.equal(response.status, 202);
		assert.equal(submissions, 1);
		assert.ok(entries.some((entry) => entry["traceId"] === "attempt-success" && entry["stage"] === "persisted" && entry["httpStatus"] === 202));
		assert.ok(!JSON.stringify(entries).includes("secret-token"));
		assert.ok(!JSON.stringify(entries).includes("private content"));
		console.log("message-send-trace: pre-controller auth rejection, multipart failure and persisted receipt traced without payloads");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
