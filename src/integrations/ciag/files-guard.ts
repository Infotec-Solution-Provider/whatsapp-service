import { createHash, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

interface Owners {
	file(id: number): Promise<string | null>;
	publicFile(id: string): Promise<string | null>;
	keyHash(): string | undefined;
}

export function allowCiagFilesAccess(req: Request, res: Response, instance: string | null, expected?: string): boolean {
	if (instance !== "ciag") return true;
	const header = req.headers["x-ciag-files-key"], hash = expected ?? process.env["CIAG_FILES_SERVICE_KEY_HASH"];
	if (typeof header === "string" && header.length <= 300 && hash && /^[a-f0-9]{64}$/.test(hash) &&
		timingSafeEqual(createHash("sha256").update(header).digest(), Buffer.from(hash, "hex"))) return true;
	res.status(401).json({ message: "Arquivo CIAG requer autenticação de serviço." });
	return false;
}

// Protect the underlying legacy file URLs as well as the authenticated CIAG proxy.
export function createCiagFilesGuard(owners: Owners) {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			let instance: string | null = null;
			const file = /^\/api\/files\/(\d+)(?:\/(?:metadata|view|scoped))?\/?$/.exec(req.path);
			const publicFile = /^\/public\/[^/]+\/files\/([^/]+)\/?$/.exec(req.path);
			if (file) instance = await owners.file(Number(file[1]));
			else if (publicFile) instance = await owners.publicFile(decodeURIComponent(publicFile[1]!));
			else if (req.path === "/api/waba/get-media-id" && Number.isSafeInteger(req.body?.fileId))
				instance = await owners.file(req.body.fileId);
			else if (req.path === "/api/files/exists" && req.query["instance"] === "ciag") instance = "ciag";
			else if (req.body?.instance === "ciag") instance = "ciag";
			if (allowCiagFilesAccess(req, res, instance, owners.keyHash())) next();
		} catch {
			res.status(503).json({ message: "Não foi possível conferir o acesso ao arquivo." });
		}
	};
}
