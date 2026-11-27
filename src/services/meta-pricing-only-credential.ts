import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

interface MetaPricingOnlyBinding {
	token: string;
	accountId: string;
	phoneId: string;
}

export async function readMetaPricingOnlyCredential(instance: string, clientId: number): Promise<MetaPricingOnlyBinding | null> {
	const registry = process.env["WHATSAPP_TENANT_SQL_REGISTRY"];
	if (!registry || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(instance) || !Number.isSafeInteger(clientId) || clientId <= 0) return null;

	// Keep analytical assets and credentials outside the client row used by the message and ingress routers.
	const path = join(dirname(registry), "meta-pricing-only", `${instance}-${clientId}.json`);
	try {
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size === 0 || stat.size > 8192 ||
				(process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return null;
			const { token, accountId, phoneId } = JSON.parse(await file.readFile("utf8")) as Partial<MetaPricingOnlyBinding>;
			const metaId = /^[1-9]\d{0,31}$/;
			if (typeof token !== "string" || !token || token.length > 4096 || /\s/.test(token) ||
				typeof accountId !== "string" || !metaId.test(accountId) ||
				typeof phoneId !== "string" || !metaId.test(phoneId)) return null;
			return { token, accountId, phoneId };
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
