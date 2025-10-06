import { WABAMessageTemplate } from "../types/whatsapp-api.types";
import { GSMessageTemplate } from "../types/gupshup-api.types";

type TemplateSource = "waba" | "gupshup";

export interface TemplateMessage {
	id: string;
	name: string;
	language: string;
	category: string;
	status: string;
	text: string;
	source: TemplateSource;
	raw: any;
}

export interface WABATemplateMessage extends TemplateMessage {
	source: "waba";
	raw: WABAMessageTemplate;
}

export interface GupshupTemplateMessage extends TemplateMessage {
	source: "gupshup";
	raw: GSMessageTemplate;
}

class TemplateAdapter {
	public static fromWABATemplate(raw: WABAMessageTemplate): WABATemplateMessage {
		return {
			id: raw.name,
			name: raw.name,
			language: raw.language.code,
			category: raw.category,
			status: raw.status,
			text: raw.components?.find((c) => c.type === "BODY")?.text || "",
			source: "waba",
			raw
		};
	}

	public static fromGupshupTemplate(raw: GSMessageTemplate): GupshupTemplateMessage {
		return {
			id: raw.id,
			name: raw.elementName,
			language: raw.languageCode,
			category: raw.category,
			status: raw.status,
			text: raw.data,
			source: "gupshup" as const,
			raw
		};
	}
}

export default TemplateAdapter;
