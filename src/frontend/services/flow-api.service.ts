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

class FlowApiService {
	private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
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
			throw new Error(error.message || "Request failed");
		}

		const data = await response.json();
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
		return this.request<FlowStep[]>(`/message-flows/${flowId}/steps`);
	}

	async getStep(stepId: number): Promise<FlowStep> {
		return this.request<FlowStep>(`/message-flows/steps/${stepId}`);
	}

	async createStep(flowId: number, data: CreateStepDTO): Promise<FlowStep> {
		return this.request<FlowStep>(`/message-flows/${flowId}/steps`, {
			method: "POST",
			body: JSON.stringify(data)
		});
	}

	async updateStep(stepId: number, data: UpdateStepDTO): Promise<FlowStep> {
		return this.request<FlowStep>(`/message-flows/steps/${stepId}`, {
			method: "PUT",
			body: JSON.stringify(data)
		});
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
