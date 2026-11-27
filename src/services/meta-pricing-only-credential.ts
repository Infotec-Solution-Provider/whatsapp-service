import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readMetaPricingOnlyCredential(instance: string, clientId: number): Promise<string | null> {
	const registry = process.env["WHATSAPP_TENANT_SQL_REGISTRY"];
	if (!registry || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(instance) || !Number.isSafeInteger(clientId) || clientId <= 0) return null;

	// Keep analytical credentials outside the client row used by the message router.
	const path = join(dirname(registry), "meta-pricing-only", `${instance}-${clientId}.token`);
	try {
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size === 0 || stat.size > 4096 ||
				(process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return null;
			const token = (await file.readFile("utf8")).trim();
			return token && !/\s/.test(token) ? token : null;
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
