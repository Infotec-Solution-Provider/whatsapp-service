import express, { NextFunction, Request, Response } from "express";
import { MigrationPanelSettings, parseMigrationConfig } from "./config";
import migrationPanelHtml from "./panel-html";
import MigrationRunner from "./migration-runner";
import { MigrationPhase } from "./types";

const phases: MigrationPhase[] = ["preflight", "provision", "load", "validate", "cutover", "rollback"];

class MigrationPanelServer {
	public readonly app = express();

	constructor(
		private readonly settings: MigrationPanelSettings,
		private readonly runner: MigrationRunner,
	) {
		this.app.use(express.json({ limit: "256kb" }));
		this.app.get("/", this.home.bind(this));
		this.app.use(this.authenticate.bind(this));
		this.app.get("/api/migration-panel/health", this.health.bind(this));
		this.app.get("/api/migration-panel/runs", this.listRuns.bind(this));
		this.app.post("/api/migration-panel/runs", this.createRun.bind(this));
		this.app.get("/api/migration-panel/runs/:runId", this.getRun.bind(this));
		this.app.post("/api/migration-panel/runs/:runId/phases", this.requestPhase.bind(this));
		this.app.use(this.errorHandler.bind(this));
	}

	private authenticate(req: Request, res: Response, next: NextFunction): void {
		if (!this.settings.token) {
			next();
			return;
		}
		const authorization = req.headers.authorization || "";
		if (authorization !== `Bearer ${this.settings.token}`) {
			res.status(401).json({ message: "Token do painel inválido ou ausente" });
			return;
		}
		next();
	}

	private home(_: Request, res: Response): void {
		res.type("html").send(migrationPanelHtml());
	}

	private async health(_: Request, res: Response): Promise<void> {
		res.json({ ok: true, host: this.settings.host, port: this.settings.port, authenticated: Boolean(this.settings.token) });
	}

	private async listRuns(_: Request, res: Response): Promise<void> {
		res.json({ runs: await this.runner.listRuns() });
	}

	private async createRun(req: Request, res: Response): Promise<void> {
		const config = parseMigrationConfig(req.body, this.settings);
		const run = await this.runner.createRun(config);
		res.status(201).json({ run });
	}

	private async getRun(req: Request, res: Response): Promise<void> {
		const runId = req.params["runId"];
		if (typeof runId !== "string") {
			res.status(400).json({ message: "Identificador de migra\u00e7\u00e3o inv\u00e1lido" });
			return;
		}
		const run = await this.runner.getRun(runId);
		if (!run) {
			res.status(404).json({ message: "Migração não encontrada" });
			return;
		}
		res.json({ run });
	}

	private async requestPhase(req: Request, res: Response): Promise<void> {
		const phase = req.body?.phase as MigrationPhase;
		if (!phases.includes(phase)) {
			res.status(400).json({ message: `Fase inválida. Use: ${phases.join(", ")}` });
			return;
		}
		const runId = req.params["runId"];
		if (typeof runId !== "string") {
			res.status(400).json({ message: "Identificador de migra\u00e7\u00e3o inv\u00e1lido" });
			return;
		}
		const run = await this.runner.requestPhase(runId, phase);
		res.status(202).json({ run });
	}

	private errorHandler(error: unknown, _: Request, res: Response, __: NextFunction): void {
		const message = error instanceof Error ? error.message : String(error);
		res.status(400).json({ message });
	}
}

export default MigrationPanelServer;
