import "dotenv/config";
import prismaService from "../services/prisma.service";
import { readPanelSettings } from "../migration-panel/config";
import MigrationPanelServer from "../migration-panel/panel-server";
import MigrationRunner from "../migration-panel/migration-runner";

const settings = readPanelSettings();
const runner = new MigrationRunner(settings.outputDir);
const panel = new MigrationPanelServer(settings, runner);

const server = panel.app.listen(settings.port, settings.host, () => {
	console.log(`[MigrationPanel] Painel disponível em http://${settings.host}:${settings.port}`);
	if (!settings.token) {
		console.warn("[MigrationPanel] MIGRATION_PANEL_TOKEN não definido; use somente em localhost ou defina um token");
	}
});

const shutdown = async (): Promise<void> => {
	server.close(async () => {
		await prismaService.$disconnect();
		process.exit(0);
	});
};

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
