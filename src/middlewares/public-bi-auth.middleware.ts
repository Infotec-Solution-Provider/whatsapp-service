import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import isAuthenticated from "./is-authenticated.middleware";
import { allowPublicBiAuthenticationAttempt } from "./public-bi-rate-limit.middleware";
import { normalizeDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";

export interface PublicBiServiceCredential {
	id: string;
	instance: string;
	sha256: string;
	expiresAt: string;
	disabled?: boolean;
}

export interface PublicBiServiceIdentity { id: string; instance: string }
const identities = new WeakMap<Request, PublicBiServiceIdentity>();
export const getPublicBiServiceIdentity = (req: Request) => identities.get(req);

export function parsePublicBiCredentials(input: unknown): PublicBiServiceCredential[] {
	if (!Array.isArray(input) || input.length > 128) throw new Error("Invalid BI service credential configuration");
	const hashes = new Set<string>();
	const principals = new Map<string, string>();
	for (const credential of input) {
		if (!credential || typeof credential !== "object" ||
			typeof credential.id !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(credential.id) ||
			!normalizeDatabaseTenant(credential.instance) ||
			typeof credential.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(credential.sha256) ||
			typeof credential.expiresAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(credential.expiresAt) ||
			!Number.isFinite(Date.parse(credential.expiresAt)) ||
			(credential.disabled !== undefined && typeof credential.disabled !== "boolean") ||
			hashes.has(credential.sha256) ||
			(principals.has(credential.id) && principals.get(credential.id) !== credential.instance)) {
			throw new Error("Invalid BI service credential configuration");
		}
		hashes.add(credential.sha256);
		principals.set(credential.id, credential.instance);
	}
	return input as PublicBiServiceCredential[];
}

/** Reload each service-token request: removal/disable/rotation takes effect without a restart. */
async function loadConfiguredCredentials(): Promise<PublicBiServiceCredential[]> {
	const filename = process.env["PUBLIC_BI_SERVICE_TOKENS_FILE"];
	if (!filename) return [];
	const file = await open(filename, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 65_536) throw new Error("Invalid BI service credential file");
		const raw = await file.readFile({ encoding: "utf8" });
		if (Buffer.byteLength(raw) > 65_536) throw new Error("Invalid BI service credential file");
		return parsePublicBiCredentials(JSON.parse(raw));
	} finally {
		await file.close();
	}
}

const ALLOWED_PATHS = [
	/^\/api\/whatsapp\/conversations(?:\/[1-9]\d*(?:\/messages)?)?\/?$/,
	/^\/api\/whatsapp\/(?:messages\/export|transfers|users|sectors)\/?$/
];
export function isPublicBiReadRoute(method: string, path: string): boolean {
	return method === "GET" && ALLOWED_PATHS.some(pattern => pattern.test(path));
}

function serviceToken(req: Request): string | null {
	const authorization = req.headers.authorization;
	if (typeof authorization !== "string") return null;
	const token = authorization.replace(/^Bearer\s+/i, "").trim();
	return token.startsWith("bi1_") ? token : null;
}

export function createPublicBiServiceTokenGuard(
	loadCredentials: () => Promise<PublicBiServiceCredential[]> = loadConfiguredCredentials,
	clock: () => number = Date.now
): RequestHandler {
	return async (req, res, next) => {
		const token = serviceToken(req);
		if (token === null) { next(); return; }
		// Installed before every controller, including routes without ordinary authentication.
		if (!isPublicBiReadRoute(req.method, req.path)) {
			res.status(403).json({ message: "BI service credentials only allow the documented read routes." });
			return;
		}
		if (!/^Bearer\s+/i.test(req.headers.authorization ?? "") || !/^bi1_[A-Za-z0-9_-]{43,128}$/.test(token)) {
			res.status(401).json({ message: "Invalid BI service credential." });
			return;
		}
		if (!allowPublicBiAuthenticationAttempt(req, res)) return;
		let credentials: PublicBiServiceCredential[];
		try { credentials = await loadCredentials(); }
		catch {
			res.status(503).json({ message: "BI service authentication is unavailable." });
			return;
		}
		const hash = createHash("sha256").update(token).digest();
		const credential = credentials.find(entry => timingSafeEqual(hash, Buffer.from(entry.sha256, "hex")));
		if (!credential || credential.disabled || Date.parse(credential.expiresAt) <= clock()) {
			res.status(401).json({ message: "Invalid or expired BI service credential." });
			return;
		}
		identities.set(req, { id: credential.id, instance: credential.instance });
		req.session = {
			instance: credential.instance, userId: 0, sectorId: 0,
			role: "BI_READ_ONLY", name: `BI:${credential.id}`
		};
		withDatabaseTenant(credential.instance, next);
	};
}

export const publicBiServiceTokenGuard = createPublicBiServiceTokenGuard();

/** Use only on the explicit BI GET routes. User authentication keeps its existing implementation. */
export default function publicBiAuthenticated(req: Request, res: Response, next: NextFunction) {
	if (getPublicBiServiceIdentity(req)) {
		if (!isPublicBiReadRoute(req.method, req.path)) {
			res.status(403).json({ message: "BI service credentials are read-only." });
			return;
		}
		withDatabaseTenant(req.session.instance, next);
		return;
	}
	// A missing global guard must never fall back to user authentication for an opaque credential.
	if (serviceToken(req) !== null) {
		res.status(401).json({ message: "Invalid BI service credential." });
		return;
	}
	if (!allowPublicBiAuthenticationAttempt(req, res)) return;
	return isAuthenticated(req, res, next);
}
