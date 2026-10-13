import { Prisma } from "@prisma/client";
import { field, model, ModelMetadata, models, quote, RelationMetadata, scalarValue, ScalarField } from "./metadata";

export { quote as quoteIdent } from "./metadata";
export interface CompiledWhere { sql: string; params: unknown[] }
type Input = Record<string, unknown>;
const record = (value: unknown): value is Input => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Uint8Array);
const clauses = (items: string[], operator: "AND" | "OR", empty: string): string => items.length ? `(${items.join(` ${operator} `)})` : empty;
export function column(name: string | ModelMetadata, key: string, alias?: string): string {
	return `${alias ? `${quote(alias)}.` : ""}${quote(field(name, key).column)}`;
}

export function compileWhere(name: string | ModelMetadata, where?: unknown, alias?: string, params: unknown[] = []): CompiledWhere {
	let counter = 0;
	const parameter = (f: ScalarField, value: unknown): string => { params.push(scalarValue(f, value)); return "?"; };
	const scalar = (metadata: ModelMetadata, f: ScalarField, value: unknown, currentAlias?: string): string => {
		const col = column(metadata, f.name, currentAlias);
		if (value === null || value === Prisma.DbNull) return `${col} IS NULL`;
		if (value === Prisma.JsonNull || !record(value) || f.type === "Json" && !Object.keys(value).some(k => ["equals", "not", "path", "string_contains", "array_contains"].includes(k))) return `${col} = ${parameter(f, value)}`;
		const items: string[] = [];
		for (const [operator, operand] of Object.entries(value)) {
			if (operand === undefined) continue;
			if (operator === "mode") {
				if (operand !== "default" && operand !== "insensitive") throw new Error("TENANT_SQL_FILTER_MODE_UNSUPPORTED");
				continue;
			}
			if (operator === "equals") items.push(operand === null || operand === Prisma.DbNull ? `${col} IS NULL` : `${col} = ${parameter(f, operand)}`);
			else if (operator === "not") items.push(operand === null || operand === Prisma.DbNull ? `${col} IS NOT NULL` : `NOT (${scalar(metadata, f, operand, currentAlias)})`);
			else if (operator === "in" || operator === "notIn") {
				if (!Array.isArray(operand)) throw new Error("TENANT_SQL_FILTER_LIST_INVALID");
				items.push(operand.length ? `${col} ${operator === "in" ? "IN" : "NOT IN"} (${operand.map(v => parameter(f, v)).join(", ")})` : operator === "in" ? "0=1" : "1=1");
			} else if (["lt", "lte", "gt", "gte"].includes(operator)) {
				const comparison = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[operator as "lt" | "lte" | "gt" | "gte"];
				items.push(`${col} ${comparison} ${parameter(f, operand)}`);
			} else if (["contains", "startsWith", "endsWith"].includes(operator)) {
				if (typeof operand !== "string" || f.type !== "String") throw new Error("TENANT_SQL_STRING_FILTER_INVALID");
				// A dedicated escape character also works with NO_BACKSLASH_ESCAPES.
				const escaped = operand.replace(/[!%_]/g, character => `!${character}`);
				const pattern = `${operator === "contains" || operator === "endsWith" ? "%" : ""}${escaped}${operator === "contains" || operator === "startsWith" ? "%" : ""}`;
				const expression = value["mode"] === "insensitive" ? `LOWER(${col})` : col;
				params.push(value["mode"] === "insensitive" ? pattern.toLowerCase() : pattern);
				items.push(`${expression} LIKE ? ESCAPE '!'`);
			} else throw new Error(`TENANT_SQL_FILTER_UNSUPPORTED: ${operator}`);
		}
		return clauses(items, "AND", "1=1");
	};
	const relationFilter = (metadata: ModelMetadata, relation: RelationMetadata, filter: unknown, currentAlias?: string): string => {
		const target = model(relation.target), targetAlias = `r${++counter}`;
		const sourceAlias = currentAlias ?? metadata.table;
		const joinAlias = `j${counter}`;
		const correlation = relation.join
			? `${quote(joinAlias)}.${quote(relation.join.localColumn)} = ${column(metadata, relation.localFields[0]!, sourceAlias)}`
			: relation.localFields.map((key, index) => `${column(target, relation.targetFields[index]!, targetAlias)} = ${column(metadata, key, sourceAlias)}`).join(" AND ");
		const from = relation.join
			? `${quote(target.table)} ${quote(targetAlias)} JOIN ${quote(relation.join.table)} ${quote(joinAlias)} ON ${quote(joinAlias)}.${quote(relation.join.targetColumn)} = ${column(target, relation.targetFields[0]!, targetAlias)}`
			: `${quote(target.table)} ${quote(targetAlias)}`;
		const exists = (condition: unknown, negate: boolean, every = false): string => {
			const predicate = visit(target, condition, targetAlias);
			return `${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM ${from} WHERE ${correlation} AND ${every ? `NOT (${predicate})` : predicate})`;
		};
		if (filter === null) return exists({}, true);
		if (!record(filter)) throw new Error("TENANT_SQL_RELATION_FILTER_INVALID");
		const explicit = Object.keys(filter).some(key => ["some", "none", "every", "is", "isNot"].includes(key));
		if (!explicit) return exists(filter, false);
		const items: string[] = [];
		for (const [operator, condition] of Object.entries(filter)) {
			if (condition === undefined) continue;
			if (operator === "some") items.push(exists(condition, false));
			else if (operator === "none") items.push(exists(condition, true));
			else if (operator === "every") items.push(exists(condition, true, true));
			else if (operator === "is") items.push(exists(condition ?? {}, condition === null));
			else if (operator === "isNot") items.push(exists(condition ?? {}, condition !== null));
			else throw new Error(`TENANT_SQL_RELATION_FILTER_UNSUPPORTED: ${operator}`);
		}
		return clauses(items, "AND", "1=1");
	};
	const visit = (metadata: ModelMetadata, input: unknown, currentAlias?: string): string => {
		if (input === undefined) return "1=1";
		if (!record(input)) throw new Error("TENANT_SQL_WHERE_INVALID");
		const items: string[] = [];
		for (const [key, value] of Object.entries(input)) {
			if (value === undefined) continue;
			if (["AND", "OR", "NOT"].includes(key)) {
				const entries = Array.isArray(value) ? value : [value];
				const compiled = entries.map(entry => visit(metadata, entry, currentAlias));
				items.push(key === "NOT" ? clauses(compiled.map(sql => `NOT (${sql})`), "AND", "1=1") : clauses(compiled, key as "AND" | "OR", key === "OR" ? "0=1" : "1=1"));
			} else if (metadata.fields[key]) items.push(scalar(metadata, metadata.fields[key]!, value, currentAlias));
			else if (metadata.relations[key]) items.push(relationFilter(metadata, metadata.relations[key]!, value, currentAlias));
			else if (metadata.uniqueKeys[key]) {
				if (!record(value)) throw new Error("TENANT_SQL_COMPOUND_KEY_INVALID");
				const keys = metadata.uniqueKeys[key]!;
				if (Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => value[k] === undefined)) throw new Error("TENANT_SQL_COMPOUND_KEY_INVALID");
				items.push(visit(metadata, value, currentAlias));
			} else throw new Error(`TENANT_SQL_WHERE_FIELD_UNSUPPORTED: ${key}`);
		}
		return clauses(items, "AND", "1=1");
	};
	return { sql: visit(model(name), where, alias), params };
}

export function compileOrderBy(name: string | ModelMetadata, orderBy?: unknown, alias?: string): string {
	if (orderBy === undefined) return "";
	const metadata = model(name), items: string[] = [];
	let counter = 0;
	for (const order of Array.isArray(orderBy) ? orderBy : [orderBy]) {
		if (!record(order)) throw new Error("TENANT_SQL_ORDER_INVALID");
		for (const [key, value] of Object.entries(order)) {
			if (value === undefined) continue;
			if (["_count", "_sum", "_avg", "_min", "_max"].includes(key)) {
				if (!record(value)) throw new Error("TENANT_SQL_AGGREGATE_ORDER_INVALID");
				for (const [aggregateField, direction] of Object.entries(value)) {
					if (direction !== "asc" && direction !== "desc") throw new Error("TENANT_SQL_ORDER_DIRECTION_INVALID");
					const expression = aggregateField === "_all" && key === "_count" ? "*" : column(metadata, aggregateField, alias);
					items.push(`${key.slice(1).toUpperCase()}(${expression}) ${direction.toUpperCase()}`);
				}
				continue;
			}
			const relation = metadata.relations[key];
			if (relation) {
				if (!record(value) || Object.keys(value).length !== 1 || !["asc", "desc"].includes(String(value["_count"]))) throw new Error("TENANT_SQL_RELATION_ORDER_UNSUPPORTED");
				const target = model(relation.target), targetAlias = `o${++counter}`, sourceAlias = alias ?? metadata.table;
				const correlation = relation.join
					? `${quote(targetAlias)}.${quote(relation.join.localColumn)} = ${column(metadata, relation.localFields[0]!, sourceAlias)}`
					: relation.localFields.map((f, index) => `${column(target, relation.targetFields[index]!, targetAlias)} = ${column(metadata, f, sourceAlias)}`).join(" AND ");
				items.push(`(SELECT COUNT(*) FROM ${quote(relation.join?.table ?? target.table)} ${quote(targetAlias)} WHERE ${correlation}) ${String(value["_count"]).toUpperCase()}`);
				continue;
			}
			const direction = record(value) ? value["sort"] : value;
			if (direction !== "asc" && direction !== "desc") throw new Error("TENANT_SQL_ORDER_DIRECTION_INVALID");
			const expression = column(metadata, key, alias);
			if (record(value) && value["nulls"] !== undefined) {
				if (value["nulls"] !== "first" && value["nulls"] !== "last") throw new Error("TENANT_SQL_ORDER_NULLS_INVALID");
				items.push(`(${expression} IS NULL) ${value["nulls"] === "first" ? "DESC" : "ASC"}`);
			}
			items.push(`${expression} ${direction.toUpperCase()}`);
		}
	}
	return items.join(", ");
}

interface SqlToken { value: string; start: number; end: number; identifier: boolean }
/** Rewrites table identifiers only; quoted strings, comments and column names are untouched. */
export function rewriteRawSql(sql: string): string {
	const tableNames = new Map<string, string>();
	for (const metadata of models) {
		tableNames.set(metadata.dbName.toLowerCase(), metadata.table);
		for (const relation of Object.values(metadata.relations)) if (relation.join) tableNames.set(relation.join.table.slice("wpp_runtime_".length).toLowerCase(), relation.join.table);
	}
	const tokens: SqlToken[] = [];
	let index = 0;
	while (index < sql.length) {
		const char = sql[index]!;
		if (/\s/.test(char)) { index++; continue; }
		if (char === "'" || char === '"') {
			const delimiter = char; index++;
			while (index < sql.length) {
				if (sql[index] === "\\") { index += 2; continue; }
				if (sql[index] === delimiter) { index++; if (sql[index] === delimiter) { index++; continue; } break; }
				index++;
			}
			continue;
		}
		if (char === "#" || char === "-" && sql[index + 1] === "-" && /\s/.test(sql[index + 2] ?? " ")) { while (index < sql.length && sql[index] !== "\n") index++; continue; }
		if (char === "/" && sql[index + 1] === "*") { const end = sql.indexOf("*/", index + 2); index = end < 0 ? sql.length : end + 2; continue; }
		const start = index;
		if (char === "`") {
			let value = ""; index++;
			while (index < sql.length) {
				if (sql[index] === "`") { index++; if (sql[index] === "`") { value += "`"; index++; continue; } break; }
				value += sql[index++];
			}
			tokens.push({ value, start, end: index, identifier: true });
		} else if (/[A-Za-z_]/.test(char)) {
			while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
			tokens.push({ value: sql.slice(start, index), start, end: index, identifier: true });
		} else { index++; tokens.push({ value: char, start, end: index, identifier: false }); }
	}
	const replacements: Array<{ start: number; end: number; value: string }> = [];
	for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
		const keyword = tokens[tokenIndex]!;
		if (!keyword.identifier || sql[keyword.start] === "`" || !["FROM", "JOIN", "UPDATE", "INTO"].includes(keyword.value.toUpperCase())) continue;
		if (keyword.value.toUpperCase() === "UPDATE" && tokens[tokenIndex - 1]?.value.toUpperCase() === "KEY") continue;
		let nameIndex = tokenIndex + 1;
		while (["LOW_PRIORITY", "IGNORE", "DELAYED"].includes(tokens[nameIndex]?.value.toUpperCase() ?? "")) nameIndex++;
		let name = tokens[nameIndex];
		if (!name?.identifier) continue;
		if (tokens[nameIndex + 1]?.value === ".") { nameIndex += 2; name = tokens[nameIndex]; }
		if (!name?.identifier) continue;
		const replacement = tableNames.get(name.value.toLowerCase());
		if (replacement) replacements.push({ start: name.start, end: name.end, value: quote(replacement) });
	}
	let result = sql;
	for (const replacement of replacements.reverse()) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
	return result;
}
