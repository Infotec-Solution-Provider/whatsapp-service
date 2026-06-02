import internalMessageWwebjsBackfillService from "../services/internal-message-wwebjs-backfill.service";

interface CliOptions {
	instance: string | undefined;
	chatId: number | undefined;
	groupId: string | undefined;
	fromId: number | undefined;
	toId: number | undefined;
	batchSize: number | undefined;
	limit: number | undefined;
	windowSeconds: number | undefined;
	maxLogCandidates: number | undefined;
	apply: boolean;
}

function readFlagValue(args: string[], name: string): string | undefined {
	const prefix = `${name}=`;
	const withValue = args.find((arg) => arg.startsWith(prefix));
	if (withValue) {
		return withValue.slice(prefix.length);
	}

	const index = args.findIndex((arg) => arg === name);
	if (index >= 0) {
		return args[index + 1];
	}

	return undefined;
}

function readNumericFlag(args: string[], name: string): number | undefined {
	const rawValue = readFlagValue(args, name);
	if (!rawValue) {
		return undefined;
	}

	const parsedValue = Number(rawValue);
	if (Number.isNaN(parsedValue)) {
		throw new Error(`Valor inválido para ${name}: ${rawValue}`);
	}

	return parsedValue;
}

function parseArgs(args: string[]): CliOptions {
	const instanceArg = args.find((arg) => !arg.startsWith("--"));

	return {
		instance: instanceArg,
		chatId: readNumericFlag(args, "--chat-id"),
		groupId: readFlagValue(args, "--group-id"),
		fromId: readNumericFlag(args, "--from-id"),
		toId: readNumericFlag(args, "--to-id"),
		batchSize: readNumericFlag(args, "--batch-size"),
		limit: readNumericFlag(args, "--limit"),
		windowSeconds: readNumericFlag(args, "--window-seconds"),
		maxLogCandidates: readNumericFlag(args, "--max-log-candidates"),
		apply: args.includes("--apply")
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	console.log("\n=== Internal Message WWEBJS Backfill ===\n");
	console.log(`Modo: ${options.apply ? "apply" : "dry-run"}`);
	if (options.instance) {
		console.log(`Instância: ${options.instance}`);
	}
	if (options.chatId) {
		console.log(`Chat ID: ${options.chatId}`);
	}
	if (options.groupId) {
		console.log(`Grupo WhatsApp: ${options.groupId}`);
	}

	const stats = await internalMessageWwebjsBackfillService.execute(options);

	console.log("\n=== Resumo ===");
	console.log(JSON.stringify(stats, null, 2));
	process.exit(0);
}

main().catch((error) => {
	console.error("\n=== Erro no backfill ===");
	console.error(error);
	process.exit(1);
});