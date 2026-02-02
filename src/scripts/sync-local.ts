import localSyncService from "../services/local-sync.service";

interface SyncOptions {
	skipContacts?: boolean;
	skipSectors?: boolean;
	skipChats?: boolean;
	skipMessages?: boolean;
	skipSchedules?: boolean;
}

async function main() {
	const args = process.argv.slice(2);
	const instance = args.find((arg) => !arg.startsWith("--"));
	
	const options: SyncOptions = {
		skipContacts: args.includes("--skip-contacts"),
		skipSectors: args.includes("--skip-sectors"),
		skipChats: args.includes("--skip-chats"),
		skipMessages: args.includes("--skip-messages"),
		skipSchedules: args.includes("--skip-schedules")
	};

	console.log("\n=== Local Sync Script ===\n");
	
	if (instance) {
		console.log(`Sincronizando instancia: ${instance}`);
		await localSyncService.syncInstance(instance, options);
	} else {
		console.log("Sincronizando todas as instancias");
		await localSyncService.syncAllInstances(options);
	}
	
	console.log("\n=== Sincronizacao concluida ===\n");
	process.exit(0);
}

main().catch((error) => {
	console.error("\n=== Erro na sincronizacao ===");
	console.error(error);
	process.exit(1);
});
