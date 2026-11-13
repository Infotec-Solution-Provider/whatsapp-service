import { BadRequestError, UnauthorizedError } from "@rgranatodutra/http-errors";

/** Semantics owned by customers-service homolog bd41497:
 * src/services/customer-search/query.ts (parseCustomerSearch/applyCustomerSearch).
 * The agenda executes the equivalent bounded ID projection through instances HTTP.
 */
export const operatorCustomerFilterKeys = [
	"purchaseStatus",
	"purchaseFrom",
	"purchaseTo",
	"registeredFrom",
	"registeredTo",
	"segmentIds",
	"loyaltyOperatorIds",
	"groupIds",
	"originIds",
	"mediaIds",
	"unitIds",
	"brandIds",
	"positionIds",
	"states",
	"phone",
	"email",
	"CODIGO",
	"CPF_CNPJ",
	"COD_ERP",
	"CIDADE",
	"ATIVO",
	"PESSOA"
] as const;
export type OperatorCustomerFilterKey = (typeof operatorCustomerFilterKeys)[number];
const lists = [
	"segmentIds",
	"loyaltyOperatorIds",
	"groupIds",
	"originIds",
	"mediaIds",
	"unitIds",
	"brandIds",
	"positionIds"
] as const;
const dates = ["purchaseFrom", "purchaseTo", "registeredFrom", "registeredTo"] as const;
const textFields = ["phone", "email", "CODIGO", "CPF_CNPJ", "COD_ERP", "CIDADE", "ATIVO", "PESSOA"] as const;
export interface OperatorCustomerFilters {
	values: Partial<Record<OperatorCustomerFilterKey, string>>;
	lists: Partial<Record<(typeof lists)[number], number[]>>;
}
const invalid = (message: string): never => {
	throw new BadRequestError(message);
};

export function parseCrmIdList(value: string): number[] {
	const parts = value.split(",");
	if (parts.length > 100 || parts.some((part) => !/^(?:0|-?[1-9]\d*)$/.test(part.trim())))
		return invalid("Seleção de códigos inválida.");
	const ids = [...new Set(parts.map(Number))];
	if (ids.some((id) => id < -2147483648 || id > 2147483647)) return invalid("Código fora do limite do CRM.");
	return ids;
}

export function parseOperatorCustomerFilters(input: unknown): OperatorCustomerFilters {
	if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Filtros de clientes inválidos.");
	const result: OperatorCustomerFilters = { values: {}, lists: {} };
	for (const [key, raw] of Object.entries(input)) {
		if (
			!(operatorCustomerFilterKeys as readonly string[]).includes(key) ||
			typeof raw !== "string" ||
			raw.length > 1500
		)
			return invalid("Filtro de cliente inválido.");
		const value = raw.trim();
		if (value) result.values[key as OperatorCustomerFilterKey] = value;
	}
	for (const key of lists)
		if (result.values[key]) {
			const ids = parseCrmIdList(result.values[key]!);
			result.lists[key] = ids;
			result.values[key] = ids.join(",");
		}
	for (const key of dates)
		if (result.values[key]) {
			const value = result.values[key]!;
			if (
				!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
				value < "1000-01-01" ||
				Number.isNaN(Date.parse(value + "T00:00:00Z")) ||
				new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
			)
				return invalid("Data de cliente inválida.");
		}
	for (const [from, to] of [
		["purchaseFrom", "purchaseTo"],
		["registeredFrom", "registeredTo"]
	] as const)
		if (result.values[from] && result.values[to] && result.values[from]! > result.values[to]!)
			return invalid("A data inicial deve ser anterior ou igual à final.");
	const v = result.values;
	if (v.purchaseStatus && !["with_purchases", "without_purchases"].includes(v.purchaseStatus))
		return invalid("Situação de compras inválida.");
	if (v.purchaseStatus === "without_purchases" && (v.purchaseFrom || v.purchaseTo))
		return invalid("O filtro sem compras não aceita período de compra.");
	if (v.ATIVO && !["SIM", "NAO"].includes(v.ATIVO)) return invalid("Situação de cliente inválida.");
	if (v.PESSOA && !["FIS", "JUR"].includes(v.PESSOA)) return invalid("Tipo de pessoa inválido.");
	if (
		v.states &&
		(v.states.split(",").length > 100 || v.states.split(",").some((state) => !/^[A-Z]{2}$/.test(state)))
	)
		return invalid("Selecione estados válidos.");
	for (const key of textFields) if ((v[key]?.length ?? 0) > 255) return invalid("Texto de cliente muito longo.");
	if (v.phone && (!/^\+?[\d ()\-.]+$/.test(v.phone) || v.phone.replace(/\D/g, "").length < 3))
		return invalid("Informe pelo menos três dígitos do telefone.");
	if (v.CODIGO && !/^-?\d+$/.test(v.CODIGO)) return invalid("Código de cliente inválido.");
	if (v.CPF_CNPJ) {
		const digits = v.CPF_CNPJ.replace(/\D/g, "");
		if (!digits) return invalid("Documento inválido.");
		v.CPF_CNPJ = digits;
	}
	return result;
}

export function pickOperatorCustomerFilters(input: object): OperatorCustomerFilters {
	return parseOperatorCustomerFilters(
		Object.fromEntries(
			Object.entries(input).filter(([key]) => (operatorCustomerFilterKeys as readonly string[]).includes(key))
		)
	);
}
export function hasOperatorCustomerFilters(filters: OperatorCustomerFilters): boolean {
	return Object.keys(filters.values).length > 0;
}
export function hasPurchaseFilters(filters: OperatorCustomerFilters): boolean {
	return Boolean(filters.values.purchaseStatus || filters.values.purchaseFrom || filters.values.purchaseTo);
}
const like = (value: string) => `%${value.replace(/[!%_]/g, (char) => "!" + char)}%`;

export function operatorCustomerMatchQuery(
	ids: number[],
	filters: OperatorCustomerFilters,
	actor: { admin: boolean; allowed: boolean }
) {
	if (ids.length > 200 || ids.some((id) => !Number.isInteger(id) || id < -2147483648 || id > 2147483647))
		return invalid("Lote de clientes inválido.");
	const financial = hasPurchaseFilters(filters);
	if (financial && !actor.allowed)
		throw new UnauthorizedError("Seu perfil não permite filtros de informações financeiras.");
	const v = filters.values,
		conditions: string[] = [],
		parameters: unknown[] = [],
		list = filters.lists;
	const add = (predicate: string, ...values: unknown[]) => {
		conditions.push(predicate);
		parameters.push(...values);
	};
	const choices = (column: string, values: readonly unknown[]) =>
		add(`${column} IN (${values.map(() => "?").join(",")})`, ...values);
	if (ids.length) choices("clientes.CODIGO", [...new Set(ids)]);
	else add("1=0");
	if (v.CODIGO) add("CAST(clientes.CODIGO AS CHAR) LIKE ? ESCAPE '!'", like(v.CODIGO));
	if (v.CPF_CNPJ) add("clientes.CPF_CNPJ = ?", v.CPF_CNPJ);
	if (v.COD_ERP) add("clientes.COD_ERP LIKE ? ESCAPE '!'", like(v.COD_ERP));
	if (v.email) add("clientes.EMAIL LIKE ? ESCAPE '!'", like(v.email));
	for (const key of ["CIDADE", "ATIVO", "PESSOA"] as const) if (v[key]) add(`clientes.${key} = ?`, v[key]);
	if (v.states) choices("clientes.ESTADO", v.states.split(","));
	const columns = {
		segmentIds: "SEGMENTO",
		groupIds: "GRUPO",
		originIds: "ORIGEM",
		mediaIds: "COD_MIDIA",
		unitIds: "COD_UNIDADE"
	} as const;
	for (const key of Object.keys(columns) as Array<keyof typeof columns>)
		if (list[key]?.length) choices(`clientes.${columns[key]}`, list[key]!);
	if (v.registeredFrom) add("clientes.DATACAD >= ?", v.registeredFrom + " 00:00:00");
	if (v.registeredTo) add("clientes.DATACAD < DATE_ADD(?, INTERVAL 1 DAY)", v.registeredTo);
	if (financial) {
		const purchaseConditions = ["purchase.CLIENTE = clientes.CODIGO"];
		if (v.purchaseFrom) {
			purchaseConditions.push("purchase.DATA >= ?");
			parameters.push(v.purchaseFrom + " 00:00:00");
		}
		if (v.purchaseTo) {
			purchaseConditions.push("purchase.DATA < DATE_ADD(?, INTERVAL 1 DAY)");
			parameters.push(v.purchaseTo);
		}
		conditions.push(
			`${v.purchaseStatus === "without_purchases" ? "NOT " : ""}EXISTS(SELECT 1 FROM compras purchase WHERE ${purchaseConditions.join(" AND ")})`
		);
	}
	for (const [key, table, alias, column] of [
		["brandIds", "clientes_marcas", "brand", "MARCA"],
		["positionIds", "contatos", "contact", "CARGO"]
	] as const)
		if (list[key]?.length)
			add(
				`EXISTS(SELECT 1 FROM ${table} ${alias} WHERE ${alias}.CLIENTE = clientes.CODIGO AND ${alias}.${column} IN (${list[key]!.map(() => "?").join(",")}))`,
				...list[key]!
			);
	if (list.loyaltyOperatorIds?.length)
		add(
			`EXISTS(SELECT 1 FROM campanhas_clientes loyalty WHERE loyalty.CLIENTE = clientes.CODIGO AND loyalty.OPERADOR IN (${list.loyaltyOperatorIds.map(() => "?").join(",")}) AND (loyalty.CONCLUIDO='NAO' OR loyalty.DT_RESULTADO<'1970-01-01'))`,
			...list.loyaltyOperatorIds
		);
	if (v.phone) {
		const digits = `%${v.phone.replace(/\D/g, "")}%`;
		add(
			"(" +
				["FONE1", "FONE2", "FONE3"]
					.map(
						(column) =>
							`REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(clientes.${column}, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '') LIKE ?`
					)
					.join(" OR ") +
				")",
			digits,
			digits,
			digits
		);
	}
	if (financial && !actor.admin) add("COALESCE(clientes.BLOCK_COMPRAS, 'NAO') <> 'SIM'");
	return {
		sql:
			"SELECT /*+ MAX_EXECUTION_TIME(5000) */ clientes.CODIGO FROM clientes WHERE " +
			conditions.join(" AND ") +
			" ORDER BY clientes.CODIGO ASC LIMIT 200",
		parameters
	};
}
