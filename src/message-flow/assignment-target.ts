export interface AssignmentOperator { CODIGO: number; SETOR: number; ATIVO: string | null; NIVEL: string | null; }
export interface AssignmentTargetConfig { userId: number; fallbackUserId: number; fallbackRequireAdmin?: boolean; }
export interface AssignmentTargetResult { userId: number; reason: "target_valid" | "target_invalid_fallback" | "validation_unavailable"; }
export class AssignmentTargetUnavailableError extends Error {
	readonly code = "ASSIGNMENT_TARGET_UNAVAILABLE";
	constructor() { super("Configured assignment target and fallback are unavailable"); }
}

/** A transient CRM outage does not revoke the two destinations approved at deployment. */
export async function resolveAssignmentTarget(
	config: AssignmentTargetConfig,
	sectorId: number,
	readOperators: (ids: number[]) => Promise<AssignmentOperator[]>
): Promise<AssignmentTargetResult> {
	let rows: AssignmentOperator[];
	try { rows = await readOperators([config.userId, config.fallbackUserId]); }
	catch { return { userId: config.userId, reason: "validation_unavailable" }; }
	const valid = (id: number, admin: boolean) => {
		const matches = rows.filter((row) => row.CODIGO === id);
		return matches.length === 1 && matches[0]!.ATIVO === "SIM" && matches[0]!.SETOR === sectorId && (!admin || matches[0]!.NIVEL === "ADMIN");
	};
	if (valid(config.userId, false)) return { userId: config.userId, reason: "target_valid" };
	if (valid(config.fallbackUserId, config.fallbackRequireAdmin === true)) return { userId: config.fallbackUserId, reason: "target_invalid_fallback" };
	throw new AssignmentTargetUnavailableError();
}
