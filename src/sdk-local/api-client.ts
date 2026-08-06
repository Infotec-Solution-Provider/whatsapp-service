import axios, { AxiosInstance, AxiosError } from "axios";
import { ErrorResponse } from "./types/response.types";

function stringifyPreview(value: unknown, maxLength = 400): string | undefined {
	if (value == null) {
		return undefined;
	}

	if (typeof value === "string") {
		return value.slice(0, maxLength);
	}

	try {
		return JSON.stringify(value).slice(0, maxLength);
	} catch (_err) {
		return "[unserializable]";
	}
}

function buildAxiosErrorMessage(error: AxiosError<ErrorResponse>): string {
	const status = error.response?.status;
	const method = error.config?.method?.toUpperCase();
	const url = error.config?.url;
	const data = error.response?.data as any;

	const parts = [
		data?.message,
		data?.details,
		error.message,
		status ? `status=${status}` : undefined,
		method && url ? `${method} ${url}` : undefined,
	];

	const bodyPreview = stringifyPreview(data);
	if (bodyPreview) {
		parts.push(`body=${bodyPreview}`);
	}

	return parts.filter(Boolean).join(" | ");
}

export default class ApiClient {
	public static readonly DEFAULT_TIMEOUT_MS = 60_000;
	public static readonly UPLOAD_TIMEOUT_MS = 300_000;

	public readonly ax: AxiosInstance;
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;

		this.ax = axios.create({
			baseURL: `${this.baseUrl}`,
			timeout: ApiClient.DEFAULT_TIMEOUT_MS,
			headers: {
				"Content-Type": "application/json",
			},
		});

		this.initializeResponseInterceptor();
	}

	private initializeResponseInterceptor() {
		this.ax.interceptors.response.use(null, this.handleError);
	}

	protected handleError = (
		error: AxiosError<ErrorResponse>,
	): Promise<never> => {
		const errorMessage = buildAxiosErrorMessage(error) || error.message;
		return Promise.reject(new Error(errorMessage, { cause: error }));
	};
}
