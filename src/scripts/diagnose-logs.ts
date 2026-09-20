import "dotenv/config";
import { databaseErrorCode } from "../database/managed-mysql";
import processLogs from "../logs/service";

const report = (event: string, details: object) => console.info(JSON.stringify(
	{ component: "process-logs-diagnose", event, ...details },
	(_key, value) => typeof value === "bigint" ? value.toString() : value,
));

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.info("Usage: diagnose-logs [--write-probe]\nDefault: read-only identity, store state and latest row.\n--write-probe: also insert and read back ONE synthetic log through the application writer.\nRun with the same cwd and environment as the application. No cleanup or migration is run.");
		return;
	}
	if (args.some(arg => arg !== "--write-probe")) {
		report("error", { code: "INVALID_ARGUMENTS" }); process.exitCode = 1; return;
	}
	const storage = process.env["PROCESS_LOG_STORAGE"] || "legacy";
	report("starting", { diagnosticsVersion: 2, cwd: process.cwd(), module: __filename, storage: ["legacy", "dedicated"].includes(storage) ? storage : "invalid" });
	try {
		report("inspection", await processLogs.inspect());
		if (args.includes("--write-probe")) {
			const result = await processLogs.probe();
			report("write-probe", result);
			if (!result.verified) process.exitCode = 1;
		}
	} catch (error) {
		report("error", { code: databaseErrorCode(error) }); process.exitCode = 1;
	} finally {
		await processLogs.stop();
		// The application owns Prisma's lifetime; this standalone process must close it.
		const prismaPath = require.resolve("../services/prisma.service");
		const prisma = require.cache[prismaPath]?.exports.default as typeof import("../services/prisma.service").default | undefined;
		await prisma?.$disconnect();
	}
}

void main().catch(error => { report("error", { code: databaseErrorCode(error) }); process.exitCode = 1; });
