import { MetaGraphError, MetaPhoto, MetaProfilePatch, MetaTemplateFilters, MetaTemplateInput } from "./meta-management.graph";

export const META_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
const VERTICALS = new Set([
	"OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT",
	"HOTEL", "HEALTH", "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT"
]);
const PROFILE_TEXT_LIMITS = { about: 139, description: 256, email: 128, address: 256 } as const;

function invalid(message: string): never {
	throw new MetaGraphError(400, "META_INVALID_INPUT", message);
}

function object(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Informe os campos solicitados.");
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, limit: number, message: string) {
	if (typeof value !== "string" || !value.trim() || [...value.trim()].length > limit) invalid(message);
	return value.trim();
}

export function parseMetaTemplateInput(value: unknown): MetaTemplateInput {
	const input = object(value);
	const name = requiredText(input["name"], 512, "Informe um nome válido para o template.");
	if (!/^[a-z0-9_]+$/.test(name)) invalid("Use letras minúsculas, números e sublinhados no nome do template.");
	const language = input["language"];
	if (typeof language !== "string" || !LANGUAGE.test(language)) invalid("Selecione um idioma válido.");
	const category = input["category"];
	if (category !== "UTILITY" && category !== "MARKETING") invalid("Selecione uma categoria válida.");
	const body = requiredText(input["body"], 1024, "Informe o texto do template com até 1.024 caracteres.");
	const placeholders = [...body.matchAll(/\{\{([1-9]\d*)\}\}/g)];
	const withoutPlaceholders = body.replace(/\{\{[1-9]\d*\}\}/g, "");
	const positions = new Set(placeholders.map(([, number]) => Number(number)));
	if (/[{}]{2}/.test(withoutPlaceholders) || [...positions].some((position) => position > positions.size)) {
		invalid("Use variáveis posicionais em sequência, como {{1}} e {{2}}.");
	}
	const examples = input["examples"];
	if (!Array.isArray(examples) || examples.length !== positions.size) invalid("Preencha um exemplo para cada variável do template.");
	return {
		name, language, category, body,
		examples: examples.map((example) => requiredText(example, 1024, "Preencha um exemplo válido para cada variável."))
	};
}

export function parseMetaTemplateFilters(input: Record<string, unknown>): MetaTemplateFilters {
	const { after, language, status } = input;
	if (after !== undefined && (typeof after !== "string" || !after || after.length > 2048 || /\s/.test(after))) invalid("Cursor de paginação inválido.");
	if (language !== undefined && (typeof language !== "string" || !LANGUAGE.test(language))) invalid("Selecione um idioma válido.");
	if (status !== undefined && (typeof status !== "string" || !/^[A-Z_]{1,32}$/.test(status))) invalid("Selecione um status válido.");
	return {
		...(after === undefined ? {} : { after }),
		...(language === undefined ? {} : { language }),
		...(status === undefined ? {} : { status })
	};
}

function validWebsite(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 256 || !/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
	} catch {
		return false;
	}
}

export function parseMetaProfilePatch(value: unknown): MetaProfilePatch {
	const input = object(value);
	const allowed = new Set([...Object.keys(PROFILE_TEXT_LIMITS), "websites", "vertical"]);
	if (Object.keys(input).length === 0 || Object.keys(input).some((field) => !allowed.has(field))) {
		invalid("Informe somente os campos editáveis do perfil comercial.");
	}
	const profile: MetaProfilePatch = {};
	for (const field of Object.keys(PROFILE_TEXT_LIMITS) as Array<keyof typeof PROFILE_TEXT_LIMITS>) {
		const fieldValue = input[field];
		if (fieldValue === undefined) continue;
		const text = fieldValue === null ? "" : fieldValue;
		if (typeof text !== "string" || [...text.trim()].length > PROFILE_TEXT_LIMITS[field]) invalid("Um dos campos do perfil excede o limite permitido.");
		profile[field] = text.trim();
	}
	if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) invalid("Informe um e-mail válido.");
	if ("websites" in input) {
		const sites = input["websites"];
		if (!Array.isArray(sites) || sites.length > 2 || !sites.every(validWebsite)) invalid("Informe até dois sites com endereço HTTP ou HTTPS válido.");
		profile.websites = sites;
	}
	if ("vertical" in input) {
		const vertical = input["vertical"];
		if (typeof vertical !== "string" || !VERTICALS.has(vertical)) invalid("Selecione uma categoria comercial válida.");
		profile.vertical = vertical;
	}
	return profile;
}

export function parseMetaPhoto(file: { buffer: Buffer; mimetype: string } | undefined): MetaPhoto {
	if (!file || file.buffer.length === 0 || file.buffer.length > META_PHOTO_MAX_BYTES) invalid("Envie uma imagem JPEG ou PNG de até 5 MB.");
	if (file.mimetype === "image/png" && file.buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		return { bytes: file.buffer, contentType: "image/png" };
	}
	if (file.mimetype === "image/jpeg" && file.buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
		return { bytes: file.buffer, contentType: "image/jpeg" };
	}
	return invalid("Envie um arquivo de imagem JPEG ou PNG válido.");
}
