import type { AssignmentOperator } from "./assignment-target";
import type { UserOnlineSession } from "../sdk-local";
import auth from "../services/auth.service";
import instances from "../services/instances.service";
import db from "../services/prisma.service";
import { pauseEligibleOperatorIds } from "../services/operator-pause-admission.runtime";

export interface FlowOperator extends AssignmentOperator { NOME?: string }
export interface FlowDistributionReads {
	sessions(instance: string): Promise<UserOnlineSession[]>;
	eligible(instance: string, userIds: number[]): Promise<Set<number>>;
	chatCounts(instance: string, userIds: number[]): Promise<Map<number, number>>;
	loyalty(instance: string, customerId: number): Promise<number | null>;
	operators(instance: string, userIds: number[]): Promise<FlowOperator[]>;
	sectorOperators(instance: string, sectorId: number): Promise<FlowOperator[]>;
}

export const distributionReads: FlowDistributionReads = {
	sessions: instance => auth.getOnlineSessions(instance),
	eligible: pauseEligibleOperatorIds,
	async chatCounts(instance, userIds) {
		const rows = await db.wppChat.groupBy({ by: ["userId"], where: { instance, isFinished: false, userId: { in: userIds } }, _count: { id: true } });
		const result = new Map<number, number>();
		for (const row of rows) if (row.userId !== null) result.set(row.userId, row._count.id);
		return result;
	},
	async loyalty(instance, customerId) {
		const rows = await instances.executeQuery<Array<{ OPERADOR: number }>>(instance,
			"SELECT OPERADOR FROM campanhas_clientes WHERE CLIENTE = ? ORDER BY CODIGO DESC LIMIT 1", [customerId]);
		return rows[0]?.OPERADOR ?? null;
	},
	async operators(instance, ids) {
		if (!ids.length) return [];
		const marks = ids.map(() => "?").join(",");
		// Same-sector fidelity previously did a single-operator lookup.
		const predicate = ids.length === 1 ? "CODIGO = ?" : `CODIGO IN (${marks})`;
		return instances.executeQuery<FlowOperator[]>(instance,
			`SELECT CODIGO,NOME,SETOR,ATIVO,NIVEL FROM operadores WHERE ${predicate}`, ids, { timeoutMs: 3000 });
	},
	sectorOperators: (instance, sectorId) => instances.executeQuery<FlowOperator[]>(instance,
		"SELECT CODIGO,NOME,SETOR,ATIVO,NIVEL FROM operadores WHERE SETOR = ?", [sectorId])
};
