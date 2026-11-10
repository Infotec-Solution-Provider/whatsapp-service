import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";

export interface OdimAccessOnlyProfile { enabled: boolean; state: "missing" | "valid" | "invalid" }
export const odimAccessOnlyProfilePath = resolve(__dirname, "../../config/odim-access-only.json");

/** A malformed/untrusted profile blocks Odim, without stopping any other tenant. */
export function readOdimAccessOnlyProfile(filename: string): OdimAccessOnlyProfile {
	let fd: number | undefined;
	try {
		let link;
		try { link = lstatSync(filename); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, state: "missing" };
			throw error;
		}
		if (link.isSymbolicLink() || !link.isFile() || link.size > 4096 ||
			realpathSync(dirname(filename)) !== resolve(dirname(filename))) throw new Error("Untrusted profile");
		fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > 4096 || (process.platform !== "win32" && (before.mode & 0o022) !== 0)) {
			throw new Error("Untrusted profile");
		}
		const raw = readFileSync(fd, "utf8");
		const after = fstatSync(fd);
		if (Buffer.byteLength(raw) > 4096 || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
			throw new Error("Changed profile");
		}
		const profile = JSON.parse(raw) as Record<string, unknown>;
		if (profile?.["version"] !== 1 || profile["instance"] !== "odim" || typeof profile["enabled"] !== "boolean" ||
			Object.keys(profile).sort().join(",") !== "enabled,instance,version") throw new Error("Invalid profile");
		return { enabled: profile["enabled"], state: "valid" };
	} catch {
		return { enabled: true, state: "invalid" };
	} finally { if (fd !== undefined) closeSync(fd); }
}

export const odimAccessOnlyProfile = readOdimAccessOnlyProfile(odimAccessOnlyProfilePath);
export const odimAccessOnlyEnabled = odimAccessOnlyProfile.enabled;

export function isOdimAccessOnly(instance: string): boolean {
	return odimAccessOnlyEnabled && typeof instance === "string" && instance.trim().toLowerCase() === "odim";
}

export class OdimAccessOnlyError extends Error {
	readonly statusCode = 423;
	readonly code = "ODIM_ACCESS_ONLY";
	constructor() { super("O canal da Odim permanece no sistema legado. Esta operação está bloqueada no sistema atual."); }
}

export function assertOdimChannelAllowed(instance: string): void {
	if (isOdimAccessOnly(instance)) throw new OdimAccessOnlyError();
}

export function odimProviderIngress(req: Request, res: Response, next: NextFunction): void {
	if (!isOdimAccessOnly(req.params["instance"] as string)) { next(); return; }
	const error = new OdimAccessOnlyError();
	res.status(error.statusCode).json({ message: error.message, code: error.code });
}

/** Exclusion before selecting/claiming work never consumes or acknowledges Odim jobs. */
export function odimQueueWhere() {
	return odimAccessOnlyEnabled ? { instance: { not: "odim" } } : {};
}

export function odimQueueSql(): string {
	return odimAccessOnlyEnabled ? " AND instance <> 'odim'" : "";
}

// Match the Express route template rather than an untrusted/encoded request path.
// Unknown/new operations stay unavailable in this temporary profile.
const LOCAL_READS = [
	/^\/api\/whatsapp\/(?:contacts(?:\/|$)|customer\/:id\/contacts$|session\/(?:chats|changes|monitor|parameters)$|chats(?:\/|$)|schedules(?:\/|$)|notifications(?:\/|$)|messages(?:\/|$)|conversations(?:\/|$)|sector\/:sectorId\/clients$)/,
	/^\/api\/(?:internal\/(?:session\/chats|chats|groups|monitor\/chats|whatsapp-senders)(?:\/|$)|ready-messages(?:\/|$)|wallets$|results(?:\/|$)|parameters(?:\/|$)|customer-profile-tags(?:\/|$))/,
	/^\/api\/whatsapp\/(?:sectors|users|transfers)$/,
	/^\/api\/whatsapp\/customers\/profile-tags\//,
];
const INTERNAL_WRITES = [
	"POST /api/internal/chats", "DELETE /api/internal/chats/:id", "POST /api/internal/chats/:id/finish",
	"POST /api/internal/chats/:id/messages", "PUT /api/internal/messages/:id", "POST /api/internal/messages/:id/reaction",
	"PUT /api/internal/groups/:id", "PUT /api/internal/groups/:id/image", "PATCH /api/internal/chat/:id/mark-as-read",
	"PATCH /api/whatsapp/notifications/mark-all-read", "PATCH /api/whatsapp/notifications/:id/read",
	"POST /api/whatsapp/customers/profile-tags/summary/batch",
];

export function odimLocalRequestAllowed(method: string, route: unknown): boolean {
	if (typeof route !== "string") return false;
	return (method === "GET" && LOCAL_READS.some(pattern => pattern.test(route))) || INTERNAL_WRITES.includes(`${method} ${route}`);
}
