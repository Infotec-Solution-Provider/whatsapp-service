import { Prisma } from "@prisma/client";

/** Schema metadata only. Importing this module never creates a database client. */
export type ScalarField = Prisma.DMMF.Field & { column: string };
export interface RelationMetadata {
	name: string;
	target: string;
	isList: boolean;
	isRequired: boolean;
	relationName: string;
	localFields: string[];
	targetFields: string[];
	fields: string[];
	references: string[];
	inverse: string;
	isInverse: boolean;
	join?: { table: string; localColumn: string; targetColumn: string };
}
export interface ModelMetadata {
	name: string;
	delegate: string;
	dbName: string;
	table: string;
	fields: Record<string, ScalarField>;
	scalars: ScalarField[];
	relations: Record<string, RelationMetadata>;
	primaryKey: string[];
	uniqueKeys: Record<string, string[]>;
	uniques: string[][];
	instanceField?: ScalarField;
	updatedAt?: ScalarField;
}
export type ModelMeta = ModelMetadata;

const active = Prisma.dmmf.datamodel.models.filter(item =>
	item.name !== "ProcessLog" && !item.name.startsWith("FrontendPerformance") && !item.name.startsWith("InstanceMigration"));
export const models: ModelMetadata[] = active.map(item => {
	const scalars = item.fields.filter(f => f.kind !== "object").map(f => ({ ...f, column: f.dbName ?? f.name }));
	const primaryKey = item.primaryKey ? [...item.primaryKey.fields] : scalars.filter(f => f.isId).map(f => f.name);
	const uniqueKeys: Record<string, string[]> = {};
	if (primaryKey.length > 1) uniqueKeys[item.primaryKey?.name ?? primaryKey.join("_")] = primaryKey;
	for (const index of item.uniqueIndexes) uniqueKeys[index.name ?? index.fields.join("_")] = [...index.fields];
	for (const f of scalars.filter(f => f.isId || f.isUnique)) uniqueKeys[f.name] = [f.name];
	const instanceField = scalars.find(f => f.name === "instance");
	const updatedAt = scalars.find(f => f.isUpdatedAt);
	return {
		name: item.name, delegate: item.name[0]!.toLowerCase() + item.name.slice(1), dbName: item.dbName ?? item.name,
		table: `wpp_runtime_${item.dbName ?? item.name}`, scalars, fields: Object.fromEntries(scalars.map(f => [f.name, f])),
		relations: {}, primaryKey, uniqueKeys, uniques: Object.values(uniqueKeys),
		...(instanceField ? { instanceField } : {}), ...(updatedAt ? { updatedAt } : {}),
	};
});
const lookup = new Map<string, ModelMetadata>();
for (const item of models) for (const key of [item.name, item.delegate, item.dbName, item.table]) lookup.set(key, item);

export function model(nameOrDelegate: string | ModelMetadata): ModelMetadata {
	if (typeof nameOrDelegate !== "string") return nameOrDelegate;
	const metadata = lookup.get(nameOrDelegate);
	if (!metadata) throw new Error(`TENANT_SQL_MODEL_UNSUPPORTED: ${nameOrDelegate}`);
	return metadata;
}
export const getModelMeta = model;
export const table = (name: string | ModelMetadata): string => model(name).table;
export function quote(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("TENANT_SQL_IDENTIFIER_INVALID");
	return `\`${name}\``;
}
export const quoteIdent = quote;
export function field(name: string | ModelMetadata, fieldName: string): ScalarField {
	const result = model(name).fields[fieldName];
	if (!result) throw new Error(`TENANT_SQL_FIELD_UNSUPPORTED: ${fieldName}`);
	return result;
}

for (const item of active) {
	const metadata = model(item.name);
	for (const relation of item.fields.filter(f => f.kind === "object")) {
		if (!lookup.has(relation.type)) continue;
		const targetDefinition = active.find(candidate => candidate.name === relation.type)!;
		const inverse = targetDefinition.fields.find(f => f.kind === "object" && f.type === item.name && f.relationName === relation.relationName);
		if (!inverse) throw new Error(`TENANT_SQL_RELATION_INVERSE_MISSING: ${item.name}.${relation.name}`);
		const localFields = [...(relation.relationFromFields ?? [])];
		const targetFields = [...(relation.relationToFields ?? [])];
		let join: RelationMetadata["join"];
		if (!localFields.length && inverse.relationFromFields?.length) {
			localFields.push(...inverse.relationToFields!);
			targetFields.push(...inverse.relationFromFields);
		} else if (!localFields.length) {
			const names = [item.name, relation.type].sort();
			join = { table: `wpp_runtime__${relation.relationName!}`, localColumn: names[0] === item.name ? "A" : "B", targetColumn: names[0] === item.name ? "B" : "A" };
			localFields.push(...metadata.primaryKey);
			targetFields.push(...model(relation.type).primaryKey);
			if (localFields.length !== 1 || targetFields.length !== 1) throw new Error("TENANT_SQL_IMPLICIT_RELATION_KEY_UNSUPPORTED");
		}
		metadata.relations[relation.name] = {
			name: relation.name, target: relation.type, isList: relation.isList, isRequired: relation.isRequired,
			relationName: relation.relationName!, localFields, targetFields, fields: localFields, references: targetFields,
			inverse: inverse.name, isInverse: !(relation.relationFromFields?.length) && !join, ...(join ? { join } : {}),
		};
	}
}

export function scalarValue(metadata: ScalarField, value: unknown): unknown {
	if (value === undefined) return undefined;
	if (value === null || value === Prisma.DbNull) return null;
	if (metadata.type === "Json") return JSON.stringify(value === Prisma.JsonNull ? null : value);
	if (metadata.type === "Boolean") {
		if (typeof value !== "boolean" && value !== 0 && value !== 1) throw new Error("TENANT_SQL_BOOLEAN_INVALID");
		return value ? 1 : 0;
	}
	if (metadata.type === "DateTime") {
		const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
		if (!date || !Number.isFinite(date.getTime())) throw new Error("TENANT_SQL_DATE_INVALID");
		return date;
	}
	if (metadata.kind === "enum" || metadata.type === "String") {
		if (typeof value !== "string") throw new Error("TENANT_SQL_STRING_INVALID");
		if (metadata.kind === "enum" && !Prisma.dmmf.datamodel.enums.find(item => item.name === metadata.type)?.values.some(item => item.name === value)) throw new Error("TENANT_SQL_ENUM_INVALID");
		return value;
	}
	if (metadata.type === "Int") {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) throw new Error("TENANT_SQL_INTEGER_INVALID");
		return value;
	}
	if (metadata.type === "Float") {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("TENANT_SQL_NUMBER_INVALID");
		return value;
	}
	if (metadata.type === "BigInt") {
		if (typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new Error("TENANT_SQL_BIGINT_INVALID");
		return value.toString();
	}
	if (metadata.type === "Decimal") return new Prisma.Decimal(String(value)).toString();
	if (metadata.type === "Bytes") {
		if (!(value instanceof Uint8Array)) throw new Error("TENANT_SQL_BYTES_INVALID");
		return Buffer.from(value);
	}
	if (typeof value === "object" && !(value instanceof Uint8Array) && metadata.type !== "Decimal") throw new Error("TENANT_SQL_SCALAR_INVALID");
	return value;
}

export function scalarData(name: string | ModelMetadata, data: Record<string, unknown>): Record<string, unknown> {
	const metadata = model(name);
	const mapped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || metadata.relations[key]) continue;
		const scalar = field(metadata, key);
		mapped[scalar.column] = scalarValue(scalar, value);
	}
	return mapped;
}

export function hydrate(name: string | ModelMetadata, row: Record<string, unknown>): Record<string, unknown> {
	const hydrated: Record<string, unknown> = {};
	for (const scalar of model(name).scalars) {
		const key = Object.hasOwn(row, scalar.column) ? scalar.column : Object.hasOwn(row, scalar.name) ? scalar.name : undefined;
		if (key === undefined) continue;
		let value = row[key];
		if (value !== null && value !== undefined) {
			if (scalar.type === "Boolean") value = Boolean(Number(value));
			else if (scalar.type === "DateTime" && !(value instanceof Date)) {
				const text = String(value);
				value = new Date(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text);
				if (!Number.isFinite((value as Date).getTime())) throw new Error("TENANT_SQL_DATE_RESULT_INVALID");
			} else if (scalar.type === "Json" && (typeof value === "string" || Buffer.isBuffer(value))) value = JSON.parse(String(value));
			else if (scalar.type === "Int" || scalar.type === "Float") value = Number(value);
			else if (scalar.type === "BigInt" && typeof value !== "bigint") value = BigInt(String(value));
			else if (scalar.type === "Decimal" && !(value instanceof Prisma.Decimal)) value = new Prisma.Decimal(String(value));
		}
		hydrated[scalar.name] = value;
	}
	return hydrated;
}
