import { OperatorRuntimeError, validActor, type RuntimeRow } from "./core";
export const runtimeActions = ["policy","status","pause","prepare","legacy.prepare.verify","event","list","get","review","session","metrics","finish.begin","finish.verify","finish.status","finish.inspect","finish.due"] as const;
export type RuntimeAction = typeof runtimeActions[number];
export interface CentralCommand {operation:"operator.runtime";actorId:number;action:RuntimeAction;input:RuntimeRow}
export const invalid = (): never => { throw new OperatorRuntimeError("OPERATOR_RUNTIME_INVALID_REQUEST",400); };
export function uuid(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) return invalid();
	return value.toLowerCase();
}
export function positive(value: unknown, optional = false): number | null {
	if (value == null && optional) return null;
	if (!validActor(value)) return invalid();return value;
}
export function boundedText(value: unknown, max: number, optional = false): string {
	if (value == null && optional) return "";
	if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) return invalid();return value;
}
export function parseCommand(value: unknown): CentralCommand {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const row=value as RuntimeRow;
	if (Object.keys(row).some(k=>!["operation","actorId","action","input"].includes(k)) || row["operation"]!=="operator.runtime" || !validActor(row["actorId"]) || !runtimeActions.includes(row["action"] as RuntimeAction) || !row["input"] || typeof row["input"]!=="object" || Array.isArray(row["input"])) return invalid();
	return row as unknown as CentralCommand;
}
export function iso(value: unknown): string | null {
	if (value == null) return null;
	const time=value instanceof Date?value:new Date(String(value).replace(" ","T")+(/Z$|[+-]\d\d:\d\d$/.test(String(value))?"":"Z"));
	if (!Number.isFinite(time.getTime())) return invalid();return time.toISOString();
}
