import FormData from "form-data";
import ApiClient from "./api-client";
import { RequestFilters } from "./types";
import { DataResponse, MessageResponse } from "./types/response.types";
import {
	AppNotification,
	AutomaticResponseRule,
	AutomaticResponseRuleDTO,
	CustomerProfileManualOverrides,
	CustomerProfileSummaryBatchRequest,
	CustomerProfileSummaryFilters,
	CustomerProfileSummaryPayload,
	CreateScheduleDTO,
	ForwardMessagesData,
	PaginatedContactsResponse,
	PaginatedNotificationsResponse,
	SendFileMessageData,
	SendMessageData,
	UnifiedScheduleFilters,
	UnifiedSchedulesResponse,
	WppChatsAndMessages,
	WppChatWithDetailsAndMessages,
	WppContact,
	WppMessage,
	WppSchedule,
	UpdateCustomerProfileManualOverridesInput,
	WppWallet,
} from "./types/whatsapp.types";

type GetChatsResponse = DataResponse<WppChatsAndMessages>;
type GetChatResponse = DataResponse<WppChatWithDetailsAndMessages>;
type GetMessageResponse = DataResponse<WppMessage>;
type MarkChatAsReadResponse = DataResponse<WppMessage[]>;

interface FetchMessagesFilters {
	minDate: string;
	maxDate: string;
	userId?: number | null;
}

export default class WhatsappClient extends ApiClient {
	public async getChatsBySession(
		messages = false,
		contact = false,
		token: string | null = null,
	) {
		const url = `/api/whatsapp/session/chats?messages=${messages}&contact=${contact}`;
		const { data: res } = await this.ax.get<GetChatsResponse>(
			url,
			token
				? { headers: { Authorization: `Bearer ${token}` } }
				: {},
		);
		return res.data;
	}

	public async getChatById(id: number) {
		const { data: res } = await this.ax.get<GetChatResponse>(
			`/api/whatsapp/chats/${id}`,
		);
		return res.data;
	}

	public async getMessageById(id: string) {
		const { data: res } = await this.ax.get<GetMessageResponse>(
			`/api/whatsapp/messages/${id}`,
		);
		return res.data;
	}

	public async getUserWallets(instance: string, userId: number) {
		const { data: res } = await this.ax.get<DataResponse<WppWallet[]>>(
			`/api/wallets?instance=${instance}&userId=${userId}`,
		);
		return res.data;
	}

	public async markContactMessagesAsRead(contactId: number) {
		const url = `/api/whatsapp/messages/mark-as-read`;
		const body = { contactId };
		const { data: res } = await this.ax.patch<MarkChatAsReadResponse>(
			url,
			body,
		);
		return res.data;
	}

	public async sendMessage(
		clientId: string,
		to: string,
		data: SendMessageData | SendFileMessageData,
	) {
		const url = `/api/whatsapp/${clientId}/messages`;
		const formData = new FormData();
		formData.append("to", to);
		formData.append("text", data.text);
		formData.append("contactId", String(data.contactId));
		
		("quotedId" in data) && data.quotedId && formData.append("quotedId", String(data.quotedId));
		("chatId" in data) && data.chatId && formData.append("chatId", String(data.chatId));
		("fileId" in data) && data.fileId && formData.append("fileId", String(data.fileId));
		("sendAsAudio" in data) && data.sendAsAudio && formData.append("sendAsAudio", "true");
		("sendAsDocument" in data) && data.sendAsDocument && formData.append("sendAsDocument", "true");
		("sendAsChatOwner" in data) && data.sendAsChatOwner && formData.append("sendAsChatOwner", String(data.sendAsChatOwner));
		("traceId" in data) && data.traceId && formData.append("traceId", data.traceId);

		const { data: res } = await this.ax.post<DataResponse<WppMessage>>(
			url,
			formData,
			{
				headers: {
					"Content-Type": "multipart/form-data",
					...(("traceId" in data) && data.traceId ? { "x-upload-trace-id": data.traceId } : {}),
				},
				timeout: ("fileId" in data) && data.fileId
					? ApiClient.UPLOAD_TIMEOUT_MS
					: ApiClient.DEFAULT_TIMEOUT_MS,
			},
		);
		return res.data;
	}

	public async editMessage(
		clientId: string,
		messageId: string,
		newText: string,
		isInternal = false,
	) {
		const type = isInternal ? "internal" : "whatsapp";
		const url = `/api/${type}/${clientId}/messages/${messageId}`;
		const body = { newText };
		await this.ax.put(url, body);
	}

	public async finishChatById(
		id: number,
		resultId: number,
		scheduleDate?: Date | null,
	) {
		const url = `/api/whatsapp/chats/${id}/finish`;
		const body = { resultId, scheduleDate };
		await this.ax.post<MessageResponse>(url, body);
	}

	public async startChatByContactId(contactId: number, template?: any) {
		const url = `/api/whatsapp/chats`;
		const body = { contactId, template };
		await this.ax.post<DataResponse<WppChatWithDetailsAndMessages>>(
			url,
			body,
		);
	}

	public async getResults() {
		const url = `/api/whatsapp/results`;
		const { data: res } =
			await this.ax.get<DataResponse<{ id: number; name: string }[]>>(
				url,
			);
		return res.data;
	}

	public async getCustomerContacts(customerId: number) {
		const url = `/api/whatsapp/customer/${customerId}/contacts`;
		const { data: res } =
			await this.ax.get<DataResponse<WppContact[]>>(url);
		return res.data;
	}

	public async getCustomerProfileSummary(customerId: number) {
		const { data: res } = await this.ax.get<DataResponse<CustomerProfileSummaryPayload>>(
			`/api/whatsapp/customers/${customerId}/profile-tags/summary`,
		);
		return res.data;
	}

	public async getCustomerProfileManualOverrides(customerId: number) {
		const { data: res } = await this.ax.get<DataResponse<CustomerProfileManualOverrides | null>>(
			`/api/whatsapp/customers/${customerId}/profile-tags/manual-overrides`,
		);
		return res.data;
	}

	public async updateCustomerProfileManualOverrides(
		customerId: number,
		data: UpdateCustomerProfileManualOverridesInput,
	) {
		const { data: res } = await this.ax.put<DataResponse<CustomerProfileSummaryPayload>>(
			`/api/whatsapp/customers/${customerId}/profile-tags/manual-overrides`,
			data,
		);
		return res.data;
	}

	public async getCustomerProfileSummaries(data: CustomerProfileSummaryBatchRequest) {
		const { data: res } = await this.ax.post<DataResponse<CustomerProfileSummaryPayload[]>>(
			`/api/whatsapp/customers/profile-tags/summary/batch`,
			data,
		);
		return res.data;
	}

	public async findCustomerIdsByProfileFilters(filters: CustomerProfileSummaryFilters) {
		const params = new URLSearchParams();

		if (filters.profileLevel) params.append("profileLevel", filters.profileLevel);
		if (filters.interactionLevel) params.append("interactionLevel", filters.interactionLevel);
		if (filters.purchaseLevel) params.append("purchaseLevel", filters.purchaseLevel);
		if (filters.ageLevel) params.append("ageLevel", filters.ageLevel);
		if (filters.purchaseInterestLevel) params.append("purchaseInterestLevel", filters.purchaseInterestLevel);

		const queryString = params.toString();
		const url = queryString
			? `/api/whatsapp/customers/profile-tags/customer-ids?${queryString}`
			: `/api/whatsapp/customers/profile-tags/customer-ids`;

		const { data: res } = await this.ax.get<DataResponse<number[]>>(url);
		return res.data;
	}

	public async getContactsWithCustomer(filters?: {
		name?: string;
		phone?: string;
		customerId?: number;
		customerErp?: string;
		customerCnpj?: string;
		customerName?: string;
		hasCustomer?: boolean;
		page?: number;
		perPage?: number;
	}) {
		let url = `/api/whatsapp/contacts/customer`;
		if (filters) {
			const params = new URLSearchParams();
			if (filters.name) params.append("name", filters.name);
			if (filters.phone) params.append("phone", filters.phone);
			if (filters.customerId !== undefined)
				params.append("customerId", String(filters.customerId));
			if (filters.customerErp)
				params.append("customerErp", filters.customerErp);
			if (filters.customerCnpj)
				params.append("customerCnpj", filters.customerCnpj);
			if (filters.customerName)
				params.append("customerName", filters.customerName);
			if (filters.hasCustomer !== undefined)
				params.append("hasCustomer", String(filters.hasCustomer));
			if (filters.page !== undefined)
				params.append("page", String(filters.page));
			if (filters.perPage !== undefined)
				params.append("perPage", String(filters.perPage));
			const queryString = params.toString();
			if (queryString) url += `?${queryString}`;
		}
		const res = await this.ax.get<PaginatedContactsResponse>(url);
		return res.data;
	}

	public async getContacts() {
		const url = `/api/whatsapp/contacts`;
		const { data: res } =
			await this.ax.get<DataResponse<WppContact[]>>(url);
		return res.data;
	}

	public async createContact(
		name: string,
		phone: string,
		customerId?: number,
		sectorIds?: number[],
	) {
		const baseUrl = `/api/whatsapp`;
		const url = customerId
			? `${baseUrl}/customers/${customerId}/contacts`
			: `${baseUrl}/contacts`;
		const body: Record<string, any> = { name, phone };
		if (sectorIds !== undefined) body["sectorIds"] = sectorIds;
		const { data: res } = await this.ax.post<DataResponse<WppContact>>(
			url,
			body,
		);
		return res.data;
	}

	public async forwardMessages(clientId: string, data: ForwardMessagesData) {
		const url = `/api/whatsapp/${clientId}/messages/forward`;
		const body = data;
		await this.ax.post<MessageResponse>(url, body);
	}

	public async updateContact(
		contactId: number,
		name?: string,
		customerId?: number | null,
		sectorIds?: number[] | null,
	) {
		const url = `/api/whatsapp/contacts/${contactId}`;
		const body: Record<string, any> = {};
		if (name !== undefined) body["name"] = name;
		if (customerId !== undefined) body["customerId"] = customerId;
		if (sectorIds !== undefined) body["sectorIds"] = sectorIds;
		const { data: res } = await this.ax.put<DataResponse<WppContact>>(
			url,
			body,
		);
		return res.data;
	}

	public async addSectorToContact(contactId: number, sectorId: number) {
		const url = `/api/whatsapp/contacts/${contactId}/sectors`;
		const body = { sectorId };
		const { data: res } = await this.ax.post<DataResponse<WppContact>>(
			url,
			body,
		);
		return res.data;
	}

	public async deleteContact(contactId: number) {
		const url = `/api/whatsapp/contacts/${contactId}`;
		await this.ax.delete<MessageResponse>(url);
	}

	public async getSectors() {
		const url = `/api/whatsapp/sectors`;
		const { data: res } =
			await this.ax.get<DataResponse<{ id: number; name: string }[]>>(
				url,
			);
		return res.data;
	}

	public setAuth(token: string) {
		this.ax.defaults.headers.common["Authorization"] = `Bearer ${token}`;
	}

	public async getChatsMonitor() {
		const url = `/api/whatsapp/session/monitor`;
		const { data: res } = await this.ax.get<GetChatsResponse>(url);
		return res.data;
	}

	public async transferAttendance(id: number, userId: number) {
		const url = `/api/whatsapp/chats/${id}/transfer`;
		const body = { userId };
		await this.ax.post<MessageResponse>(url, body);
	}
	/**
	 * Busca as notificações do usuário de forma paginada.
	 */
	public async getNotifications(params: { page: number; pageSize: number }) {
		const searchParams = new URLSearchParams({
			page: String(params.page),
			pageSize: String(params.pageSize),
		});
		const url = `/api/whatsapp/notifications?${searchParams.toString()}`;
		const { data: res } =
			await this.ax.get<DataResponse<PaginatedNotificationsResponse>>(
				url,
			);
		return res;
	}

	/**
	 * Marca todas as notificações do usuário como lidas.
	 */
	public async markAllAsReadNotification() {
		const url = `/api/whatsapp/notifications/mark-all-read`;
		const { data: res } = await this.ax.patch<MessageResponse>(url);
		return res;
	}

	/**
	 * Marca uma notificação específica como lida.
	 * @param notificationId - O ID (numérico) da notificação a ser marcada.
	 */
	public async markOneAsReadNotification(notificationId: number) {
		const url = `/api/whatsapp/notifications/${notificationId}/read`;
		const { data: res } =
			await this.ax.patch<DataResponse<AppNotification>>(url);
		return res;
	}

	/**
	 * Obtém os detalhes de um agendamento.
	 * @param filters - keys de WppSchedule.
	 * @param userId/sectorId filtrar por usúario/setor
	 * @returns Uma Promise que resolve para um array de objetos wppSchedule.
	 */
	public async getSchedules(
		userId?: string,
		sectorId?: string,
		filters?: RequestFilters<WppSchedule>,
	) {
		let baseUrl = `/api/whatsapp/schedules`;
		const params = new URLSearchParams(filters);
		if (params.toString()) {
			if (userId && sectorId) {
				baseUrl += `?userId=${userId}&sectorId=${sectorId}&${params.toString()}`;
			} else if (userId) {
				baseUrl += `?userId=${userId}&${params.toString()}`;
			} else if (sectorId) {
				baseUrl += `?sectorId=${sectorId}&${params.toString()}`;
			} else {
				baseUrl += `?${params.toString()}`;
			}
		} else if (userId || sectorId) {
			if (userId && sectorId) {
				baseUrl += `?userId=${userId}&sectorId=${sectorId}`;
			} else if (userId) {
				baseUrl += `?userId=${userId}`;
			} else if (sectorId) {
				baseUrl += `?sectorId=${sectorId}`;
			}
		}
		const response = await this.ax.get(baseUrl);
		return response.data;
	}

	public async getUnifiedSchedules(filters?: UnifiedScheduleFilters) {
		let baseUrl = `/api/whatsapp/schedules/unified`;
		const params = new URLSearchParams(
			Object.entries(filters ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
				if (value !== undefined && value !== null) {
					acc[key] = String(value);
				}

				return acc;
			}, {}),
		);

		if (params.toString()) {
			baseUrl += `?${params.toString()}`;
		}

		const response = await this.ax.get<UnifiedSchedulesResponse>(baseUrl);
		return response.data;
	}

	/**
	 * Cria um novo agendamento.
	 * @param scheduleData - Os dados do agendamento, keys de wppSchedule.
	 * @returns Uma Promise que resolve para um objeto wppSchedule.
	 */
	public async createSchedule(data: CreateScheduleDTO) {
		const response = await this.ax.post(`/api/whatsapp/schedules`, data);
		return response.data;
	}

	/**
	 * Edita um agendamento existente.
	 * @param scheduleId - O ID do agendamento a ser editado.
	 * @param updatedData - Os dados atualizados do agendamento.
	 * @returns Uma Promise que resolve para um objeto wppSchedule.
	 */
	public async updateSchedule(
		scheduleId: number,
		updatedData: Record<string, WppSchedule>,
	) {
		const response = await this.ax.patch(
			`/api/whatsapp/schedules/${scheduleId}`,
			updatedData,
		);
		return response.data;
	}

	/**
	 * Exclui um agendamento.
	 * @param scheduleId - O ID do agendamento a ser excluído.
	 * @returns Uma Promise que resolve para um objeto wppSchedule.
	 */
	public async deleteSchedule(scheduleId: number) {
		const response = await this.ax.delete(
			`/api/whatsapp/schedules/${scheduleId}`,
		);
		return response.data;
	}

	public async getMessages(token: string, filters: FetchMessagesFilters) {
		const params = new URLSearchParams(
			Object.entries(filters)
				.filter(([_, v]) => v !== undefined && v !== null)
				.reduce<Record<string, string>>((acc, [k, v]) => {
					acc[k] = String(v);
					return acc;
				}, {}),
		);
		const url = `/api/whatsapp/messages?${params.toString()}`;
		const { data: res } = await this.ax.get<
			DataResponse<(WppMessage & { WppContact: WppContact | null })[]>
		>(url, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});
		return res.data;
	}
	public async getAutoResponseRules() {
		const url = `/api/auto-response-rules`;
		const { data: res } =
			await this.ax.get<DataResponse<AutomaticResponseRule[]>>(url);
		return res.data;
	}

	public async createAutoResponseRule(ruleData: AutomaticResponseRuleDTO) {
		const url = `/api/auto-response-rules`;
		const { data: res } = await this.ax.post<
			DataResponse<AutomaticResponseRule>
		>(url, ruleData);
		return res.data;
	}

	public async updateAutoResponseRule(
		id: number,
		ruleData: Omit<AutomaticResponseRuleDTO, "instance">,
	) {
		const url = `/api/auto-response-rules/${id}`;
		const { data: res } = await this.ax.put<
			DataResponse<AutomaticResponseRule>
		>(url, ruleData);
		return res.data;
	}

	public async deleteAutoResponseRule(id: number) {
		const url = `/api/auto-response-rules/${id}`;
		await this.ax.delete<MessageResponse>(url);
	}
}
