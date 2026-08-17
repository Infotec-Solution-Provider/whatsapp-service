import { mkdir, writeFile } from "fs/promises";
import path from "path";
import InstancesApiClient from "./instances-api";
import InstanceDataMigrator from "./instance-data-migrator";
import LegacyReader from "./legacy-reader";
import MigrationStore from "./migration-store";
import TargetProvisioner from "./target-provisioner";
import { redactMigrationConfig } from "./config";
import {
	MigrationInstanceConfig,
	MigrationLogEntry,
	MigrationPhase,
	MigrationRunSnapshot,
	MigrationRunStatus,
} from "./types";

class MigrationRunner {
	private readonly configs = new Map<string, MigrationInstanceConfig>();
	private readonly activeRuns = new Set<string>();
	private readonly store: MigrationStore;
	private readonly provisioner: TargetProvisioner;

	constructor(private readonly outputDir: string) {
		this.store = new MigrationStore();
		this.provisioner = new TargetProvisioner();
	}

	public async createRun(config: MigrationInstanceConfig): Promise<MigrationRunSnapshot> {
		const run = await this.store.createRun(config);
		this.configs.set(run.id, config);
		this.store.appendLog(run.id, "preflight", "info", "Migração criada; a pré-verificação foi agendada");
		void this.runPhase(run.id, "preflight");
		return (await this.store.getRun(run.id)) ?? run;
	}

	public async requestPhase(runId: string, phase: MigrationPhase): Promise<MigrationRunSnapshot> {
		const run = await this.store.getRun(runId);
		if (!run) throw new Error("Migração não encontrada");
		if (!this.configs.has(runId)) {
			throw new Error("A configuração secreta desta migração não está disponível neste processo; crie uma nova execução");
		}
		if (this.activeRuns.has(runId)) {
			throw new Error("A migração já possui uma fase em execução");
		}
		if (phase !== "rollback") {
			this.assertPhaseOrder(run, phase);
		}
		void this.runPhase(runId, phase);
		return run;
	}

	public async getRun(runId: string): Promise<MigrationRunSnapshot | null> {
		return this.store.getRun(runId);
	}

	public async listRuns(): Promise<MigrationRunSnapshot[]> {
		return this.store.listRuns();
	}

	private async runPhase(runId: string, phase: MigrationPhase): Promise<void> {
		if (this.activeRuns.has(runId)) return;
		const config = this.configs.get(runId);
		if (!config) return;
		this.activeRuns.add(runId);
		await this.store.updateRun(runId, { status: "RUNNING", currentPhase: phase });
		this.log(runId, phase, "info", `Iniciando fase ${phase}`);

		try {
			switch (phase) {
				case "preflight":
					await this.preflight(runId, config);
					break;
				case "provision":
					await this.provision(runId, config);
					break;
				case "load":
					await this.load(runId, config);
					break;
				case "validate":
					await this.validate(runId, config);
					break;
				case "cutover":
					await this.cutover(runId, config);
					break;
				case "rollback":
					await this.rollback(runId, config);
					break;
			}
			const status: MigrationRunStatus = phase === "rollback" ? "ROLLED_BACK" : "SUCCEEDED";
			await this.store.updateRun(runId, { status, currentPhase: phase });
			this.log(runId, phase, "info", `Fase ${phase} concluída`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(runId, phase, "error", message);
			await this.store.updateRun(runId, { status: "FAILED", currentPhase: phase });
		} finally {
			this.activeRuns.delete(runId);
		}
	}

	private async preflight(runId: string, config: MigrationInstanceConfig): Promise<void> {
		this.assertProviderConfiguration(config);
		const reader = new LegacyReader(config.source);
		try {
			await reader.testConnection();
			this.log(runId, "preflight", "info", "Conexão com o banco legado validada");
			const source = await reader.countTables();
			this.log(runId, "preflight", "info", "Contagem do banco legado obtida", { ...source.counts });
			const required: Array<"sectors" | "contacts" | "chats" | "messages"> = [];
			if (config.options.importSectors) required.push("sectors");
			if (config.options.importContacts) required.push("contacts");
			if (config.options.importChats) required.push("chats");
			if (config.options.importMessages) required.push("messages");
			for (const key of required) {
				const table = source.tables.find((item) => item.table === this.tableName(key));
				if (!table?.available) {
					throw new Error(`Tabela obrigatória do legado ausente ou inacessível: ${table?.table ?? key}`);
				}
			}

			const instancesApi = new InstancesApiClient(config.instancesApi);
			await instancesApi.health();
			this.log(runId, "preflight", "info", "instances-service acessível");
			const target = await this.provisioner.inspect(config);
			this.log(runId, "preflight", "info", "Inspeção do alvo concluída", target.dataCounts);
			if (target.client?.isActive) {
				throw new Error("O cliente alvo já está ativo; interrompa o serviço atual ou escolha outra instância");
			}
			const targetDataTotal = Object.values(target.dataCounts).reduce((sum, count) => sum + count, 0);
			if (targetDataTotal > 0 && !config.options.allowExistingTargetData) {
				throw new Error("O alvo já possui dados; marque allowExistingTargetData apenas após revisar a inspeção");
			}
			if (targetDataTotal > 0) {
				this.log(runId, "preflight", "warning", "Alvo existente será reutilizado; a carga será idempotente por mapa", target.dataCounts);
			}
		} finally {
			await reader.close();
		}
	}

	private async provision(runId: string, config: MigrationInstanceConfig): Promise<void> {
		const client = await this.provisioner.ensure(config);
		this.log(runId, "provision", "info", `Instância e cliente provisionados: ${client.name}`, { clientId: client.id });
	}

	private async load(runId: string, config: MigrationInstanceConfig): Promise<void> {
		const target = await this.provisioner.inspect(config);
		if (!target.client) {
			throw new Error("Execute a fase provision antes da carga");
		}
		const reader = new LegacyReader(config.source);
		try {
			const migrator = new InstanceDataMigrator(
				this.store,
				(level, message, meta) => this.log(runId, "load", level, message, meta),
			);
			await migrator.load(config, reader, runId, target.client.id);
			if (config.options.syncLocalAfterLoad) {
				this.log(runId, "load", "warning", "syncLocalAfterLoad foi solicitado, mas deve ser executado pelo comando sync:local:instance após revisar a carga");
			}
		} finally {
			await reader.close();
		}
	}

	private async validate(runId: string, config: MigrationInstanceConfig): Promise<void> {
		const reader = new LegacyReader(config.source);
		try {
			const source = await reader.countTables();
			const target = await this.provisioner.targetCounts(config.targetInstance);
			this.log(runId, "validate", "info", "Contagens comparativas calculadas", { source: source.counts, target });
			const checks: Array<[
				keyof typeof source.counts,
				keyof typeof target,
				"importSectors" | "importChats" | "importMessages",
			]> = [
				["sectors", "sectors", "importSectors"],
				["chats", "chats", "importChats"],
				["messages", "messages", "importMessages"],
			];
			for (const [sourceKey, targetKey, option] of checks) {
				const targetCount = target[targetKey] ?? 0;
				if (config.options[option]
					&& targetCount < source.counts[sourceKey]) {
					this.log(runId, "validate", "warning", `A contagem alvo de ${sourceKey} é menor que a origem`, {
						source: source.counts[sourceKey],
						target: targetCount,
					});
				}
			}
			this.log(runId, "validate", "info", "Validação concluída; diferenças foram registradas como avisos, sem apagar dados");
		} finally {
			await reader.close();
		}
	}

	private async cutover(runId: string, config: MigrationInstanceConfig): Promise<void> {
		const client = await this.provisioner.activate(config);
		if (config.options.generateRuntimeConfig) {
			const generated = await this.generateRuntimeConfig(config, client.id);
			this.log(runId, "cutover", "info", `Configuração de runtime gerada: ${generated}`);
		}
		this.log(runId, "cutover", "warning", "Cliente ativado. Ainda é necessário recarregar whatsapp-service e iniciar/recarregar o processo remoto; nenhum processo foi reiniciado pelo painel", { clientId: client.id });
	}

	private async rollback(runId: string, config: MigrationInstanceConfig): Promise<void> {
		await this.provisioner.deactivate(config);
		this.log(runId, "rollback", "warning", "Cliente desativado. Dados importados e instância do instances-service foram preservados; nenhuma exclusão automática foi executada");
	}

	private async generateRuntimeConfig(config: MigrationInstanceConfig, clientId: number): Promise<string> {
		const outputDir = path.resolve(process.cwd(), this.outputDir);
		await mkdir(outputDir, { recursive: true });
		const safeName = config.targetInstance.replace(/[^a-zA-Z0-9_-]/g, "_");
		const redactedPath = path.join(outputDir, `${safeName}.migration.json`);
		await writeFile(redactedPath, JSON.stringify({ generatedAt: new Date().toISOString(), clientId, config: redactMigrationConfig(config) }, null, 2), { encoding: "utf8", mode: 0o600 });
		if (config.provider !== "REMOTE") {
			return redactedPath;
		}
		const envPath = path.join(outputDir, `${safeName}.wwebjs-api.env`);
		const eventEndpoint = `${config.remoteClientUrl.replace(/\/$/, "")}/api/whatsapp/remote/:clientId/event`;
		const content = [
			`# Gerado pelo painel em ${new Date().toISOString()}`,
			`INSTANCE_NAME=${config.targetInstance}`,
			`CLIENT_ID=${clientId}`,
			`SESSION_ID=${config.targetInstance}-${clientId}`,
			`WPP_EVENT_ENDPOINTS=${eventEndpoint}`,
			"API_LISTEN_PORT=727",
			`MYSQL_HOST=${config.runtimeDatabase.host}`,
			`MYSQL_PORT=${config.runtimeDatabase.port}`,
			`MYSQL_USER=${config.runtimeDatabase.user}`,
			"MYSQL_PASSWORD=PREENCHE_MANUALMENTE_SE_NECESSARIO",
			`MYSQL_DATABASE=${config.runtimeDatabase.database}`,
		].join("\n") + "\n";
		await writeFile(envPath, content, { encoding: "utf8", mode: 0o600 });
		return envPath;
	}

	private assertProviderConfiguration(config: MigrationInstanceConfig): void {
		if (config.provider === "REMOTE" && !config.remoteClientUrl) {
			throw new Error("remoteClientUrl é obrigatório para o provider REMOTE");
		}
		if (config.provider === "WABA" && (!config.wabaPhoneId || !config.wabaToken)) {
			throw new Error("wabaPhoneId e wabaToken são obrigatórios para o provider WABA");
		}
		if (config.provider === "GUPSHUP" && !config.gupshupToken) {
			throw new Error("gupshupToken é obrigatório para o provider GUPSHUP");
		}
	}

	private assertPhaseOrder(run: MigrationRunSnapshot, phase: MigrationPhase): void {
		if (phase === "preflight") return;
		if (phase === "provision" && run.currentPhase !== "preflight" && run.currentPhase !== "provision") {
			throw new Error("Execute preflight antes de provision");
		}
		if (phase === "load" && run.currentPhase !== "provision" && run.currentPhase !== "load") {
			throw new Error("Execute provision antes de load");
		}
		if (phase === "validate" && run.currentPhase !== "load" && run.currentPhase !== "validate") {
			throw new Error("Execute load antes de validate");
		}
		if (phase === "cutover" && run.currentPhase !== "validate" && run.currentPhase !== "cutover") {
			throw new Error("Execute validate antes de cutover");
		}
	}

	private log(
		runId: string,
		phase: MigrationPhase,
		level: MigrationLogEntry["level"],
		message: string,
		meta?: Record<string, unknown>,
	): void {
		this.store.appendLog(runId, phase, level, message, meta);
	}

	private tableName(key: "sectors" | "contacts" | "chats" | "messages"): string {
		return {
			sectors: "w_setores",
			contacts: "w_clientes_numeros",
			chats: "w_atendimentos",
			messages: "w_mensagens",
		}[key];
	}
}

export default MigrationRunner;
