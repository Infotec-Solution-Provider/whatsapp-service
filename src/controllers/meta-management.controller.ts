import { UnauthorizedError } from "@rgranatodutra/http-errors";
import { Router, json, type ErrorRequestHandler, type RequestHandler } from "express";
import multer from "multer";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import { MetaGraphError } from "../services/meta-management.graph";
import metaManagement from "../services/meta-management.service";
import { META_PHOTO_MAX_BYTES, parseMetaPhoto, parseMetaProfilePatch, parseMetaTemplateFilters, parseMetaTemplateInput } from "../services/meta-management.validation";
import parameters from "../services/parameters.service";

const router = Router();
const parseJson = json({ limit: "32kb" });
const uploadPhoto = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: META_PHOTO_MAX_BYTES + 1, files: 1, fields: 0, parts: 2 }
}).single("photo");
const parsePhoto: RequestHandler = (req, res, next) => uploadPhoto(req, res, (error: unknown) => {
	if (error && !(error instanceof multer.MulterError)) {
		next(new MetaGraphError(400, "META_INVALID_PHOTO", "Envie a foto no formato esperado."));
		return;
	}
	next(error);
});

function parseClientId(input: unknown): number {
	if (typeof input !== "string" || !/^[1-9]\d{0,9}$/.test(input) || Number(input) > 2147483647) {
		throw new MetaGraphError(400, "META_INVALID_CLIENT_ID", "Selecione um canal oficial válido.");
	}
	return Number(input);
}

router.use(isAuthenticated, isAdmin, async (req, _res, next) => {
	if (!(await parameters.isMetaManagementEnabled(req.session.instance))) {
		throw new MetaGraphError(403, "META_MANAGEMENT_DISABLED", "O gerenciamento Meta está indisponível nesta instância.");
	}
	next();
});

router.get("/channels", async (req, res) => {
	res.json({ channels: await metaManagement.listChannels(req.session.instance) });
});

router.get("/channels/:clientId/number", async (req, res) => {
	res.json({ number: await metaManagement.getNumber(req.session.instance, parseClientId(req.params["clientId"])) });
});

router.get("/channels/:clientId/templates", async (req, res) => {
	res.json(await metaManagement.listTemplates(req.session.instance, parseClientId(req.params["clientId"]), parseMetaTemplateFilters(req.query)));
});

router.post("/channels/:clientId/templates", parseJson, async (req, res) => {
	const template = await metaManagement.createTemplate(req.session, parseClientId(req.params["clientId"]), parseMetaTemplateInput(req.body));
	res.status(201).json({ template });
});

router.get("/numbers/:clientId/profile", async (req, res) => {
	res.json({ profile: await metaManagement.getProfile(req.session.instance, parseClientId(req.params["clientId"])) });
});

router.patch("/numbers/:clientId/profile", parseJson, async (req, res) => {
	const profile = await metaManagement.updateProfile(req.session, parseClientId(req.params["clientId"]), parseMetaProfilePatch(req.body));
	res.json({ profile });
});

router.post("/numbers/:clientId/photo", parsePhoto, async (req, res) => {
	const profile = await metaManagement.updatePhoto(req.session, parseClientId(req.params["clientId"]), parseMetaPhoto(req.file));
	res.json({ profile });
});

const handleMetaError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
	if (error instanceof MetaGraphError) {
		res.status(error.status).json({ message: error.message, code: error.code });
		return;
	}
	if (error instanceof UnauthorizedError) {
		res.status(403).json({ message: "Acesso restrito a administradores.", code: "META_ADMIN_REQUIRED" });
		return;
	}
	if (error instanceof multer.MulterError) {
		const tooLarge = error.code === "LIMIT_FILE_SIZE";
		res.status(tooLarge ? 413 : 400).json({ message: tooLarge ? "A foto excede o tamanho permitido." : "Selecione uma única foto.", code: "META_INVALID_PHOTO" });
		return;
	}
	if (error instanceof Error && "type" in error) {
		const tooLarge = error.type === "entity.too.large";
		res.status(tooLarge ? 413 : 400).json({ message: tooLarge ? "O conteúdo excede o tamanho permitido." : "O conteúdo da solicitação é inválido.", code: "META_INVALID_REQUEST" });
		return;
	}
	res.status(500).json({ message: "Não foi possível concluir a operação na Meta.", code: "META_MANAGEMENT_FAILED" });
};

router.use(handleMetaError);

export default router;
