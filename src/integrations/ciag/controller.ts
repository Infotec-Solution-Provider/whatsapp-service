import { Router, json, Request, Response } from "express";
import multer from "multer";
import type { CiagIntegration } from "@prisma/client";
import service from "./service";
import { check } from "./policy";
const router = Router();
const prefix = "/api/integrations/ciag/v1";
router.use(prefix, async (req, res, next) => {
	try {
		res.locals["ciag"] = await service.authenticate(req.headers.authorization);
		next();
	} catch (error) {
		const e = error as { status?: number; message?: string };
		res.status(e.status ?? 503).json({ error: e.status ? e.message : "Integração indisponível." });
	}
});
router.use(prefix, json({ limit: "1mb" }));
const scope = (res: Response) => res.locals["ciag"] as CiagIntegration;
const route = (method: "get" | "post", path: string, fn: (req: Request, res: Response) => Promise<unknown>) => {
	router[method](prefix + path, async (req, res) => {
		try {
			const result = await fn(req, res);
			if (!res.headersSent) res.json(result);
		} catch (error) {
			const e = error as { status?: number; message?: string };
			if (!res.headersSent)
				res.status(e.status ?? 503).json({
					error: e.status ? e.message : "Serviço indisponível. Tente novamente."
				});
		}
	});
};
route("get", "/status", async (req, res) => service.status(scope(res), req.query["test"] === "true"));
route("get", "/contacts", async (_req, res) => service.contacts(scope(res)));
route("post", "/contacts/upsert", async (req, res) =>
	service.summary(scope(res), await service.contact(scope(res), req.body.phone, req.body.name))
);
route("post", "/contacts/consent", async (req, res) => service.consent(scope(res), req.body));
route("get", "/templates", async (req, res) => service.templates(scope(res), req.query["refresh"] === "true"));
route("post", "/content/validate", async (req, res) => {
	await service.content(scope(res), req.body.content);
	return { ok: true };
});
route("get", "/messages", async (req, res) => service.messages(scope(res), req.query["phone"], req.query["beforeId"]));
route("post", "/messages/read", async (req, res) => {
	await service.read(scope(res), req.body.phone);
	return { ok: true };
});
route("post", "/messages", async (req, res) => service.submit(scope(res), req.body));
route("get", "/messages/result", async (req, res) => service.result(scope(res), req.query["externalId"]));
route("post", "/messages/cancel", async (req, res) => service.cancel(scope(res), req.body.externalId));
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 1, fieldSize: 20, parts: 2 }
});
router.post(prefix + "/media", upload.single("file"), async (req, res) => {
	try {
		check(req.file, "Anexe um arquivo.");
		res.json(await service.upload(scope(res), req.file, req.body.voice === "true"));
	} catch (error) {
		const e = error as { status?: number; message?: string };
		res.status(e.status ?? 503).json({ error: e.status ? e.message : "Falha ao armazenar arquivo." });
	}
});
route("get", "/media/:id", async (req, res) => {
	const { file, data } = await service.download(scope(res), Number(req.params["id"]));
	res.setHeader("Content-Type", file.mime_type);
	res.setHeader("X-File-Name", encodeURIComponent(file.name));
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.send(data);
});
router.use(prefix, (_req, res) => {
	res.status(404).json({ error: "Rota não encontrada." });
});
export default router;
