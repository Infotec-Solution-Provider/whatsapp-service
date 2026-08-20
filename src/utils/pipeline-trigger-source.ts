import { PipelineTriggerSourceType } from "@prisma/client";

export interface PipelineTriggerSource {
	sourceType: PipelineTriggerSourceType;
	sourceKey: string;
}

export function readyMessagePipelineSource(readyMessageId: number): PipelineTriggerSource {
	return { sourceType: "READY_MESSAGE", sourceKey: `ready-message:${readyMessageId}` };
}

export function templatePipelineSource(source: string, name: string, language: string): PipelineTriggerSource {
	return {
		sourceType: "WHATSAPP_TEMPLATE",
		sourceKey: ["template", source.trim().toLowerCase(), name.trim().toLowerCase(), language.trim().toLowerCase()].join(":"),
	};
}
