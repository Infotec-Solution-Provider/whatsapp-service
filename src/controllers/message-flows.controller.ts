import { Request, Response, Router } from "express";
import messageFlowsService from "../services/message-flows.service";

class MessageFlowsController {
	public readonly router: Router;

	constructor() {
		this.router = Router();
		this.setupRoutes();
	}

	private setupRoutes() {
		// Listar todos os fluxos
		this.router.get("/api/message-flows", this.listFlows.bind(this));

		// Buscar fluxo específico
		this.router.get("/api/message-flows/:id", this.getFlow.bind(this));

		// Buscar fluxo por instância e setor
		this.router.get(
			"/api/message-flows/by-instance/:instance/:sectorId",
			this.getFlowByInstanceAndSector.bind(this)
		);

		// Criar novo fluxo
		this.router.post("/api/message-flows", this.createFlow.bind(this));

		// Atualizar fluxo
		this.router.put("/api/message-flows/:id", this.updateFlow.bind(this));

		// Deletar fluxo
		this.router.delete("/api/message-flows/:id", this.deleteFlow.bind(this));

		// Validar fluxo
		this.router.get("/api/message-flows/:id/validate", this.validateFlow.bind(this));

		// Duplicar fluxo
		this.router.post("/api/message-flows/:id/duplicate", this.duplicateFlow.bind(this));

		// Adicionar step ao fluxo
		this.router.post("/api/message-flows/:id/steps", this.createStep.bind(this));

		// Atualizar step
		this.router.put("/api/message-flows/steps/:stepId", this.updateStep.bind(this));

		// Deletar step
		this.router.delete("/api/message-flows/steps/:stepId", this.deleteStep.bind(this));

		// Reordenar steps
		this.router.post("/api/message-flows/:id/reorder", this.reorderSteps.bind(this));

		// Listar tipos de steps disponíveis
		this.router.get("/api/message-flows/meta/step-types", this.getStepTypes.bind(this));
	}

	/**
	 * GET /message-flows
	 * Lista todos os fluxos
	 */
	private async listFlows(req: Request, res: Response) {
		const { instance, sectorId } = req.query;

		const flows = await messageFlowsService.listFlows(
			instance as string | undefined,
			sectorId ? Number(sectorId) : undefined
		);

		res.json(flows);
	}

	/**
	 * GET /message-flows/:id
	 * Busca um fluxo específico
	 */
	private async getFlow(req: Request, res: Response) {
		const { id } = req.params;
		const flow = await messageFlowsService.getFlow(Number(id));
		res.json(flow);
	}

	/**
	 * GET /message-flows/by-instance/:instance/:sectorId
	 * Busca fluxo por instância e setor
	 */
	private async getFlowByInstanceAndSector(req: Request, res: Response) {
		const { instance, sectorId } = req.params;

		if (!instance || !sectorId) {
			res.status(400).json({ error: "instance and sectorId are required" });
			return;
		}

		const flow = await messageFlowsService.getFlowByInstanceAndSector(instance, Number(sectorId));

		if (!flow) {
			res.status(404).json({ error: "Flow not found" });
			return;
		}

		res.json(flow);
	}

	/**
	 * POST /message-flows
	 * Cria um novo fluxo
	 */
	private async createFlow(req: Request, res: Response) {
		const { instance, sectorId, description } = req.body;

		if (!instance || sectorId === undefined) {
			res.status(400).json({ error: "instance and sectorId are required" });
			return;
		}

		const flow = await messageFlowsService.createFlow({
			instance,
			sectorId: Number(sectorId),
			description
		});

		res.status(201).json(flow);
	}

	/**
	 * PUT /message-flows/:id
	 * Atualiza um fluxo
	 */
	private async updateFlow(req: Request, res: Response) {
		const { id } = req.params;
		const { description } = req.body;

		const flow = await messageFlowsService.updateFlow(Number(id), {
			description
		});

		res.json(flow);
	}

	/**
	 * DELETE /message-flows/:id
	 * Deleta um fluxo
	 */
	private async deleteFlow(req: Request, res: Response) {
		const { id } = req.params;
		await messageFlowsService.deleteFlow(Number(id));
		res.status(204).send();
	}

	/**
	 * GET /message-flows/:id/validate
	 * Valida a integridade de um fluxo
	 */
	private async validateFlow(req: Request, res: Response) {
		const { id } = req.params;
		const validation = await messageFlowsService.validateFlow(Number(id));
		res.json(validation);
	}

	/**
	 * POST /message-flows/:id/duplicate
	 * Duplica um fluxo para outra instância/setor
	 */
	private async duplicateFlow(req: Request, res: Response) {
		const { id } = req.params;
		const { targetInstance, targetSectorId } = req.body;

		if (!targetInstance || targetSectorId === undefined) {
			res.status(400).json({ error: "targetInstance and targetSectorId are required" });
			return;
		}

		const newFlowId = await messageFlowsService.duplicateFlow(Number(id), targetInstance, Number(targetSectorId));

		res.status(201).json({ newFlowId });
	}

	/**
	 * POST /message-flows/:id/steps
	 * Adiciona um step ao fluxo
	 */
	private async createStep(req: Request, res: Response) {
		const { id } = req.params;
		const { type, stepNumber, nextStepId, fallbackStepId, config, connections, enabled, description } = req.body;

		if (!type || stepNumber === undefined) {
			res.status(400).json({ error: "type and stepNumber are required" });
			return;
		}

		const stepData: any = {
			type,
			stepNumber: Number(stepNumber),
			config,
			connections,
			enabled,
			description
		};

		if (nextStepId !== undefined) {
			stepData.nextStepId = nextStepId !== null ? Number(nextStepId) : null;
		}

		if (fallbackStepId !== undefined) {
			stepData.fallbackStepId = fallbackStepId !== null ? Number(fallbackStepId) : null;
		}

		const step = await messageFlowsService.createStep(Number(id), stepData);

		res.status(201).json(step);
	}

	/**
	 * PUT /message-flows/steps/:stepId
	 * Atualiza um step
	 */
	private async updateStep(req: Request, res: Response) {
		const { stepId } = req.params;
		const { type, stepNumber, nextStepId, fallbackStepId, config, connections, enabled, description } = req.body;

		const updateData: any = {};

		if (type !== undefined) updateData.type = type;
		if (stepNumber !== undefined) updateData.stepNumber = Number(stepNumber);
		if (nextStepId !== undefined) updateData.nextStepId = nextStepId !== null ? Number(nextStepId) : null;
		if (fallbackStepId !== undefined)
			updateData.fallbackStepId = fallbackStepId !== null ? Number(fallbackStepId) : null;
		if (config !== undefined) updateData.config = config;
		if (connections !== undefined) updateData.connections = connections;
		if (enabled !== undefined) updateData.enabled = enabled;
		if (description !== undefined) updateData.description = description;

		const step = await messageFlowsService.updateStep(Number(stepId), updateData);

		res.json(step);
	}

	/**
	 * DELETE /message-flows/steps/:stepId
	 * Deleta um step
	 */
	private async deleteStep(req: Request, res: Response) {
		const { stepId } = req.params;
		await messageFlowsService.deleteStep(Number(stepId));
		res.status(204).send();
	}

	/**
	 * POST /message-flows/:id/reorder
	 * Reordena steps de um fluxo
	 */
	private async reorderSteps(req: Request, res: Response) {
		const { id } = req.params;
		const { stepOrders } = req.body;

		if (!Array.isArray(stepOrders)) {
			res.status(400).json({ error: "stepOrders must be an array" });
			return;
		}

		await messageFlowsService.reorderSteps(
			Number(id),
			stepOrders.map((item) => ({
				stepId: Number(item.stepId),
				stepNumber: Number(item.stepNumber)
			}))
		);

		res.status(204).send();
	}

	/**
	 * GET /message-flows/meta/step-types
	 * Lista tipos de steps disponíveis
	 */
	private async getStepTypes(_req: Request, res: Response) {
		const types = await messageFlowsService.getAvailableStepTypes();
		res.json(types);
	}
}

export default new MessageFlowsController();
