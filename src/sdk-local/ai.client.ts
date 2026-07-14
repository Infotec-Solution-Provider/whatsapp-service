import ApiClient from "./api-client";
import type { DataResponse, FlexiblePaginatedResponse, PaginatedResponse } from "./types/response.types";
import type {
	AiAgentConfig,
	AiTenantConfig,
	AnalyzeCustomerRequest,
	AnalyzeCustomerResponse,
	CreateSupervisorAiSessionRequest,
	SuggestResponseRequest,
	SuggestResponseResponse,
	SupervisorAiSession,
	SupervisorAiSessionDetail,
	SummarizeChatRequest,
	SummarizeChatResponse,
	AiAgent,
	AiAgentChatSession,
	AiAgentActionLog,
	CreateAiAgentInput,
	UpdateAiAgentInput,
	AiAgentAudienceInput,
	AiAgentKnowledgeEntryInput,
	AiAgentActionLogFilters,
	PaginatedActionLogs,
	AiAgentAudiencePreview,
	SendSupervisorAiMessageRequest,
	SendSupervisorAiMessageResponse,
	AiUsageSummary,
} from "./types/ai.types";
import type { WppContactWithCustomer } from "./types/whatsapp.types";

export default class AiClient extends ApiClient {
	private authHeader(token: string) {
		return { Authorization: `Bearer ${token}` };
	}

	async suggestResponse(data: SuggestResponseRequest, token: string): Promise<SuggestResponseResponse> {
		const { data: res } = await this.ax.post<DataResponse<SuggestResponseResponse>>(
			"/api/ai/completions/suggest-response",
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async summarizeChat(data: SummarizeChatRequest, token: string): Promise<SummarizeChatResponse> {
		const { data: res } = await this.ax.post<DataResponse<SummarizeChatResponse>>(
			"/api/ai/completions/summarize-chat",
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async analyzeCustomer(data: AnalyzeCustomerRequest, token: string): Promise<AnalyzeCustomerResponse> {
		const { data: res } = await this.ax.post<DataResponse<AnalyzeCustomerResponse>>(
			"/api/ai/completions/analyze-customer",
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async listSupervisorSessions(token: string, status?: "ACTIVE" | "ARCHIVED"): Promise<SupervisorAiSession[]> {
		const query = status ? `?status=${status}` : "";
		const { data: res } = await this.ax.get<DataResponse<SupervisorAiSession[]>>(
			`/api/ai/supervisor-chat/sessions${query}`,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async createSupervisorSession(
		data: CreateSupervisorAiSessionRequest | undefined,
		token: string,
	): Promise<SupervisorAiSession> {
		const { data: res } = await this.ax.post<DataResponse<SupervisorAiSession>>(
			"/api/ai/supervisor-chat/sessions",
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async patchSupervisorSessionStatus(
		sessionId: number,
		status: "ACTIVE" | "ARCHIVED",
		token: string,
	): Promise<SupervisorAiSession> {
		const { data: res } = await this.ax.patch<DataResponse<SupervisorAiSession>>(
			`/api/ai/supervisor-chat/sessions/${sessionId}`,
			{ status },
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async getSupervisorSession(sessionId: number, token: string): Promise<SupervisorAiSessionDetail> {
		const { data: res } = await this.ax.get<DataResponse<SupervisorAiSessionDetail>>(
			`/api/ai/supervisor-chat/sessions/${sessionId}`,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async sendSupervisorMessage(
		sessionId: number,
		data: SendSupervisorAiMessageRequest,
		token: string,
	): Promise<SendSupervisorAiMessageResponse> {
		const { data: res } = await this.ax.post<DataResponse<SendSupervisorAiMessageResponse>>(
			`/api/ai/supervisor-chat/sessions/${sessionId}/messages`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async getTenantConfig(instance: string, token: string): Promise<AiTenantConfig> {
		const { data: res } = await this.ax.get<DataResponse<AiTenantConfig>>(
			`/api/ai/tenant-config/${instance}`,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async upsertTenantConfig(
		instance: string,
		data: Partial<AiTenantConfig>,
		token: string,
	): Promise<AiTenantConfig> {
		const { data: res } = await this.ax.put<DataResponse<AiTenantConfig>>(
			`/api/ai/tenant-config/${instance}`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async getAgentConfig(instance: string, token: string): Promise<AiAgentConfig | null> {
		const { data: res } = await this.ax.get<DataResponse<AiAgentConfig | null>>(
			`/api/ai/agent-config/${instance}`,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async upsertAgentConfig(
		instance: string,
		data: Partial<AiAgentConfig>,
		token: string,
	): Promise<AiAgentConfig> {
		const { data: res } = await this.ax.put<DataResponse<AiAgentConfig>>(
			`/api/ai/agent-config/${instance}`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	// ─── AI Agents CRUD ───────────────────────────────────────────────────────

	async listAgents(token: string): Promise<AiAgent[]> {
		const { data: res } = await this.ax.get<DataResponse<AiAgent[]>>(
			"/api/ai/agents",
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async getAgent(agentId: number, token: string): Promise<AiAgent> {
		const { data: res } = await this.ax.get<DataResponse<AiAgent>>(
			`/api/ai/agents/${agentId}`,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async createAgent(data: CreateAiAgentInput, token: string): Promise<AiAgent> {
		const { data: res } = await this.ax.post<DataResponse<AiAgent>>(
			"/api/ai/agents",
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async updateAgent(agentId: number, data: UpdateAiAgentInput, token: string): Promise<AiAgent> {
		const { data: res } = await this.ax.patch<DataResponse<AiAgent>>(
			`/api/ai/agents/${agentId}`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async deleteAgent(agentId: number, token: string): Promise<void> {
		await this.ax.delete(`/api/ai/agents/${agentId}`, { headers: this.authHeader(token) });
	}

	async upsertAgentAudience(agentId: number, data: AiAgentAudienceInput, token: string): Promise<AiAgent> {
		const { data: res } = await this.ax.put<DataResponse<AiAgent>>(
			`/api/ai/agents/${agentId}/audience`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async previewAgentAudience(
		agentId: number,
		filters: { page?: number; perPage?: number } | undefined,
		token: string,
	): Promise<AiAgentAudiencePreview> {
		const { data: res } = await this.ax.post<FlexiblePaginatedResponse<WppContactWithCustomer>>(
			`/api/ai/agents/${agentId}/audience/preview`,
			undefined,
			{
				params: filters,
				headers: this.authHeader(token),
			},
		);

		return { data: res.data, page: res.page };
	}

	async addAgentKnowledgeEntry(
		agentId: number,
		data: AiAgentKnowledgeEntryInput,
		token: string,
	): Promise<AiAgent> {
		const { data: res } = await this.ax.post<DataResponse<AiAgent>>(
			`/api/ai/agents/${agentId}/knowledge`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async updateAgentKnowledgeEntry(
		agentId: number,
		entryId: number,
		data: Partial<AiAgentKnowledgeEntryInput>,
		token: string,
	): Promise<AiAgent> {
		const { data: res } = await this.ax.patch<DataResponse<AiAgent>>(
			`/api/ai/agents/${agentId}/knowledge/${entryId}`,
			data,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async deleteAgentKnowledgeEntry(agentId: number, entryId: number, token: string): Promise<void> {
		await this.ax.delete(`/api/ai/agents/${agentId}/knowledge/${entryId}`, {
			headers: this.authHeader(token),
		});
	}

	async listAgentActionLogs(filters: AiAgentActionLogFilters, token: string): Promise<PaginatedActionLogs> {
		const { data: res } = await this.ax.get<DataResponse<PaginatedActionLogs>>(
			"/api/ai/agents/logs",
			{
				params: filters,
				headers: this.authHeader(token),
			},
		);
		return res.data;
	}

	async listActiveSessions(token: string): Promise<AiAgentChatSession[]> {
		const { data: res } = await this.ax.get<DataResponse<AiAgentChatSession[]>>(
			"/api/ai/agents/sessions/active",
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}

	async getUsageSummary(period: string, token: string): Promise<AiUsageSummary> {
		const { data: res } = await this.ax.get<DataResponse<AiUsageSummary>>(
			`/api/ai/usage?period=${encodeURIComponent(period)}`,
			{ headers: this.authHeader(token) },
		);
		return res.data;
	}
}
