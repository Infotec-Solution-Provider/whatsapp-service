import assert from "assert/strict";
import { createHmac, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import axios from "axios";
import prisma from "../../services/prisma.service";
import service, { keyHash } from "./service";
import router from "./controller";
import wabaController from "../../controllers/waba.controller";
import queue from "../../services/waba-webhook-queue.service";
import whatsapp from "../../services/whatsapp.service";
import messages from "../../services/messages.service";
import chats from "../../services/chats.service";
import distribution from "../../services/messages-distribution.service";
import socket from "../../services/socket.service";
import files from "../../services/files.service";
import WABAWhatsappClient from "../../whatsapp-client/waba-whatsapp-client";
import { shouldApplyStatus, validateMedia, verifySignature } from "./policy";
import { splitWebhook } from "./webhook";
import AudioConverter from "../../utils/whatsapp-audio-converter";
import { uploadCiagMedia, downloadCiagMedia } from "./media";
import { createCiagFilesGuard, allowCiagFilesAccess } from "./files-guard";
import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";

async function main() {
	assert.match(new URL(process.env["WHATSAPP_DATABASE_URL"]!).pathname, /^\/ciag_autotest_[a-f0-9]{32}$/);
	const fileKey = "test-ciag-files-key", fileHash = createHash("sha256").update(fileKey).digest("hex");
	const filesApp = express(); filesApp.use(express.json());
	filesApp.use(createCiagFilesGuard({ file: async (id) => id === 1 ? "ciag" : "other",
		publicFile: async (id) => id === "ciag-private" ? "ciag" : "other", keyHash: () => fileHash }));
	filesApp.post("/api/files", (req, res) => {
		if (allowCiagFilesAccess(req, res, req.body.instance, fileHash)) res.json({ ok: true });
	});
	filesApp.use((_req, res) => res.json({ ok: true }));
	const fileServer = filesApp.listen(0); await new Promise<void>((resolve) => fileServer.once("listening", resolve));
	const fileOrigin = `http://127.0.0.1:${(fileServer.address() as import("net").AddressInfo).port}`;
	try {
		for (const path of ["/api/files/1", "/api/files/1/metadata", "/api/files/1/view", "/api/files/1/scoped?instance=other", "/public/other/files/ciag-private", "/api/files/exists?instance=ciag&hash=abc"]) {
			assert.equal((await fetch(fileOrigin + path)).status, 401);
			assert.equal((await fetch(fileOrigin + path, { headers: { "x-ciag-files-key": fileKey } })).status, 200);
			assert.equal((await fetch(fileOrigin + path, { headers: { "x-ciag-files-key": "wrong" } })).status, 401);
		}
		assert.equal((await fetch(fileOrigin + "/api/files/2")).status, 200);
		assert.equal((await fetch(fileOrigin + "/api/files/1", { method: "DELETE" })).status, 401);
		assert.equal((await fetch(fileOrigin + "/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "ciag" }) })).status, 401);
		assert.equal((await fetch(fileOrigin + "/api/waba/get-media-id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId: 1 }) })).status, 401);
	} finally { await new Promise<void>((resolve) => fileServer.close(() => resolve())); }
	const sector = await prisma.wppSector.create({
		data: { name: "CIAG test", instance: "ciag", startChats: true, receiveChats: true }
	});
	const client = await prisma.wppClient.create({
		data: {
			name: "CIAG WABA",
			instance: "ciag",
			type: "WABA",
			isActive: true,
			phone: "555130000000",
			WABAPhoneId: "phone-ciag",
			WABAAccountId: "account-ciag",
			WABAToken: "test-only",
			sectors: { connect: { id: sector.id } }
		}
	});
	const key = "ciag_test_" + randomUUID();
	const scope = await prisma.ciagIntegration.create({
		data: { id: "ciag-test", keyHash: keyHash(key), instance: "ciag", clientId: client.id, sectorId: sector.id }
	});
	const other = await prisma.wppContact.create({
		data: { instance: "other", name: "Private customer", phone: "5551999990009", whatsappId: "5551999990009" }
	});
	const provider = new WABAWhatsappClient(
		client.id,
		"ciag",
		"CIAG",
		"555130000000",
		"phone-ciag",
		"account-ciag",
		"test-only"
	);
	whatsapp.getClient = () => provider;
	let providerCalls = 0,
		mode = "success";
	provider.sendMessage = async (options) => {
		providerCalls++;
		if (mode === "lost") throw new Error("Response lost after network boundary");
		const now = new Date();
		return {
			instance: "ciag",
			clientId: client.id,
			from: "me:555130000000",
			to: options.to,
			body: options.text ?? "",
			type: "text",
			timestamp: String(now.getTime()),
			sentAt: now,
			status: "SENT",
			wabaId: "wamid.test." + randomUUID()
		};
	};
	messages.insertMessage = async (data) =>
		prisma.wppMessage.create({
			data: data as unknown as Prisma.WppMessageUncheckedCreateInput,
			include: { WppChat: true }
		});
	messages.updateMessage = async (id, data) =>
		prisma.wppMessage.update({
			where: { id },
			data: data as unknown as Prisma.WppMessageUncheckedUpdateInput,
			include: { WppChat: true }
		});
	distribution.notifyMessage = async () => {};
	chats.ensureActiveChatForAgent = async (input) => {
		let chat = await prisma.wppChat.findFirst({
			where: { instance: input.instance, contactId: input.contactId, isFinished: false }
		});
		const existed = Boolean(chat);
		chat ??= await prisma.wppChat.create({
			data: {
				instance: input.instance,
				contactId: input.contactId,
				sectorId: input.sectorId ?? null,
				type: "ACTIVE",
				startedAt: new Date()
			}
		});
		return { chat, existed };
	};
	const contact = await service.contact(scope, "5551999990001", "Cliente");
	await prisma.wppMessage.create({
		data: {
			instance: "ciag",
			clientId: client.id,
			contactId: contact.id,
			from: "5551999990001",
			to: "me:555130000000",
			type: "text",
			body: "Olá",
			timestamp: String(Date.now()),
			sentAt: new Date(),
			status: "RECEIVED"
		}
	});
	await service.consent(scope, {
		phone: contact.phone,
		status: "granted",
		evidence: "Formulário de teste",
		actor: { id: "admin", name: "Operador" }
	});
	assert.equal((await service.authenticate("Bearer " + key)).id, scope.id);
	await assert.rejects(service.authenticate("Bearer wrong-key"), /Chave/);
	assert.ok(!(await service.contacts(scope)).some((c) => c.id === other.id));
	const exactVariant = await service.contact(scope, "555199990001", "Outro número");
	assert.notEqual(exactVariant.id, contact.id);
	const input = {
		externalId: "ciag:direct:" + randomUUID(),
		phone: contact.phone,
		content: { kind: "text", text: "Resposta sem prefixo" },
		actor: { id: "admin", name: "Operador" },
		broadcast: false
	};
	const [a, b] = await Promise.all([service.submit(scope, input), service.submit(scope, input)]);
	assert.equal(a.externalId, b.externalId);
	assert.equal(await prisma.ciagOutbound.count(), 1);
	await assert.rejects(
		service.submit(scope, { ...input, content: { kind: "text", text: "Outro conteúdo" } }),
		/outro conteúdo/
	);
	const processQueue = () => (service as unknown as { process: () => Promise<void> }).process();
	await processQueue();
	assert.equal(providerCalls, 1);
	const sent = await service.result(scope, input.externalId);
	assert.equal(sent?.status, "sent");
	assert.equal(sent?.text, "Resposta sem prefixo");
	assert.equal(sent?.actor?.id, "admin");
	messages.syncCurrentMessage = async (id) => prisma.wppMessage.findUniqueOrThrow({ where: { id } });
	socket.emit = async () => ({ message: "ok" });
	const storedMessage = await prisma.wppMessage.findUniqueOrThrow({ where: { id: sent!.id } });
	const stamp = Date.now();
	await Promise.all([
		distribution.processMessageStatus("waba", storedMessage.wabaId!, "READ", { statusTimestamp: stamp + 2 }),
		distribution.processMessageStatus("waba", storedMessage.wabaId!, "SENT", { statusTimestamp: stamp + 1 })
	]);
	assert.equal((await prisma.wppMessage.findUniqueOrThrow({ where: { id: sent!.id } })).status, "READ");
	await distribution.processMessageStatus("waba", storedMessage.wabaId!, "ERROR", { statusTimestamp: stamp + 3 });
	assert.equal((await prisma.wppMessage.findUniqueOrThrow({ where: { id: sent!.id } })).status, "READ");
	await processQueue();
	assert.equal(providerCalls, 1);
	const cancelled = { ...input, externalId: "ciag:direct:" + randomUUID() };
	await service.submit(scope, cancelled);
	await service.cancel(scope, cancelled.externalId);
	await processQueue();
	assert.equal(providerCalls, 1);
	assert.equal((await service.result(scope, cancelled.externalId))?.status, "cancelled");
	const uncertain = { ...input, externalId: "ciag:direct:" + randomUUID() };
	await service.submit(scope, uncertain);
	mode = "lost";
	await processQueue();
	assert.equal((await service.result(scope, uncertain.externalId))?.status, "unknown");
	await processQueue();
	assert.equal(providerCalls, 2);
	const revoked = { ...input, externalId: "ciag:campaign:" + randomUUID(), broadcast: true };
	await service.submit(scope, revoked);
	await service.consent(scope, {
		phone: contact.phone,
		status: "revoked",
		evidence: "Solicitação do cliente",
		actor: input.actor
	});
	await processQueue();
	assert.equal((await service.result(scope, revoked.externalId))?.status, "failed");
	assert.equal(providerCalls, 2);
	const unknown = await service.contact(scope, "5551999990002", "Novo cliente");
	await assert.rejects(
		service.submit(scope, { ...input, phone: unknown.phone, externalId: "ciag:direct:" + randomUUID() }),
		/Janela/
	);
	await assert.rejects(service.download(scope, 123456), /indisponível/);
	const app = express();
	app.use(router);
	app.use(wabaController.router);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const port = (server.address() as { port: number }).port;
	const status = await fetch(`http://127.0.0.1:${port}/api/integrations/ciag/v1/status`, {
		headers: { Authorization: "Bearer " + key }
	});
	assert.equal(status.status, 200);
	assert.equal(((await status.json()) as { phone: string }).phone, client.phone);
	const privateFile = await fetch(`http://127.0.0.1:${port}/api/integrations/ciag/v1/media/123456`, {
		headers: { Authorization: "Bearer " + key }
	});
	assert.equal(privateFile.status, 404);
	const missing = await fetch(`http://127.0.0.1:${port}/api/integrations/ciag/v1/contacts`);
	assert.equal(missing.status, 401);
	const originalUpload = files.uploadFile;
	try {
		files.uploadFile = async (upload) => {
			assert.equal(upload.instance, "ciag"); assert.equal(upload.mimeType, "audio/ogg");
			assert.equal(upload.buffer.subarray(0, 4).toString(), "OggS");
			return { id: 9877, name: upload.fileName, mime_type: upload.mimeType, size: upload.buffer.length } as Awaited<ReturnType<typeof files.uploadFile>>;
		};
		const audio = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "libopus", "-f", "webm", "pipe:1"]);
		const form = new FormData(); form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/webm" }), "gravacao.webm"); form.append("voice", "true");
		const response = await fetch(`http://127.0.0.1:${port}/api/integrations/ciag/v1/media`, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form });
		assert.equal(response.status, 200, "Native recording multipart includes a file and the voice flag");
		assert.equal(((await response.json()) as { voice: boolean }).voice, true);
		form.append("extra", "not-allowed");
		const rejected = await fetch(`http://127.0.0.1:${port}/api/integrations/ciag/v1/media`, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form });
		assert.equal(rejected.status, 400);
		assert.equal(typeof ((await rejected.json()) as { error: string }).error, "string");
	} finally { files.uploadFile = originalUpload; }
	processEnvSecret();
	const body = {
		object: "whatsapp_business_account",
		entry: [
			{
				id: "account-ciag",
				changes: [
					{
						field: "messages",
						value: {
							metadata: { phone_number_id: "phone-ciag", display_phone_number: "555130000000" },
							messages: [
								{ id: "in1", from: contact.phone, type: "text", text: { body: "A" } },
								{ id: "in2", from: contact.phone, type: "text", text: { body: "B" } }
							],
							statuses: [{ id: "out1", status: "read", timestamp: "100" }]
						}
					}
				]
			}
		]
	};
	const raw = JSON.stringify(body),
		signature = "sha256=" + createHmac("sha256", "test-app-secret").update(raw).digest("hex");
	assert.equal(splitWebhook(body).length, 3);
	assert.equal(verifySignature(Buffer.from(raw), signature, "test-app-secret"), true);
	assert.equal(verifySignature(Buffer.from(raw + " "), signature, "test-app-secret"), false);
	const hook = () =>
		fetch(`http://127.0.0.1:${port}/api/whatsapp/waba/ciag/webhooks`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
			body: raw
		});
	process.env["WABA_LEGACY_UNSIGNED_INSTANCES"] = '["ciag"]';
	delete process.env["WABA_APP_SECRET"];
	assert.equal((await hook()).status,403,"CIAG never permits the unsigned legacy exception");
	processEnvSecret();
	assert.equal((await hook()).status, 200);
	assert.equal((await hook()).status, 200);
	assert.equal(await prisma.wABAWebhookQueue.count(), 3);
	const invalid = await fetch(`http://127.0.0.1:${port}/api/whatsapp/waba/ciag/webhooks`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
		body: raw
	});
	assert.equal(invalid.status, 403);
	const wrongTenant = await fetch(`http://127.0.0.1:${port}/api/whatsapp/waba/other/webhooks`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
		body: raw
	});
	assert.equal(wrongTenant.status, 403);
	const enqueue = queue.enqueue;
	queue.enqueue = async () => {
		throw new Error("Database unavailable");
	};
	assert.equal((await hook()).status, 503);
	queue.enqueue = enqueue;
	assert.equal(shouldApplyStatus("READ", "SENT", 100, 200), false);
	assert.equal(shouldApplyStatus("SENT", "ERROR", 100, 200), true);
	assert.equal(shouldApplyStatus("SENT", "READ", 200, 100), false);
	assert.equal(shouldApplyStatus("SENT", "READ", 100, 200), true);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const incoming = await prisma.wppMessage.create({
		data: {
			instance: "ciag",
			clientId: client.id,
			from: contact.phone!,
			to: "me:555130000000",
			type: "text",
			body: "SAIR",
			timestamp: String(Date.now()),
			sentAt: new Date(),
			status: "RECEIVED",
			wabaId: "wamid.optout"
		}
	});
	await service.consent(scope, {
		phone: contact.phone,
		status: "granted",
		evidence: "Reautorização",
		actor: input.actor
	});
	await service.receiveInbound(scope, incoming);
	assert.equal((await service.summary(scope, contact)).consent, "revoked");
	await assert.rejects(
		service.submit(scope, { ...input, externalId: "ciag:direct:" + randomUUID() }),
		/descadastrado/
	);
	const lock = service.withContactLock(scope.id, contact.phone!, async () => {
		await new Promise((resolve) => setTimeout(resolve, 40));
		return true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	await assert.rejects(
		service.withContactLock(scope.id, contact.phone!, async () => false),
		/processamento/
	);
	await lock;
	const fakeFile = { id: 123, name: "arquivo.pdf", mime_type: "application/pdf", size: 12 };
	files.fetchFileMetadata = async () => fakeFile as Awaited<ReturnType<typeof files.fetchFileMetadata>>;
	files.fetchFile = async () => Buffer.from("%PDF-testing");
	await assert.rejects(service.allowedMedia(scope, 123), /indisponível/);
	await prisma.ciagMedia.create({ data: { integrationId: scope.id, fileId: 123 } });
	assert.equal((await service.download(scope, 123)).data.toString(), "%PDF-testing");
	const originalMediaPost = axios.post, originalMediaGet = axios.get;
	try {
		let uploads = 0;
		axios.post = (async (url: string, _body: unknown, options: { headers: { Authorization: string }; maxRedirects: number }) => {
			assert.match(url, /\/phone-ciag\/media$/);
			assert.equal(options.headers.Authorization, "Bearer test-only");
			assert.equal(options.maxRedirects, 0);
			uploads++;
			return { data: { id: "123456789" } };
		}) as typeof axios.post;
		assert.equal(await files.getWabaMedia(123, undefined, client.id), "123456789");
		await assert.rejects(files.getWabaMedia(123, "123456789", client.id), /não renovou/);
		assert.equal(uploads, 2);
		await assert.rejects(uploadCiagMedia(client.id, 999, async () => { throw Error("must not read private bytes"); }), /não pertence/);
		assert.equal(await uploadCiagMedia(999999, 123, async () => { throw Error("must not read another connection"); }), null);
		axios.post = (async () => { throw Error("Sensitive upstream token: test-only"); }) as typeof axios.post;
		await assert.rejects(files.getWabaMedia(123, undefined, client.id), (error: Error) =>
			error.message.includes("preparar a mídia CIAG") && !error.message.includes("test-only"));
		let hostile = false, wrongSize = false, stored = 0, downloaded = 0;
		axios.get = (async (url: string, options: { maxRedirects: number; params?: { phone_number_id: string } }) => {
			assert.equal(options.maxRedirects, 0);
			if (url.includes("graph.facebook.com")) {
				assert.equal(options.params?.phone_number_id, "phone-ciag");
				return { data: { url: hostile ? "https://attacker.test/private" : "https://lookaside.fbsbx.com/whatsapp_business/attachments/test",
					mime_type: "application/pdf", file_size: wrongSize ? 50 : 12 } };
			}
			downloaded++;
			return { data: Buffer.from("%PDF-testing") };
		}) as typeof axios.get;
		const store = async ({ buffer, mime }: { buffer: Buffer; mime: string; name: string }) => {
			assert.equal(buffer.toString(), "%PDF-testing"); assert.equal(mime, "application/pdf"); stored++;
			return fakeFile as Awaited<ReturnType<typeof files.fetchFileMetadata>>;
		};
		assert.equal((await downloadCiagMedia("ciag", "123456789", store))?.id, 123);
		hostile = true;
		await assert.rejects(downloadCiagMedia("ciag", "123456789", store), /Endereço/);
		assert.equal(downloaded, 1);
		hostile = false; wrongSize = true;
		await assert.rejects(downloadCiagMedia("ciag", "123456789", store), /incompleta/);
		assert.equal(stored, 1);
		assert.equal(await downloadCiagMedia("other", "123456789", store), null);
	} finally {
		axios.post = originalMediaPost; axios.get = originalMediaGet;
	}
	await service.consent(scope, {
		phone: contact.phone,
		status: "granted",
		evidence: "Nova autorização para teste de mídia",
		actor: input.actor
	});
	files.getWabaMedia = async () => "media-test";
	const post = axios.post;
	axios.post = (async (_url: string, body: { type: string; document: { caption: string; id: string } }) => {
		assert.equal(body.type, "document");
		assert.equal(body.document.caption, "Documento do atendimento");
		assert.equal(body.document.id, "media-test");
		return { data: { messages: [{ id: "wamid.media-test" }] } };
	}) as typeof axios.post;
	provider.sendMessage = WABAWhatsappClient.prototype.sendMessage.bind(provider);
	const mediaInput = {
		...input,
		externalId: "ciag:media:" + randomUUID(),
		content: { kind: "media", text: "Documento do atendimento", media: { id: 123 } }
	};
	await service.submit(scope, mediaInput);
	await processQueue();
	const mediaResult = await service.result(scope, mediaInput.externalId);
	assert.equal(mediaResult?.status, "sent");
	assert.equal(mediaResult?.media?.id, 123);
	assert.equal(mediaResult?.media?.name, "arquivo.pdf");
	assert.equal(
		(await service.messages(scope, contact.phone)).items.find((m) => m.id === mediaResult?.id)?.media?.id,
		123
	);
	axios.post = post;
	fakeFile.mime_type = "audio/ogg";
	files.fetchFile = async () => Buffer.from("OggS-test");
	await assert.rejects(
		service.content(scope, { kind: "media", text: "Texto que não pode desaparecer", media: { id: 123 } }),
		/não aceita legenda/
	);
	fakeFile.mime_type = "application/pdf";
	files.fetchFile = async () => Buffer.from("%PDF-testing");
	validateMedia(Buffer.from("%PDF-test"), "application/pdf");
	assert.throws(() => validateMedia(Buffer.from("<script>bad</script>"), "image/png"), /corresponde/);
	assert.throws(() => validateMedia(Buffer.alloc(6 * 1024 * 1024), "image/png"), /5 MB/);
	const get = axios.get;
	const rawTemplate = {
		name: "aviso",
		language: "pt_BR",
		status: "APPROVED",
		category: "UTILITY",
		components: [
			{ type: "HEADER", text: "Olá {{name}}", format: "TEXT" },
			{ type: "BODY", text: "Pedido {{1}}" },
			{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/{{1}}" }] }
		]
	};
	axios.get = (async () => ({ data: { data: [rawTemplate] } })) as typeof axios.get;
	const built = await provider.buildCiagTemplate("aviso", "pt_BR", {
		"header:name": "Ana",
		"body:1": "42",
		"button:0:1": "pedido"
	});
	assert.equal(built.components.length, 3);
	await assert.rejects(provider.buildCiagTemplate("aviso", "pt_BR", {}), /variável/);
	axios.get = get;
	const dir = mkdtempSync(join(tmpdir(), "ciag-voice-test-"));
	try {
		const file = join(dir, "input.webm");
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=0.25",
			"-c:a",
			"libopus",
			file
		]);
		const audio = await AudioConverter.convertToVoice(readFileSync(file), "audio/webm");
		assert.equal(audio.buffer.subarray(0, 4).toString(), "OggS");
		assert.equal(audio.mimeType, "audio/ogg");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	await service.stop();
	await prisma.$disconnect();
	console.log(
		"CIAG Inpulse: auth, tenant/media isolation, exact identity, durable/idempotent delivery, cancellation, uncertainty, consent, webhooks, locks, templates and real Opus conversion passed."
	);
}
function processEnvSecret() {
	process.env["WABA_APP_SECRET"] = "test-app-secret";
}
main()
	.then(() => process.exit(0))
	.catch(async (error) => {
		console.error(error);
		await prisma.$disconnect();
		process.exit(1);
	});
