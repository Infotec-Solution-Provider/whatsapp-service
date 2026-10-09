import { BadRequestError } from "@rgranatodutra/http-errors";
import { whatsappParameterSettings } from "./parameter-settings.catalog";

export interface ParameterChange {
	key: string;
	value: string | null;
	previousValue: string | null;
}

export function parseParameterChanges(body: unknown): ParameterChange[] {
	const changes = (body as { changes?: unknown } | null)?.changes;
	if (!Array.isArray(changes) || changes.length === 0 || changes.length > whatsappParameterSettings.length) {
		throw new BadRequestError("Informe as configurações alteradas.");
	}
	const seen = new Set<string>();
	return changes.map((change: unknown) => {
		const item = change as ParameterChange | null;
		const setting = whatsappParameterSettings.find((entry) => entry.key === item?.key);
		if (!setting || !item || seen.has(item.key))
			throw new BadRequestError("Configuração desconhecida ou repetida.");
		seen.add(item.key);
		if (
			item.previousValue !== null &&
			(typeof item.previousValue !== "string" || item.previousValue.length > 1000)
		) {
			throw new BadRequestError("Valor anterior inválido.");
		}
		if (item.value !== null) {
			if (setting.type === "boolean" && item.value !== "true" && item.value !== "false") {
				throw new BadRequestError(`${setting.label}: escolha ativado ou desativado.`);
			}
			if (setting.type === "number") {
				const value = Number(item.value);
				const multiplier = setting.multiplier ?? 1;
				if (
					typeof item.value !== "string" ||
					!/^\d+$/.test(item.value) ||
					!Number.isSafeInteger(value) ||
					value < (setting.min ?? 0) * multiplier ||
					value > (setting.max ?? 2147483647) * multiplier
				) {
					throw new BadRequestError(`${setting.label}: informe um número dentro do intervalo permitido.`);
				}
			}
		}
		return { key: item.key, value: item.value, previousValue: item.previousValue };
	});
}
