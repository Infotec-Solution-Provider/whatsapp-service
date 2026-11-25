import type { TriageReader } from "./access";

const tables = [
	"triage_channels",
	"triage_bots",
	"triage_bot_versions",
	"triage_versions",
	"triage_grants",
	"triage_audit",
	"triage_sessions",
	"triage_events",
	"triage_effects",
	"triage_runs",
	"triage_trigger_notices",
	"triage_trigger_sets"
];
export class TriageNotPrepared extends Error {}
export const readinessMessage =
	"O banco do WhatsApp desta empresa aguarda a preparação das tabelas de triagem. Tente novamente após a atualização do ambiente.";

export async function assertTriageTables(db: TriageReader, native: boolean) {
	const names = native ? tables.map((t) => "wpp_runtime_" + t) : tables;
	const [row] = await db.$queryRawUnsafe<{ ready: number | bigint }[]>(
		"SELECT COUNT(*) AS ready FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' AND table_name IN (" +
			names.map(() => "?").join(",") +
			")",
		...names
	);
	if (Number(row?.ready) !== tables.length) throw new TriageNotPrepared(readinessMessage);
}
function mysqlError(error: unknown) {
	const e = error as {
		code?: string;
		errno?: number;
		message?: string;
		meta?: { code?: string; message?: string };
	} | null;
	return { code: e?.meta?.code ?? e?.code, number: e?.errno, message: e?.meta?.message ?? e?.message ?? "" };
}
export function missingBindingsTable(error: unknown) {
	const { code, number, message } = mysqlError(error);
	return (
		(number === 1146 || code === "1146" || code === "ER_NO_SUCH_TABLE") &&
		/\b(?:wpp_runtime_)?triage_(?:channels|bots)\b/.test(message)
	);
}
export function unavailableDatabase(error: unknown) {
	const { code, number } = mysqlError(error);
	return number === 1049 || code === "ER_BAD_DB_ERROR" || code === "1049" || code === "P1003";
}
