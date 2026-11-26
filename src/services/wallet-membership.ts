import { BadRequestError } from "@rgranatodutra/http-errors";

import type { Prisma } from "@prisma/client";

export type WalletRule = { sectorId: number | null; role: string | null };
export type DirectoryUser = { CODIGO: number; NOME: string; SETOR: number | null; NIVEL: string | null };
export function parseRules(input: unknown): WalletRule[] {
	if (!Array.isArray(input)) throw new BadRequestError("Informe uma lista de regras.");
	const rules: WalletRule[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(k => !["sectorId", "role"].includes(k)))
			throw new BadRequestError("Regra de participação inválida.");
		const sectorId = item.sectorId ?? null, role = item.role ?? null;
		if ((sectorId !== null && (!Number.isSafeInteger(sectorId) || sectorId <= 0)) ||
			(role !== null && (typeof role !== "string" || !/^[A-Z_0-9 -]{1,40}$/i.test(role))) ||
			(sectorId === null && role === null)) throw new BadRequestError("Cada regra precisa de um setor ou perfil.");
		rules.push({ sectorId, role });
	}
	if (Buffer.byteLength(JSON.stringify(rules)) > 65535) throw new BadRequestError("As regras excedem o tamanho da carteira.");
	return rules;
}

export function memberPreview(users: DirectoryUser[], manualIds: number[], rules: WalletRule[]) {
	const manual = new Set(manualIds);
	return users.flatMap(user => {
		const matchedRules = rules.flatMap((rule, index) =>
			(rule.sectorId === null || rule.sectorId === user.SETOR) && (rule.role === null || rule.role === user.NIVEL) ? [index + 1] : []);
		const selected = manual.has(user.CODIGO);
		return selected || matchedRules.length ? [{ id: user.CODIGO, name: user.NOME, manual: selected, matchedRules }] : [];
	});
}

export function walletHistoryFilter(userId: number, ids: number[]): Prisma.WppMessageWhereInput {
	return { OR: [{ chatId: null }, { WppChat: { walletId: null } }, { WppChat: { userId } },
		...(ids.length ? [{ WppChat: { walletId: { in: ids } } }] : [])] };
}
