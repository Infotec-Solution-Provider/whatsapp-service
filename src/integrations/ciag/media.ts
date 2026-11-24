import axios from "axios";
import FormData from "form-data";
import prisma from "../../services/prisma.service";
import type { File } from "../../sdk-local";
import { check, validateMedia } from "./policy";

type StoreFile = (input: { buffer: Buffer; mime: string; name: string }) => Promise<File>;
type ReadFile = (id: number) => Promise<{ file: File; buffer: Buffer }>;

async function connection(where: { instance?: string; clientId?: number }) {
	if (process.env["CIAG_INTEGRATION_ENABLED"] !== "true") return null;
	const scope = await prisma.ciagIntegration.findFirst({ where: { ...where, active: true } });
	if (!scope) return null;
	const client = await prisma.wppClient.findFirst({
		where: { id: scope.clientId, instance: scope.instance, type: "WABA", isActive: true,
			sectors: { some: { id: scope.sectorId, instance: scope.instance } } }
	});
	check(client?.WABAToken && client.WABAPhoneId && client.WABAAccountId, "Conexão de mídia CIAG indisponível.", 503);
	const versions = JSON.parse(process.env["WABA_GRAPH_API_VERSIONS"] || "{}") as Record<string, string>;
	const version = versions[client.WABAPhoneId!] || process.env["WABA_GRAPH_API_VERSION"] || "v27.0";
	check(/^v\d+\.0$/.test(version), "Versão da API de mídia inválida.", 503);
	return { scope, client, graph: `https://graph.facebook.com/${version}`,
		options: { headers: { Authorization: `Bearer ${client.WABAToken}` }, timeout: 60_000, maxRedirects: 0 } };
}

// CIAG uses central file storage. Its Meta transport does not depend on a Windows storage agent.
export async function uploadCiagMedia(clientId: number, fileId: number, read: ReadFile): Promise<string | null> {
	const context = await connection({ clientId });
	if (!context) return null;
	const { scope, client, graph, options } = context;
	const [owned, historic] = await Promise.all([
		prisma.ciagMedia.findUnique({ where: { integrationId_fileId: { integrationId: scope.id, fileId } } }),
		prisma.wppMessage.findFirst({ where: { instance: scope.instance, clientId, fileId }, select: { id: true } })
	]);
	check(owned || historic, "Arquivo não pertence à integração CIAG.", 403);
	const { file, buffer } = await read(fileId);
	validateMedia(buffer, file.mime_type);
	const form = new FormData();
	form.append("messaging_product", "whatsapp");
	form.append("type", file.mime_type);
	form.append("file", buffer, { filename: file.name, contentType: file.mime_type });
	let id: unknown;
	try {
		const response = await axios.post(`${graph}/${client.WABAPhoneId}/media`, form, {
			...options, headers: { ...options.headers, ...form.getHeaders() },
			maxBodyLength: 101 * 1024 * 1024, maxContentLength: 1024 * 1024
		});
		id = response.data?.id;
	} catch {
		// Never propagate an Axios error carrying the Meta access token into application logs.
		throw new Error("Não foi possível preparar a mídia CIAG na Meta.");
	}
	check(typeof id === "string" && /^\d{1,255}$/.test(id), "A Meta não retornou um identificador de mídia válido.", 502);
	return id;
}

export async function downloadCiagMedia(instance: string, mediaId: string, store: StoreFile): Promise<File | null> {
	const context = await connection({ instance });
	if (!context) return null;
	check(/^\d{1,255}$/.test(mediaId), "Identificador de mídia inválido.");
	const { scope, client, graph, options } = context;
	let metadata: { url?: string; mime_type?: string; file_size?: number; sha256?: string };
	try {
		metadata = (await axios.get(`${graph}/${mediaId}`, {
			...options, params: { phone_number_id: client.WABAPhoneId }, maxContentLength: 1024 * 1024
		})).data;
	} catch {
		throw new Error("Não foi possível consultar a mídia CIAG na Meta.");
	}
	check(typeof metadata.url === "string" && typeof metadata.mime_type === "string", "Metadados da mídia inválidos.", 502);
	const url = new URL(metadata.url!);
	check(url.protocol === "https:" && !url.username && !url.password &&
		(url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbcdn.net") || url.hostname.endsWith(".fbsbx.com")),
		"Endereço da mídia Meta inválido.", 502);
	check(Number.isSafeInteger(metadata.file_size) && metadata.file_size! > 0 && metadata.file_size! <= 100 * 1024 * 1024,
		"Tamanho da mídia Meta inválido.", 413);
	let buffer: Buffer;
	try {
		buffer = Buffer.from((await axios.get(url.href, {
			...options, responseType: "arraybuffer", maxContentLength: 100 * 1024 * 1024
		})).data);
	} catch {
		throw new Error("Não foi possível baixar a mídia CIAG da Meta.");
	}
	check(buffer.length === metadata.file_size, "Mídia Meta recebida incompleta.", 502);
	const mime = metadata.mime_type!.split(";", 1)[0]!.trim().toLowerCase();
	validateMedia(buffer, mime);
	const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf",
		"audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr" };
	const file = await store({ buffer, mime, name: `whatsapp-${mediaId}.${extensions[mime] || "bin"}` });
	await prisma.ciagMedia.upsert({ where: { integrationId_fileId: { integrationId: scope.id, fileId: file.id } },
		create: { integrationId: scope.id, fileId: file.id, voice: false }, update: {} });
	return file;
}
