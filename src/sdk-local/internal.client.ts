import ApiClient from "./api-client";
import { DataResponse } from "./types/response.types";
import {
	InternalChat,
	InternalChatMember,
	InternalGroup,
	InternalMessage,
	InternalSendMessageData,
} from "./types/internal.types";
import FormData from "form-data";

type GetChatsResponse = DataResponse<{
	chats: (InternalChat & { participants: InternalChatMember[] })[];
	messages: InternalMessage[];
}>;
export default class InternalChatClient extends ApiClient {
	public async createInternalChat(
		participants: number[],
		isGroup: boolean = false,
		groupName: string | null = null,
		groupId: string | null = null,
		groupImage: File | null = null,
	) {
		const form = new FormData();

		if (groupImage) {
			form.append("file", groupImage);
		}

		form.append(
			"data",
			JSON.stringify({ participants, isGroup, groupName, groupId }),
		);

		const { data: res } = await this.ax.post<
			DataResponse<InternalChat>
		>(`/api/internal/chats`, form, {
			headers: {
				"Content-Type": "multipart/form-data",
			},
			timeout: groupImage
				? ApiClient.UPLOAD_TIMEOUT_MS
				: ApiClient.DEFAULT_TIMEOUT_MS,
		});

		return res.data;
	}

	public async deleteInternalChat(chatId: number) {
		const url = `/api/internal/chats/${chatId}`;
		await this.ax.delete<DataResponse<InternalChat>>(url);
	}

	public async getInternalChatsBySession(token: string | null = null) {
		const url = `/api/internal/session/chats`;

		const { data: res } = await this.ax.get<GetChatsResponse>(
			url,
			token
				? { headers: { Authorization: `Bearer ${token}` } }
				: {},
		);

		return res.data;
	}

	public async getInternalGroups() {
		const url = `/api/internal/groups`;
		const { data: res } =
			await this.ax.get<DataResponse<InternalGroup[]>>(url);

		return res.data;
	}

	public async sendMessageToInternalChat(data: InternalSendMessageData) {
		const url = `/api/internal/chats/${data.chatId}/messages`;
		const formData = new FormData();

		formData.append("chatId", data.chatId.toString());
		formData.append("text", data.text);
		data.quotedId && formData.append("quotedId", data.quotedId.toString());
		data.sendAsAudio && formData.append("sendAsAudio", "true");
		data.sendAsDocument && formData.append("sendAsDocument", "true");
		data.file && formData.append("file", data.file);
		data.fileId && formData.append("fileId", data.fileId.toString());
		data.traceId && formData.append("traceId", data.traceId);
		if (data.mentions && data.mentions.length > 0) {
  		formData.append("mentions", JSON.stringify(data.mentions));
		}
		await this.ax.post<DataResponse<InternalMessage>>(
			url,
			formData,
			{
				headers: {
					"Content-Type": "multipart/form-data",
					...(data.traceId ? { "x-upload-trace-id": data.traceId } : {}),
				},
				timeout: data.file
					? ApiClient.UPLOAD_TIMEOUT_MS
					: ApiClient.DEFAULT_TIMEOUT_MS,
			},
		);
	}

	public async updateInternalGroup(
		groupId: number,
		data: {
			name: string;
			participants: number[];
			wppGroupId: string | null;
		},
	) {
		const { data: res } = await this.ax.put<
			DataResponse<InternalGroup>
		>(`/api/internal/groups/${groupId}`, data);
		return res.data;
	}

	public async updateInternalGroupImage(groupId: number, file: File) {
		const formData = new FormData();
		formData.append("file", file);

		const { data: res } = await this.ax.put<
			DataResponse<InternalGroup>
		>(`/api/internal/groups/${groupId}/image`, formData, {
			headers: {
				"Content-Type": "multipart/form-data",
			},
			timeout: ApiClient.UPLOAD_TIMEOUT_MS,
		});
		return res.data;
	}

	public async markChatMessagesAsRead(chatId: number) {
		const url = `/api/internal/chat/${chatId}/mark-as-read`;
		await this.ax.patch(url);
	}
	
	public async getInternalChatsMonitor() {
		const url = `/api/internal/monitor/chats`;
		const { data: res } = await this.ax.get<GetChatsResponse>(url);

		return res.data;
	}
	
	public setAuth(token: string) {
		this.ax.defaults.headers.common["Authorization"] =
			`Bearer ${token}`;
	}
}
