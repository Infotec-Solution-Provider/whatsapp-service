import "dotenv/config";
import { randomBytes, createHash } from "crypto";
import prisma from "../services/prisma.service";
async function main() {
	const instance = process.env["CIAG_INSTANCE"],
		clientId = Number(process.env["CIAG_CLIENT_ID"]),
		sectorId = Number(process.env["CIAG_SECTOR_ID"]);
	if (!instance || !Number.isSafeInteger(clientId) || !Number.isSafeInteger(sectorId))
		throw new Error("Informe CIAG_INSTANCE, CIAG_CLIENT_ID e CIAG_SECTOR_ID.");
	const client = await prisma.wppClient.findFirst({
		where: { id: clientId, instance, type: "WABA", isActive: true, sectors: { some: { id: sectorId, instance } } }
	});
	if (!client?.WABAPhoneId || !client.WABAAccountId || !client.WABAToken)
		throw new Error("Configure primeiro a conexão WABA oficial e o setor exclusivo do CIAG.");
	const id = "ciag:" + instance;
	const duplicate = await prisma.ciagIntegration.findFirst({
		where: { active: true, OR: [{ instance }, { clientId }], id: { not: id } }
	});
	if (duplicate) throw new Error("A instância ou conexão já pertence a outra integração.");
	const key = randomBytes(32).toString("base64url"),
		keyHash = createHash("sha256").update(key).digest("hex");
	await prisma.ciagIntegration.upsert({
		where: { id },
		create: { id, keyHash, instance, clientId, sectorId },
		update: { keyHash, instance, clientId, sectorId, active: true }
	});
	// Intentionally display the newly generated credential once, only on this administrative CLI.
	process.stdout.write("Configure no ambiente privado do servidor CIAG:\nINPULSE_API_KEY=" + key + "\n");
}
main()
	.catch(() => {
		console.error("Provisionamento não concluído. Verifique a instância, conexão, setor e migrações.");
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
