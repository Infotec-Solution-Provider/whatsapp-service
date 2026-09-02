export type EditMessageIdStrategy = "WWEBJS" | "STANZA_FIRST";

export interface EditMessageIds {
	wwebjsId?: string | null;
	wwebjsIdStanza?: string | null;
}

export function resolveEditMessageId(strategy: EditMessageIdStrategy, ids: EditMessageIds): string | null {
	if (strategy === "WWEBJS") return ids.wwebjsId || null;
	return ids.wwebjsIdStanza || ids.wwebjsId || null;
}
