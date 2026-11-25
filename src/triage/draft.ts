import { BadRequestError } from "@rgranatodutra/http-errors";

const nodeTypes = new Set(["message", "menu", "question", "condition", "hours", "handoff"]);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string";
const nullableInteger = (v: unknown) => v === null || Number.isSafeInteger(v);
const knownFields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((key) => keys.includes(key));
function editableNode(v: unknown) {
	if (
		!record(v) ||
		typeof v["id"] !== "string" ||
		!/^[A-Za-z0-9_-]{1,64}$/.test(v["id"]) ||
		["__proto__", "constructor", "prototype"].includes(v["id"]) ||
		!text(v["title"]) ||
		!nodeTypes.has(String(v["type"]))
	)
		return false;
	const strings = ["text", "next", "answerKey", "equals", "yes", "no"];
	if (strings.some((key) => v[key] !== undefined && !text(v[key]))) return false;
	if (v["sectorId"] !== undefined && !nullableInteger(v["sectorId"])) return false;
	if (
		v["options"] !== undefined &&
		(!Array.isArray(v["options"]) ||
			v["options"].length > 100 ||
			!v["options"].every(
				(o) => record(o) && knownFields(o, ["label", "next"]) && text(o["label"]) && text(o["next"])
			))
	)
		return false;
	return knownFields(v, ["id", "type", "title", ...strings, "sectorId", "options"]);
}
// A link, name, destination or time may still be incomplete. Persist only data the editor can reopen.
export function encodeTriageDraft(value: unknown): string {
	if (
		record(value) &&
		knownFields(value, ["entry", "nodes", "fallbackSectorId", "timeoutMinutes", "maxInvalid", "schedule"]) &&
		text(value["entry"]) &&
		Number.isSafeInteger(value["timeoutMinutes"]) &&
		Number.isSafeInteger(value["maxInvalid"]) &&
		nullableInteger(value["fallbackSectorId"]) &&
		Array.isArray(value["nodes"]) &&
		value["nodes"].length <= 100 &&
		value["nodes"].every(editableNode) &&
		new Set(value["nodes"].map((n) => n.id)).size === value["nodes"].length
	) {
		const schedule = value["schedule"];
		if (
			record(schedule) &&
			knownFields(schedule, ["timezone", "days"]) &&
			text(schedule["timezone"]) &&
			Array.isArray(schedule["days"]) &&
			schedule["days"].length <= 100 &&
			schedule["days"].every(
				(d) =>
					record(d) &&
					knownFields(d, ["day", "start", "end"]) &&
					Number.isSafeInteger(d["day"]) &&
					text(d["start"]) &&
					text(d["end"])
			)
		) {
			const encoded = JSON.stringify(value);
			if (Buffer.byteLength(encoded) <= 192 * 1024) return encoded;
		}
	}
	throw new BadRequestError("O formato do rascunho é inválido ou excede 192 KiB.");
}
