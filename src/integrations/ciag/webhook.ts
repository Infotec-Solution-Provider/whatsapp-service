import { check } from "./policy";
export interface WabaEvent {
	entry: Array<{
		id: string;
		changes: Array<{
			field: string;
			value: {
				metadata: { phone_number_id: string; display_phone_number: string };
				messages?: Array<Record<string, unknown>>;
				statuses?: Array<Record<string, unknown>>;
				contacts?: unknown[];
			};
		}>;
	}>;
}
export function splitWebhook(raw: unknown): Array<{ phoneId: string; accountId: string; payload: WabaEvent }> {
	check(raw !== null && typeof raw === "object", "Webhook inválido.");
	const input = raw as Record<string, unknown>;
	check(
		input["object"] === "whatsapp_business_account" && Array.isArray(input["entry"]) && input["entry"].length > 0,
		"Webhook inválido."
	);
	const result: Array<{ phoneId: string; accountId: string; payload: WabaEvent }> = [];
	for (const entry of (raw as WabaEvent).entry) {
		check(typeof entry.id === "string" && Array.isArray(entry.changes), "Entrada inválida.");
		for (const change of entry.changes) {
			if (change.field !== "messages") continue;
			const value = change.value;
			check(
				value?.metadata?.phone_number_id && typeof value.metadata.display_phone_number === "string",
				"Número destinatário ausente."
			);
			for (const kind of ["messages", "statuses"] as const) {
				const events = value[kind] ?? [];
				check(Array.isArray(events), "Eventos inválidos.");
				for (const event of events) {
					check(event && typeof event["id"] === "string", "Identificador de evento ausente.");
					result.push({
						phoneId: value.metadata.phone_number_id,
						accountId: entry.id,
						payload: {
							entry: [
								{
									id: entry.id,
									changes: [
										{
											field: "messages",
											value: {
												metadata: value.metadata,
												...(value.contacts ? { contacts: value.contacts } : {}),
												[kind]: [event]
											}
										}
									]
								}
							]
						}
					});
					check(result.length <= 1000, "Eventos em excesso.");
				}
			}
		}
	}
	return result;
}
