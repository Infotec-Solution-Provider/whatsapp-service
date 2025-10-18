/**
 * Service for Message Flow API Communication
 */

import type {
    CreateFlowDTO,
    CreateStepDTO,
    DuplicateFlowDTO,
    Flow,
    FlowStep,
    ReorderStepsDTO,
    UpdateFlowDTO,
    UpdateStepDTO,
    ValidationResult,
    WppMessageFlowStepType
} from "../types/flow.types";

const API_BASE_URL = "/api";

/**
 * Mapeia dados brutos do backend para o formato esperado pelo frontend
 */
function mapStepData(rawStep: any): FlowStep {
	return {
		id: rawStep.id,
		flowId: rawStep.messageFlowId || rawStep.message_flow_id,
		stepNumber: rawStep.stepNumber || rawStep.step_number,
		stepType: rawStep.type || rawStep.stepType,
		nextStepId: rawStep.nextStepId || rawStep.next_step_id,
		fallbackStepId: rawStep.fallbackStepId || rawStep.fallback_step_id,
		config: rawStep.config || {},
		connections: rawStep.connections || null,
		description: rawStep.description,
		enabled: rawStep.enabled ?? true,
		createdAt: rawStep.createdAt || rawStep.created_at,
		updatedAt: rawStep.updatedAt || rawStep.updated_at
	};
}

class FlowApiService {
	private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
		console.log(`API Request: ${options.method || "GET"} ${endpoint}`, options.body ? JSON.parse(options.body as string) : "");
		
		const response = await fetch(`${API_BASE_URL}${endpoint}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...options.headers
			}
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({
				message: response.statusText
			}));
			console.error("API Error:", error);
			throw new Error(error.message || "Request failed");
		}

		const data = await response.json();
		console.log(`API Response: ${options.method || "GET"} ${endpoint}`, data);
		return data;
	}

	// Flow Management

	async listFlows(instance: string): Promise<Flow[]> {
		return this.request<Flow[]>(`/message-flows?instance=${instance}`);
	}

	async getFlow(id: number): Promise<Flow> {
		return this.request<Flow>(`/message-flows/${id}`);
	}

	async getFlowByInstanceAndSector(instance: string, sectorId: number): Promise<Flow> {
		return this.request<Flow>(`/message-flows?instance=${instance}&sectorId=${sectorId}`);
	}

	async createFlow(data: CreateFlowDTO): Promise<Flow> {
		return this.request<Flow>("/message-flows", {
			method: "POST",
			body: JSON.stringify(data)
		});
	}

	async updateFlow(id: number, data: UpdateFlowDTO): Promise<Flow> {
		return this.request<Flow>(`/message-flows/${id}`, {
			method: "PUT",
			body: JSON.stringify(data)
		});
	}

	async deleteFlow(id: number): Promise<{ message: string }> {
		return this.request<{ message: string }>(`/message-flows/${id}`, {
			method: "DELETE"
		});
	}

	// Step Management

	async listSteps(flowId: number): Promise<FlowStep[]> {
		const rawSteps = await this.request<any[]>(`/message-flows/${flowId}/steps`);
		return rawSteps.map(mapStepData);
	}

	async getStep(stepId: number): Promise<FlowStep> {
		const rawStep = await this.request<any>(`/message-flows/steps/${stepId}`);
		return mapStepData(rawStep);
	}

	async createStep(flowId: number, data: CreateStepDTO): Promise<FlowStep> {
		const rawStep = await this.request<any>(`/message-flows/${flowId}/steps`, {
			method: "POST",
			body: JSON.stringify(data)
		});
		return mapStepData(rawStep);
	}

	async updateStep(stepId: number, data: UpdateStepDTO): Promise<FlowStep> {
		const rawStep = await this.request<any>(`/message-flows/steps/${stepId}`, {
			method: "PUT",
			body: JSON.stringify(data)
		});
		return mapStepData(rawStep);
	}

	async deleteStep(stepId: number): Promise<{ message: string }> {
		return this.request<{ message: string }>(`/message-flows/steps/${stepId}`, {
			method: "DELETE"
		});
	}

	async reorderSteps(flowId: number, data: ReorderStepsDTO): Promise<{ message: string }> {
		return this.request<{ message: string }>(`/message-flows/${flowId}/reorder`, {
			method: "PUT",
			body: JSON.stringify(data)
		});
	}

	// Utilities

	async validateFlow(flowId: number): Promise<ValidationResult> {
		return this.request<ValidationResult>(`/message-flows/${flowId}/validate`, {
			method: "POST"
		});
	}

	async duplicateFlow(flowId: number, data: DuplicateFlowDTO): Promise<Flow> {
		return this.request<Flow>(`/message-flows/${flowId}/duplicate`, {
			method: "POST",
			body: JSON.stringify(data)
		});
	}

	async getAvailableStepTypes(): Promise<WppMessageFlowStepType[]> {
		return this.request<WppMessageFlowStepType[]>("/message-flows/meta/step-types");
	}
}

export const flowApiService = new FlowApiService();
export default flowApiService;
