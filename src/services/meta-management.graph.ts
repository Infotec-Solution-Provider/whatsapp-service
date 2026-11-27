import { Decimal } from "@prisma/client/runtime/library";

const GRAPH_BASE = "https://graph.facebook.com/v26.0/";
const TEMPLATE_FIELDS = "id,name,language,category,status,components,rejected_reason";
const PROFILE_FIELDS = "about,description,email,address,websites,vertical,profile_picture_url";

export interface MetaTemplateInput {
	name: string;
	language: string;
	category: "UTILITY" | "MARKETING";
	body: string;
	examples: string[];
}

export interface MetaTemplateFilters {
	after?: string;
	language?: string;
	status?: string;
}

export interface MetaTemplate {
	id: string;
	name: string;
	language: string;
	category: string;
	status: string;
	body: string;
	rejectionReason: string | null;
}

export interface MetaNumber {
	id: string;
	phone: string | null;
	verifiedName: string | null;
	status: string | null;
	qualityRating: string | null;
}

export interface MetaProfile {
	about: string | null;
	description: string | null;
	email: string | null;
	address: string | null;
	websites: string[];
	vertical: string | null;
	photoUrl: string | null;
}

export type MetaProfilePatch = Partial<{
	about: string;
	description: string;
	email: string;
	address: string;
	websites: string[];
	vertical: string;
}>;

export interface MetaPhoto {
	bytes: Buffer;
	contentType: "image/png" | "image/jpeg";
}

export interface MetaPricingBucket {
	category: string;
	pricingType: string;
	volume: number;
	cost: number | null;
}

export interface MetaPricingReport {
	currency: string | null;
	totalCost: number | null;
	totalVolume: number;
	buckets: MetaPricingBucket[];
}

export class MetaGraphError extends Error {
	constructor(public status: number, public code: string, message: string, public traceId?: string) {
		super(message);
		this.name = "MetaGraphError";
	}
}

type Json = Record<string, unknown>;

function json(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function invalidResponse(): MetaGraphError {
	return new MetaGraphError(502, "META_INVALID_RESPONSE", "A Meta retornou dados inesperados.");
}

function uncertainWrite(): MetaGraphError {
	return new MetaGraphError(502, "META_WRITE_UNCERTAIN", "A Meta não confirmou a alteração. Atualize os dados antes de tentar novamente.");
}

function getPage(response: Json) {
	if (!Array.isArray(response["data"])) throw invalidResponse();
	const paging = json(response["paging"]);
	return {
		data: response["data"].map(json),
		nextCursor: paging["next"] ? nullableString(json(paging["cursors"])["after"]) : null
	};
}

function mapTemplate(value: Json): MetaTemplate {
	const id = nullableString(value["id"]);
	const name = nullableString(value["name"]);
	const language = nullableString(value["language"]);
	const category = nullableString(value["category"]);
	const status = nullableString(value["status"]);
	if (!id || !name || !language || !category || !status) throw invalidResponse();
	const components = Array.isArray(value["components"]) ? value["components"].map(json) : [];
	const body = components.find((component) => component["type"] === "BODY");
	return {
		id, name, language, category, status,
		body: nullableString(body?.["text"]) ?? "",
		rejectionReason: nullableString(value["rejected_reason"])
	};
}

function pricingPhone(value: unknown): string | null {
	const normalized = nullableString(value)?.replace(/[\s()-]/g, "");
	return normalized && /^\+?[1-9]\d{5,14}$/.test(normalized) ? normalized.replace(/^\+/, "") : null;
}

function pricingDimension(value: unknown): string {
	const name = nullableString(value);
	if (!name || !/^[A-Z][A-Z0-9_]{0,47}$/.test(name)) throw invalidResponse();
	return name;
}

function pricingPoint(value: Json, phone: string) {
	if (pricingPhone(value["phone_number"]) !== phone) throw invalidResponse();
	const volume = value["volume"];
	if (typeof volume !== "number" || !Number.isSafeInteger(volume) || volume < 0) throw invalidResponse();
	const cost = value["cost"];
	if (cost != null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw invalidResponse();
	return {
		category: pricingDimension(value["pricing_category"]),
		pricingType: pricingDimension(value["pricing_type"]),
		volume,
		cost: cost == null ? null : new Decimal(cost)
	};
}

type PricingAccumulator = ReturnType<typeof pricingPoint>;

function addPricingPoint(buckets: Map<string, PricingAccumulator>, point: PricingAccumulator) {
	const key = `${point.category}:${point.pricingType}`;
	const previous = buckets.get(key);
	if (!previous) {
		buckets.set(key, point);
		return;
	}
	previous.volume += point.volume;
	previous.cost = previous.cost !== null && point.cost !== null ? previous.cost.add(point.cost) : null;
}

export class MetaManagementGraph {
	readonly #token: string;

	constructor(token: string, private readonly transport: typeof fetch = fetch) {
		this.#token = token;
	}

	private async request(path: string, query: Record<string, string> = {}, options: RequestInit = {}) {
		const url = new URL(GRAPH_BASE + path);
		for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
		const isWrite = options.method === "POST";
		let response: Response;
		try {
			response = await this.transport(url, {
				...options,
				headers: { Authorization: `Bearer ${this.#token}`, ...options.headers },
				redirect: "error",
				signal: AbortSignal.timeout(10_000)
			});
		} catch {
			if (isWrite) throw uncertainWrite();
			throw new MetaGraphError(502, "META_UNREACHABLE", "Não foi possível consultar a Meta. Tente novamente.");
		}
		let value: Json;
		try {
			value = json(await response.json());
		} catch {
			if (isWrite && (response.ok || response.status >= 500)) throw uncertainWrite();
			throw invalidResponse();
		}
		if (response.ok && !value["error"]) return value;
		const error = json(value["error"]);
		const trace = nullableString(error["fbtrace_id"]);
		const traceId = trace && /^[a-zA-Z0-9_-]{1,100}$/.test(trace) ? trace : undefined;
		const code = error["code"];
		if (code === 190 || code === 10 || code === 200 || response.status === 401 || response.status === 403) {
			throw new MetaGraphError(502, "META_PERMISSION_DENIED", "A Meta recusou o token do canal ou a permissão para esta operação.", traceId);
		}
		if (error["error_subcode"] === 2388024) {
			throw new MetaGraphError(409, "META_TEMPLATE_EXISTS", "Já existe um template com esse nome e idioma nesta conta.", traceId);
		}
		if (response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80008) {
			throw new MetaGraphError(429, "META_RATE_LIMIT", "A Meta limitou as consultas. Aguarde e tente novamente.", traceId);
		}
		if (isWrite && (response.status >= 500 || error["is_transient"] === true)) throw uncertainWrite();
		if (isWrite && response.status >= 400 && response.status < 500) {
			throw new MetaGraphError(422, "META_VALIDATION", "A Meta recusou os dados da alteração. Confira os campos e tente novamente.", traceId);
		}
		throw new MetaGraphError(502, "META_REQUEST_FAILED", "A consulta à Meta falhou.", traceId);
	}

	private post(path: string, value: Json) {
		return this.request(path, {}, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value)
		});
	}

	private async templatePage(accountId: string, filters: Record<string, string>) {
		const page = getPage(await this.request(`${accountId}/message_templates`, { fields: TEMPLATE_FIELDS, limit: "50", ...filters }));
		return { templates: page.data.map(mapTemplate), nextCursor: page.nextCursor };
	}

	listTemplates(accountId: string, filters: MetaTemplateFilters) {
		const query: Record<string, string> = {};
		if (filters.after) query["after"] = filters.after;
		if (filters.language) query["language"] = filters.language;
		if (filters.status) query["status"] = filters.status;
		return this.templatePage(accountId, query);
	}

	async createTemplate(accountId: string, input: MetaTemplateInput): Promise<MetaTemplate> {
		try {
			const result = await this.post(`${accountId}/message_templates`, {
				name: input.name,
				language: input.language,
				category: input.category,
				parameter_format: "POSITIONAL",
				components: [{
					type: "BODY",
					text: input.body,
					...(input.examples.length ? { example: { body_text: [input.examples] } } : {})
				}]
			});
			const id = nullableString(result["id"]);
			const status = nullableString(result["status"]);
			if (!id || !status) throw uncertainWrite();
			return {
				id, status, name: input.name, language: input.language, body: input.body,
				category: nullableString(result["category"]) ?? input.category,
				rejectionReason: nullableString(result["rejected_reason"])
			};
		} catch (error) {
			if (!(error instanceof MetaGraphError) || error.code !== "META_WRITE_UNCERTAIN") throw error;
			let existing: MetaTemplate | undefined;
			try {
				const page = await this.templatePage(accountId, { name: input.name, language: input.language });
				existing = page.templates.find((template) => template.name === input.name && template.language === input.language);
			} catch {
				throw error;
			}
			if (existing?.body === input.body && existing.category === input.category) return existing;
			if (existing) throw new MetaGraphError(409, "META_TEMPLATE_EXISTS", "Já existe um template com esse nome e idioma nesta conta.");
			throw error;
		}
	}

	async listNumbers(accountId: string): Promise<MetaNumber[]> {
		const numbers: MetaNumber[] = [];
		const seen = new Set<string>();
		let after: string | null = null;
		do {
			const query: Record<string, string> = { fields: "id,display_phone_number,verified_name,status,quality_rating", limit: "100" };
			if (after) query["after"] = after;
			const page = getPage(await this.request(`${accountId}/phone_numbers`, query));
			for (const item of page.data) {
				const id = nullableString(item["id"]);
				if (!id) throw invalidResponse();
				numbers.push({
					id, phone: nullableString(item["display_phone_number"]), verifiedName: nullableString(item["verified_name"]),
					status: nullableString(item["status"]), qualityRating: nullableString(item["quality_rating"])
				});
			}
			after = page.nextCursor;
			if (after && (seen.has(after) || seen.size >= 100)) throw invalidResponse();
			if (after) seen.add(after);
		} while (after);
		return numbers;
	}

	async getPricingAnalytics(accountId: string, phone: string, from: Date, to: Date): Promise<MetaPricingReport> {
		const number = pricingPhone(phone);
		if (!number) throw new MetaGraphError(422, "META_PRICING_PHONE_UNAVAILABLE", "Número do canal indisponível para consultar os custos na Meta.");
		const start = Math.floor(from.getTime() / 1000);
		const end = Math.floor(to.getTime() / 1000);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
			throw new MetaGraphError(422, "META_PRICING_RANGE_INVALID", "Período inválido para consultar os custos na Meta.");
		}

		const [account, buckets] = await Promise.all([
			this.request(accountId, { fields: "currency" }),
			this.pricingBuckets(accountId, number, start, end)
		]);
		const accountCurrency = nullableString(account["currency"]);
		const currency = accountCurrency && /^[A-Z]{3}$/.test(accountCurrency) ? accountCurrency : null;
		const totalCost = buckets.reduce<Decimal | null>((total, bucket) =>
			total !== null && bucket.cost !== null ? total.add(bucket.cost) : null, new Decimal(0));
		return {
			currency,
			totalCost: currency ? totalCost?.toNumber() ?? null : null,
			totalVolume: buckets.reduce((total, bucket) => total + bucket.volume, 0),
			buckets: buckets.map((bucket) => ({
				...bucket,
				cost: currency ? bucket.cost?.toNumber() ?? null : null
			}))
		};
	}

	private async pricingBuckets(accountId: string, phone: string, start: number, end: number): Promise<PricingAccumulator[]> {
		const query = {
			start: String(start), end: String(end), granularity: "DAILY",
			phone_numbers: JSON.stringify([phone]),
			metric_types: JSON.stringify(["COST", "VOLUME"]),
			dimensions: JSON.stringify(["PHONE", "PRICING_CATEGORY", "PRICING_TYPE"])
		};
		const buckets = new Map<string, PricingAccumulator>();
		const seen = new Set<string>();
		let after: string | null = null;
		do {
			const response = await this.request(`${accountId}/pricing_analytics`, after ? { ...query, after } : query);
			const page = getPage(response);
			for (const item of page.data) {
				const points = item["data_points"];
				if (!Array.isArray(points)) throw invalidResponse();
				for (const point of points) addPricingPoint(buckets, pricingPoint(json(point), phone));
			}
			after = page.nextCursor;
			if (json(response["paging"])["next"] && (!after || seen.has(after) || seen.size >= 20)) throw invalidResponse();
			if (after) seen.add(after);
		} while (after);
		return Array.from(buckets.values());
	}

	async getProfile(phoneId: string): Promise<MetaProfile> {
		const { data } = getPage(await this.request(`${phoneId}/whatsapp_business_profile`, { fields: PROFILE_FIELDS }));
		const profile = data[0];
		if (!profile) throw invalidResponse();
		const photoUrl = nullableString(profile["profile_picture_url"]);
		return {
			about: nullableString(profile["about"]), description: nullableString(profile["description"]),
			email: nullableString(profile["email"]), address: nullableString(profile["address"]),
			websites: stringArray(profile["websites"]), vertical: nullableString(profile["vertical"]),
			photoUrl: photoUrl?.startsWith("https://") ? photoUrl : null
		};
	}

	private async saveProfile(phoneId: string, fields: Json): Promise<MetaProfile> {
		const response = await this.post(`${phoneId}/whatsapp_business_profile`, { messaging_product: "whatsapp", ...fields });
		const confirmed = response["success"] === true || (Array.isArray(response["data"]) && json(response["data"][0])["success"] === true);
		if (!confirmed) throw uncertainWrite();
		try {
			return await this.getProfile(phoneId);
		} catch {
			throw new MetaGraphError(502, "META_REFRESH_REQUIRED", "A Meta aceitou a alteração. Atualize a tela para consultar o perfil.");
		}
	}

	updateProfile(phoneId: string, profile: MetaProfilePatch): Promise<MetaProfile> {
		return this.saveProfile(phoneId, profile);
	}

	async updatePhoto(phoneId: string, photo: MetaPhoto): Promise<MetaProfile> {
		const extension = photo.contentType === "image/png" ? "png" : "jpg";
		const session = await this.request("app/uploads/", {
			file_name: `profile.${extension}`, file_length: String(photo.bytes.length), file_type: photo.contentType
		}, { method: "POST", headers: { Authorization: `OAuth ${this.#token}` } });
		const id = nullableString(session["id"]);
		if (!id || !/^upload:[A-Za-z0-9_=+%.-]+(?:\?sig=[A-Za-z0-9_+=%.-]+)?$/.test(id)) throw invalidResponse();
		const upload = await this.request(id, {}, {
			method: "POST",
			headers: { Authorization: `OAuth ${this.#token}`, file_offset: "0", "Content-Type": photo.contentType },
			body: Uint8Array.from(photo.bytes)
		});
		const handle = nullableString(upload["h"]);
		if (!handle) throw invalidResponse();
		return this.saveProfile(phoneId, { profile_picture_handle: handle });
	}
}
