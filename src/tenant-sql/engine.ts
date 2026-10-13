import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Pool, PoolConnection } from "mysql2/promise";
import { models, getModelMeta, hydrate, quoteIdent, scalarValue, type ModelMetadata, type RelationMetadata, type ScalarField } from "./metadata";
import { compileOrderBy, compileWhere, rewriteRawSql } from "./compiler";

type Data = Record<string, any>;
type Executor = { execute(options: { sql: string; values: any[]; timeout: number }): Promise<[any, any]> };
interface ConnectionState { active: boolean; destroyed: boolean }
const ACQUIRE_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 15000;
export const NATIVE_OPERATION = Symbol("tenant SQL operation");
export interface NativeOperationDescriptor {
	client: NativeTenantClient;
	model: string;
	operation: string;
	args: any;
}

/** A delegate call stays lazy so an array transaction cannot escape its connection. */
class NativeQuery<T = any> implements PromiseLike<T> {
	readonly [NATIVE_OPERATION]: NativeOperationDescriptor;
	private result: Promise<T> | undefined;
	private reserved = false;
	constructor(descriptor: NativeOperationDescriptor) { this[NATIVE_OPERATION] = descriptor; }
	get started(): boolean { return this.result !== undefined; }
	get isReserved(): boolean { return this.reserved; }
	reserve(): void { this.reserved = true; }
	execute(client?: NativeTenantClient): Promise<T> {
		if (!this.result) {
			if (this.reserved && !client) return Promise.reject(new Error("Operation is reserved for its transaction"));
			const d = this[NATIVE_OPERATION];
			this.result = (client ?? d.client).executeOperation(d.model, d.operation, d.args);
		}
		return this.result;
	}
	then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
		return this.execute().then(onfulfilled, onrejected);
	}
	catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> { return this.execute().catch(onrejected); }
	finally(onfinally?: (() => void) | null): Promise<T> { return this.execute().finally(onfinally); }
	get [Symbol.toStringTag](): string { return "PrismaPromise"; }
}

export function operationDescriptor(value: unknown): NativeOperationDescriptor | undefined {
	return value && typeof value === "object" ? (value as NativeQuery)[NATIVE_OPERATION] : undefined;
}

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function knownError(code: string, message: string, meta?: Data): Error {
	return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "native-tenant-sql", ...(meta ? { meta } : {}) });
}
function translateError(error: unknown): unknown {
	const e = error as Data | null;
	if (e?.["code"] === "ER_DUP_ENTRY" || e?.["errno"] === 1062) {
		const key = /for key ['`]([^'`]+)['`]/.exec(String(e["sqlMessage"] ?? e["message"]))?.[1];
		return knownError("P2002", "Unique constraint failed", key ? { target: key.split(".").pop() } : undefined);
	}
	if (e?.["code"] === "ER_NO_REFERENCED_ROW_2" || e?.["code"] === "ER_ROW_IS_REFERENCED_2") return knownError("P2003", "Foreign key constraint failed");
	if (e?.["code"] === "ER_LOCK_DEADLOCK" || e?.["code"] === "ER_LOCK_WAIT_TIMEOUT") return knownError("P2034", "Transaction failed due to a write conflict");
	return error;
}
function timedError(code: string): Error { return Object.assign(new Error(code), { code }); }
function commitUnknown(error: unknown): Error {
	return Object.assign(new Error("Tenant SQL commit outcome is unknown", { cause: error }), { code: "TENANT_COMMIT_UNKNOWN", outcome: "UNKNOWN" });
}
async function bounded<T>(promise: Promise<T>, timeoutMs: number, expired: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(expired()), timeoutMs); })]);
	} finally { if (timer) clearTimeout(timer); }
}

/** SQL transport only. Prisma is imported for compatible errors, never for a client or connection. */
export class NativeTenantClient {
	readonly tenant: string;
	readonly pool: Pool;
	private readonly connection: PoolConnection | undefined;
	private readonly connectionState: ConnectionState | undefined;
	constructor(tenant: string, pool: Pool, connection?: PoolConnection, state?: ConnectionState) {
		if (!tenant.trim()) throw new Error("A tenant is required for SQL access");
		this.tenant = tenant;
		this.pool = pool;
		this.connection = connection;
		this.connectionState = connection ? state ?? { active: true, destroyed: false } : undefined;
	}
	query(modelName: string, operation: string, args: any): NativeQuery { return new NativeQuery({ client: this, model: modelName, operation, args }); }
	$queryRawUnsafe(sql: string, ...values: any[]): NativeQuery { return this.query("$raw", "query", { sql, values }); }
	$executeRawUnsafe(sql: string, ...values: any[]): NativeQuery { return this.query("$raw", "execute", { sql, values }); }
	$queryRaw(sql: any, ...values: any[]): NativeQuery { return this.query("$raw", "query", this.rawArgs(sql, values)); }
	$executeRaw(sql: any, ...values: any[]): NativeQuery { return this.query("$raw", "execute", this.rawArgs(sql, values)); }
	private rawArgs(sql: any, values: any[]): Data {
		if (Array.isArray(sql) && "raw" in sql) return { sql: sql.join("?"), values };
		if (typeof sql?.sql === "string" && Array.isArray(sql.values)) return { sql: sql.sql, values: sql.values };
		throw new Error("Raw SQL requires a tagged template or SQL object");
	}
	async $disconnect(): Promise<void> { if (!this.connection) await this.pool.end(); }
	async $connect(): Promise<void> { const connection = await this.acquire(); connection.release(); }
	async $transaction<T>(input: ((tx: any) => Promise<T>) | PromiseLike<any>[], options?: Data): Promise<T | any[]> {
		if (this.connection) throw new Error("Nested transactions are not supported");
		if (Array.isArray(input)) {
			if (new Set(input).size !== input.length) throw new Error("A transaction cannot contain the same operation twice");
			for (const query of input) {
				const descriptor = operationDescriptor(query);
				if (!(query instanceof NativeQuery) || !descriptor) throw new Error("Array transactions require lazy tenant SQL operations");
				if (query.started) throw new Error("A previously awaited operation cannot enter a transaction");
				if (query.isReserved) throw new Error("Operation is reserved for its transaction");
				if (descriptor.client.tenant !== this.tenant || descriptor.client.pool !== this.pool) throw new Error("Cross-tenant transactions are not supported");
			}
		}
		const timeout = options?.["timeout"] ?? QUERY_TIMEOUT_MS;
		const maxWait = options?.["maxWait"] ?? ACQUIRE_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000 || !Number.isSafeInteger(maxWait) || maxWait < 1 || maxWait > ACQUIRE_TIMEOUT_MS) throw new Error("Invalid tenant SQL transaction timeout");
		if (Array.isArray(input)) for (const query of input as NativeQuery[]) query.reserve();
		const connection = await this.acquire(maxWait);
		const state: ConnectionState = { active: true, destroyed: false };
		let commitSent = false;
		const destroy = (): void => { state.active = false; state.destroyed = true; connection.destroy(); };
		try {
			const isolation = options?.["isolationLevel"];
			const levels: Data = { ReadUncommitted: "READ UNCOMMITTED", ReadCommitted: "READ COMMITTED", RepeatableRead: "REPEATABLE READ", Serializable: "SERIALIZABLE" };
			if (isolation && !levels[isolation]) throw new Error("Unsupported transaction isolation level");
			return await bounded((async () => {
				if (isolation) await connection.query(`SET TRANSACTION ISOLATION LEVEL ${levels[isolation]}`);
				await connection.beginTransaction();
				const tx = createNativeTenantClient(this.tenant, this.pool, connection, state);
				const result = Array.isArray(input) ? await this.executeTransactionArray(input as NativeQuery[], tx) : await input(tx);
				if (!state.active) throw timedError("TENANT_TRANSACTION_CLOSED");
				// Close the callback client before COMMIT so late operations cannot reach a released session.
				state.active = false;
				commitSent = true;
				await connection.commit();
				return result;
			})(), timeout, () => {
				destroy();
				return commitSent ? commitUnknown(timedError("TENANT_TRANSACTION_TIMEOUT")) : timedError("TENANT_TRANSACTION_TIMEOUT");
			});
		} catch (error) {
			state.active = false;
			if (commitSent) { if (!state.destroyed) destroy(); throw (error as Data)?.["code"] === "TENANT_COMMIT_UNKNOWN" ? error : commitUnknown(error); }
			if (!state.destroyed) {
				try { await bounded(connection.rollback(), ACQUIRE_TIMEOUT_MS, () => { destroy(); return timedError("TENANT_ROLLBACK_TIMEOUT"); }); }
				catch { if (!state.destroyed) destroy(); }
			}
			throw translateError(error);
		} finally { state.active = false; if (!state.destroyed) connection.release(); }
	}
	private async executeTransactionArray(input: NativeQuery[], tx: NativeTenantClient): Promise<any[]> {
		const results: any[] = [];
		for (const query of input) results.push(await query.execute(tx));
		return results;
	}
	private async atomic<T>(run: (tx: NativeTenantClient) => Promise<T>): Promise<T> {
		return this.connection ? run(this) : await this.$transaction(run) as T;
	}
	private scope(meta: ModelMetadata, where: Data | undefined): Data {
		if (!meta.instanceField) return where ?? {};
		const tenantScope = meta.name === "Parameter" ? { OR: [{ instance: this.tenant }, { instance: null }] } : { [meta.instanceField.name]: this.tenant };
		return { AND: [where ?? {}, tenantScope] };
	}
	private assertInstance(meta: ModelMetadata, data: Data): void {
		if (!meta.instanceField) return;
		const value = data[meta.instanceField.name];
		if (value !== undefined && (typeof value === "object" ? value?.set : value) !== this.tenant) throw new Error(`Tenant mismatch in ${meta.name}.${meta.instanceField.name}`);
	}
	private async acquire(timeout = ACQUIRE_TIMEOUT_MS): Promise<PoolConnection> {
		let expired = false;
		return bounded(this.pool.getConnection().then(connection => {
			if (expired) { connection.destroy(); throw timedError("TENANT_ACQUIRE_TIMEOUT"); }
			return connection;
		}), timeout, () => { expired = true; return timedError("TENANT_ACQUIRE_TIMEOUT"); });
	}
	private async sql(sql: string, params: any[] = []): Promise<any> {
		if (this.connectionState && !this.connectionState.active) throw timedError("TENANT_TRANSACTION_CLOSED");
		const connection = this.connection ?? await this.acquire();
		let destroyed = false;
		const destroy = (): void => {
			destroyed = true;
			if (this.connectionState) { this.connectionState.active = false; this.connectionState.destroyed = true; }
			connection.destroy();
		};
		try {
			return (await bounded((connection as unknown as Executor).execute({ sql, values: params, timeout: QUERY_TIMEOUT_MS }), QUERY_TIMEOUT_MS, () => { destroy(); return timedError("TENANT_QUERY_TIMEOUT"); }))[0];
		} catch (error) {
			if ((error as Data)?.["fatal"] || (error as Data)?.["code"] === "PROTOCOL_SEQUENCE_TIMEOUT") destroy();
			throw translateError(error);
		} finally { if (!this.connection && !destroyed) connection.release(); }
	}
	async executeOperation(modelName: string, operation: string, args: any = {}): Promise<any> {
		if (modelName === "$raw") {
			const result = await this.sql(rewriteRawSql(args.sql), args.values);
			return operation === "execute" ? Number(result.affectedRows ?? 0) : result;
		}
		const meta = getModelMeta(modelName);
		switch (operation) {
			case "findMany": return this.find(meta, args);
			case "findFirst": case "findUnique": return (await this.find(meta, { ...args, take: 1 }))[0] ?? null;
			case "findFirstOrThrow": case "findUniqueOrThrow": {
				const result = (await this.find(meta, { ...args, take: 1 }))[0];
				if (!result) throw knownError("P2025", `No ${meta.name} record was found`);
				return result;
			}
			case "count": return this.count(meta, args);
			case "aggregate": case "groupBy": return this.aggregate(meta, args, operation === "groupBy");
			case "create": return this.atomic(tx => tx.create(meta, args));
			case "createMany": return this.atomic(tx => tx.createMany(meta, args));
			case "update": return this.atomic(tx => tx.update(meta, args));
			case "updateMany": return this.updateMany(meta, args);
			case "delete": return this.atomic(tx => tx.delete(meta, args));
			case "deleteMany": return this.deleteMany(meta, args);
			case "upsert": return this.atomic(async tx => {
				const current = (await tx.find(meta, { where: args.where, take: 1 }, true))[0];
				return current ? tx.update(meta, { ...args, data: args.update }) : tx.create(meta, { ...args, data: args.create });
			});
			default: throw new Error(`Unsupported tenant SQL operation ${meta.name}.${operation}`);
		}
	}
	private projection(meta: ModelMetadata): string { return meta.scalars.map(f => `${quoteIdent(f.column)} AS ${quoteIdent(f.name)}`).join(", "); }
	private pagination(args: Data): string {
		const take = args["take"];
		const skip = args["skip"] ?? 0;
		if (!Number.isSafeInteger(skip) || skip < 0 || (take !== undefined && (!Number.isSafeInteger(take) || take < 0))) throw new Error("Pagination requires non-negative safe integers");
		return take !== undefined ? ` LIMIT ${take} OFFSET ${skip}` : skip ? ` LIMIT 18446744073709551615 OFFSET ${skip}` : "";
	}
	private async find(meta: ModelMetadata, args: Data, lock = false): Promise<Data[]> {
		if (args["cursor"]) throw new Error("Cursor pagination is not supported by tenant SQL");
		const where = compileWhere(meta, this.scope(meta, args["where"]));
		const order = compileOrderBy(meta, args["orderBy"]);
		const distinct = list<string>(args["distinct"]);
		// Native DISTINCT can apply pagination correctly when only the distinct fields are selected.
		const selected = args["select"] ? Object.keys(args["select"]).filter(k => args["select"][k] === true && meta.fields[k]) : [];
		const sqlDistinct = distinct.length > 0 && selected.length === distinct.length && distinct.every(k => selected.includes(k)) && !args["include"] && Object.keys(args["select"] ?? {}).every(k => meta.fields[k]);
		const columns = sqlDistinct ? distinct.map(k => `${quoteIdent(this.field(meta, k).column)} AS ${quoteIdent(k)}`).join(", ") : this.projection(meta);
		const rows: Data[] = await this.sql(`SELECT ${sqlDistinct ? "DISTINCT " : ""}${columns} FROM ${quoteIdent(meta.table)} WHERE ${where.sql}${order ? ` ORDER BY ${order}` : ""}${distinct.length && !sqlDistinct ? "" : this.pagination(args)}${lock ? " FOR UPDATE" : ""}`, where.params);
		let found = rows.map(row => hydrate(meta.name, row));
		if (distinct.length && !sqlDistinct) {
			const seen = new Set<string>();
			found = found.filter(row => { const key = JSON.stringify(distinct.map(k => row[k])); if (seen.has(key)) return false; seen.add(key); return true; });
			found = found.slice(args["skip"] ?? 0, args["take"] === undefined ? undefined : (args["skip"] ?? 0) + args["take"]);
		}
		// Includes can contain hundreds of parents; serialize them rather than saturating the bounded pool.
		const shaped: Data[] = [];
		for (const row of found) shaped.push(await this.shape(meta, row, args));
		return shaped;
	}
	private field(meta: ModelMetadata, name: string): ScalarField {
		const field = meta.fields[name];
		if (!field) throw new Error(`Unknown SQL scalar ${meta.name}.${name}`);
		return field;
	}
	private keyWhere(meta: ModelMetadata, row: Data): Data {
		const keys = meta.primaryKey.length ? meta.primaryKey : meta.uniques.find(keys => keys.every(k => row[k] !== undefined && row[k] !== null));
		if (!keys?.length) throw new Error(`No stable key for ${meta.name}`);
		return Object.fromEntries(keys.map(k => [k, row[k]]));
	}
	private relationWhere(relation: RelationMetadata, row: Data): Data | null {
		if (relation.localFields.some(key => row[key] === null || row[key] === undefined)) return null;
		return Object.fromEntries(relation.targetFields.map((key, index) => [key, row[relation.localFields[index]!]]));
	}
	private async related(relation: RelationMetadata, row: Data, args: Data): Promise<Data[]> {
		const target = getModelMeta(relation.target);
		if (relation.join) {
			const join = relation.join;
			const rows: Data[] = await this.sql(`SELECT ${quoteIdent(join.targetColumn)} AS id FROM ${quoteIdent(join.table)} WHERE ${quoteIdent(join.localColumn)} = ?`, [row[relation.localFields[0]!]]);
			return this.find(target, { ...args, where: { AND: [args["where"] ?? {}, { [relation.targetFields[0]!]: { in: rows.map(r => r["id"]) } }] } });
		}
		const where = this.relationWhere(relation, row);
		if (!where) return [];
		return this.find(target, { ...args, where: { AND: [args["where"] ?? {}, where] } });
	}
	private async relationCount(relation: RelationMetadata, row: Data, args: Data): Promise<number> {
		const target = getModelMeta(relation.target);
		if (relation.join) {
			const join = relation.join;
			const where = compileWhere(target, this.scope(target, args["where"]), "ct");
			const rows = await this.sql(`SELECT COUNT(*) AS total FROM ${quoteIdent(join.table)} AS j JOIN ${quoteIdent(target.table)} AS ct ON j.${quoteIdent(join.targetColumn)} = ct.${quoteIdent(this.field(target, relation.targetFields[0]!).column)} WHERE j.${quoteIdent(join.localColumn)} = ? AND ${where.sql}`, [row[relation.localFields[0]!], ...where.params]);
			return Number(rows[0]["total"]);
		}
		const where = this.relationWhere(relation, row);
		return where ? this.count(target, { where: { AND: [args["where"] ?? {}, where] } }) : 0;
	}
	private async shape(meta: ModelMetadata, row: Data, args: Data): Promise<Data> {
		const select = args["select"];
		const include = args["include"];
		if (select && include) throw new Error("Use select or include, not both");
		const result: Data = select ? {} : { ...row };
		const selection: Data = select ?? include ?? {};
		for (const [name, value] of Object.entries(selection)) {
			if (!value) continue;
			if (name === "_count") {
				const counts: Data = {};
				const requested = value === true ? Object.fromEntries(Object.keys(meta.relations).map(k => [k, true])) : (value as Data)["select"] ?? {};
				for (const [relationName, options] of Object.entries(requested)) {
					if (!options) continue;
					const relation = meta.relations[relationName];
					if (!relation) throw new Error(`Unknown relation ${meta.name}.${relationName}`);
					counts[relationName] = await this.relationCount(relation, row, options === true ? {} : options as Data);
				}
				result[name] = counts;
			} else if (meta.fields[name]) result[name] = row[name];
			else {
				const relation = meta.relations[name];
				if (!relation) throw new Error(`Unknown relation ${meta.name}.${name}`);
				const related = await this.related(relation, row, value === true ? {} : value as Data);
				result[name] = relation.isList ? related : related[0] ?? null;
			}
		}
		return result;
	}
	private aggregateColumns(meta: ModelMetadata, args: Data): { sql: string[]; specs: Array<{ aggregate: string; name: string; alias: string }> } {
		const sql: string[] = [];
		const specs: Array<{ aggregate: string; name: string; alias: string }> = [];
		for (const aggregate of ["_count", "_min", "_max", "_sum", "_avg"]) {
			const requested = args[aggregate];
			if (!requested) continue;
			for (const [name, enabled] of Object.entries(requested === true ? { _all: true } : requested)) {
				if (!enabled) continue;
				if (name === "_all" && aggregate !== "_count") throw new Error("_all is only supported for count");
				const alias = `a${specs.length}`;
				const column = name === "_all" ? "*" : quoteIdent(this.field(meta, name).column);
				sql.push(`${aggregate.slice(1).toUpperCase()}(${column}) AS ${quoteIdent(alias)}`);
				specs.push({ aggregate, name, alias });
			}
		}
		return { sql, specs };
	}
	private async count(meta: ModelMetadata, args: Data): Promise<any> {
		const result = await this.aggregate(meta, { ...args, _count: args["select"] ?? true }, false);
		return result["_count"];
	}
	private async aggregate(meta: ModelMetadata, args: Data, group: boolean): Promise<any> {
		const by = group ? list<string>(args["by"]) : [];
		if (group && !by.length) throw new Error("groupBy requires grouping fields");
		if (args["having"]) throw new Error("Aggregate having is not supported by tenant SQL");
		const aggregates = this.aggregateColumns(meta, args);
		const columns = [...by.map(k => `${quoteIdent(this.field(meta, k).column)} AS ${quoteIdent(k)}`), ...aggregates.sql];
		if (!columns.length) throw new Error("An aggregate selection is required");
		const where = compileWhere(meta, this.scope(meta, args["where"]));
		const order = compileOrderBy(meta, args["orderBy"]);
		const rows: Data[] = await this.sql(`SELECT ${columns.join(", ")} FROM ${quoteIdent(meta.table)} WHERE ${where.sql}${group ? ` GROUP BY ${by.map(k => quoteIdent(this.field(meta, k).column)).join(", ")}` : ""}${order ? ` ORDER BY ${order}` : ""}${this.pagination(args)}`, where.params);
		const results = rows.map(row => {
			const result: Data = Object.fromEntries(by.map(k => [k, hydrate(meta.name, { [k]: row[k] })[k]]));
			for (const spec of aggregates.specs) {
				const value = spec.aggregate === "_count" || spec.aggregate === "_avg" || spec.aggregate === "_sum" ? row[spec.alias] === null ? null : Number(row[spec.alias]) : hydrate(meta.name, { [spec.name]: row[spec.alias] })[spec.name];
				if (spec.aggregate === "_count" && args["_count"] === true) result["_count"] = value;
				else { result[spec.aggregate] ??= {}; result[spec.aggregate][spec.name] = value; }
			}
			return result;
		});
		return group ? results : results[0] ?? {};
	}
	private defaults(meta: ModelMetadata, data: Data): Data {
		this.assertInstance(meta, data);
		const result: Data = { ...data };
		if (meta.instanceField) result[meta.instanceField.name] = this.tenant;
		for (const f of meta.scalars) {
			if (result[f.name] !== undefined) continue;
			if (f.isUpdatedAt) result[f.name] = new Date();
			else if (f.hasDefaultValue) {
				const defaultValue = f.default as any;
				if (typeof defaultValue === "object" && defaultValue !== null && "name" in defaultValue) {
					if (defaultValue.name === "uuid") result[f.name] = randomUUID();
					else if (defaultValue.name === "cuid") result[f.name] = `c${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
					else if (defaultValue.name === "now") result[f.name] = new Date();
				} else result[f.name] = defaultValue;
			}
		}
		return result;
	}
	private async prepareDirectRelations(meta: ModelMetadata, data: Data, current?: Data): Promise<Data> {
		const result = { ...data };
		for (const [name, relation] of Object.entries(meta.relations)) {
			const nested = data[name];
			if (!nested || relation.isList || relation.join || relation.isInverse) continue;
			this.validateNested(nested, ["connect", "create", "connectOrCreate", "upsert", "disconnect", "update", "delete"]);
			const target = getModelMeta(relation.target);
			let related: Data | undefined;
			if (nested["connect"]) related = await this.required(target, nested["connect"]);
			if (nested["create"]) related = await this.create(target, { data: nested["create"] });
			if (nested["connectOrCreate"]) {
				const value = nested["connectOrCreate"];
				related = (await this.find(target, { where: value.where, take: 1 }, true))[0] ?? await this.create(target, { data: value.create });
			}
			if (nested.upsert) {
				const value = nested.upsert;
				const where = value.where ?? (current ? this.relationWhere(relation, current) : null);
				const found = where ? (await this.find(target, { where, take: 1 }, true))[0] : undefined;
				related = found ? await this.update(target, { where: this.keyWhere(target, found), data: value.update }) : await this.create(target, { data: value.create });
			}
			if (related) relation.localFields.forEach((key, i) => { result[key] = related![relation.targetFields[i]!]; });
			if (nested["disconnect"]) relation.localFields.forEach(key => { result[key] = null; });
			if (nested.update) {
				const where = current ? this.relationWhere(relation, current) : null;
				if (!where) throw knownError("P2025", `No related ${target.name} record was found`);
				await this.update(target, { where, data: nested.update.data ?? nested.update });
			}
			if (nested["delete"]) {
				const where = current ? this.relationWhere(relation, current) : null;
				if (!where) throw knownError("P2025", `No related ${target.name} record was found`);
				relation.localFields.forEach(key => { result[key] = null; });
				// Executed after unlinking to honor restrictive foreign keys.
			}
		}
		return result;
	}
	private async create(meta: ModelMetadata, args: Data): Promise<Data> {
		for (const key of Object.keys(args["data"] ?? {})) if (!meta.fields[key] && !meta.relations[key]) throw new Error(`Unknown SQL field ${meta.name}.${key}`);
		const data = this.defaults(meta, await this.prepareDirectRelations(meta, args["data"] ?? {}));
		await this.insert(meta, data);
		const created = await this.required(meta, this.keyWhere(meta, data));
		await this.mutateInverseRelations(meta, created, args["data"] ?? {});
		return this.shape(meta, created, args);
	}
	private async insert(meta: ModelMetadata, data: Data): Promise<void> {
		const fields = meta.scalars.filter(f => data[f.name] !== undefined);
		const result = await this.sql(fields.length ? `INSERT INTO ${quoteIdent(meta.table)} (${fields.map(f => quoteIdent(f.column)).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})` : `INSERT INTO ${quoteIdent(meta.table)} () VALUES ()`, fields.map(f => scalarValue(f, data[f.name])));
		for (const f of meta.scalars) if (f.isId && data[f.name] === undefined && result.insertId !== undefined) data[f.name] = f.type === "BigInt" ? BigInt(result.insertId) : result.insertId;
	}
	private async createMany(meta: ModelMetadata, args: Data): Promise<{ count: number }> {
		let count = 0;
		for (const data of list<Data>(args["data"])) {
			if (Object.keys(data).some(k => meta.relations[k])) throw new Error("createMany only accepts scalar fields");
			for (const key of Object.keys(data)) if (!meta.fields[key]) throw new Error(`Unknown SQL field ${meta.name}.${key}`);
			try { await this.insert(meta, this.defaults(meta, data)); count++; }
			catch (error) { if (!args["skipDuplicates"] || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error; }
		}
		return { count };
	}
	private async required(meta: ModelMetadata, where: Data, lock = false): Promise<Data> {
		const result = (await this.find(meta, { where, take: 1 }, lock))[0];
		if (!result) throw knownError("P2025", `No ${meta.name} record was found`);
		return result;
	}
	private updates(meta: ModelMetadata, data: Data): { sql: string[]; params: any[] } {
		this.assertInstance(meta, data);
		const sql: string[] = [], params: any[] = [];
		for (const f of meta.scalars) {
			let value = data[f.name];
			if (value === undefined && f.isUpdatedAt) value = new Date();
			if (value === undefined) continue;
			const column = quoteIdent(f.column);
			if (value !== null && typeof value === "object" && !(value instanceof Date) && f.type !== "Json" && !Buffer.isBuffer(value)) {
				const operations = Object.keys(value);
				if (operations.length !== 1) throw new Error(`Invalid scalar update ${meta.name}.${f.name}`);
				const operation = operations[0]!;
				if (operation === "set") { sql.push(`${column} = ?`); params.push(scalarValue(f, value.set)); }
				else {
					const operators: Data = { increment: "+", decrement: "-", multiply: "*", divide: "/" };
					if (!operators[operation]) throw new Error(`Unsupported scalar update ${operation}`);
					sql.push(`${column} = ${column} ${operators[operation]} ?`); params.push(scalarValue(f, value[operation]));
				}
			} else { sql.push(`${column} = ?`); params.push(scalarValue(f, value)); }
		}
		for (const key of Object.keys(data)) if (!meta.fields[key] && !meta.relations[key]) throw new Error(`Unknown SQL field ${meta.name}.${key}`);
		return { sql, params };
	}
	private async update(meta: ModelMetadata, args: Data): Promise<Data> {
		const current = await this.required(meta, args["where"], true);
		const data = await this.prepareDirectRelations(meta, args["data"] ?? {}, current);
		const update = this.updates(meta, data);
		const where = compileWhere(meta, this.scope(meta, { AND: [args["where"], this.keyWhere(meta, current)] }));
		if (update.sql.length) {
			const result = await this.sql(`UPDATE ${quoteIdent(meta.table)} SET ${update.sql.join(", ")} WHERE ${where.sql}`, [...update.params, ...where.params]);
			if (!result.affectedRows) throw knownError("P2025", `No ${meta.name} record was found`);
		}
		await this.mutateInverseRelations(meta, current, args["data"] ?? {});
		for (const [name, relation] of Object.entries(meta.relations)) {
			if (data[name]?.delete && !relation.isList && !relation.isInverse && !relation.join) {
				const relationWhere = this.relationWhere(relation, current);
				if (relationWhere) await this.delete(getModelMeta(relation.target), { where: relationWhere });
			}
		}
		const updatedKey = { ...this.keyWhere(meta, current) };
		for (const key of meta.primaryKey) if (data[key] !== undefined) updatedKey[key] = typeof data[key] === "object" ? data[key].set : data[key];
		return this.shape(meta, await this.required(meta, updatedKey), args);
	}
	private async updateMany(meta: ModelMetadata, args: Data): Promise<{ count: number }> {
		if (Object.keys(args["data"] ?? {}).some(k => meta.relations[k])) throw new Error("updateMany only accepts scalar fields");
		const update = this.updates(meta, args["data"] ?? {});
		if (!update.sql.length) return { count: 0 };
		const where = compileWhere(meta, this.scope(meta, args["where"]));
		const result = await this.sql(`UPDATE ${quoteIdent(meta.table)} SET ${update.sql.join(", ")} WHERE ${where.sql}`, [...update.params, ...where.params]);
		return { count: Number(result.affectedRows) };
	}
	private async delete(meta: ModelMetadata, args: Data): Promise<Data> {
		const current = await this.required(meta, args["where"], true);
		const shaped = await this.shape(meta, current, args);
		await this.deleteMany(meta, { where: { AND: [args["where"], this.keyWhere(meta, current)] } });
		return shaped;
	}
	private async deleteMany(meta: ModelMetadata, args: Data): Promise<{ count: number }> {
		const where = compileWhere(meta, this.scope(meta, args["where"]));
		const result = await this.sql(`DELETE FROM ${quoteIdent(meta.table)} WHERE ${where.sql}`, where.params);
		return { count: Number(result.affectedRows) };
	}
	private async mutateInverseRelations(meta: ModelMetadata, parent: Data, data: Data): Promise<void> {
		for (const [name, relation] of Object.entries(meta.relations)) {
			const nested = data[name];
			if (!nested || (!relation.isList && !relation.isInverse && !relation.join)) continue;
			const target = getModelMeta(relation.target);
			if (relation.join) { await this.mutateJoin(relation, parent, nested); continue; }
			this.validateNested(nested, ["deleteMany", "delete", "create", "createMany", "connect", "connectOrCreate", "disconnect", "update", "updateMany", "upsert", "set"]);
			const foreign = this.relationWhere(relation, parent);
			if (!foreign) throw new Error(`Missing key for nested relation ${meta.name}.${name}`);
			if (nested["deleteMany"] !== undefined) for (const where of list<Data>(nested["deleteMany"])) await this.deleteMany(target, { where: { AND: [foreign, where] } });
			for (const where of list<Data | boolean>(nested["delete"])) await this.delete(target, { where: { AND: [foreign, where === true ? {} : where] } });
			for (const create of list<Data>(nested["create"])) await this.create(target, { data: { ...create, ...foreign } });
			if (nested["createMany"]) await this.createMany(target, { ...nested["createMany"], data: list<Data>(nested["createMany"].data).map(item => ({ ...item, ...foreign })) });
			for (const connect of list<Data>(nested["connect"])) await this.update(target, { where: connect, data: foreign });
			for (const value of list<Data>(nested["connectOrCreate"])) {
				const found = (await this.find(target, { where: value["where"], take: 1 }, true))[0];
				if (found) await this.update(target, { where: this.keyWhere(target, found), data: foreign });
				else await this.create(target, { data: { ...value["create"], ...foreign } });
			}
			if (nested["disconnect"]) {
				const nulls = Object.fromEntries(relation.targetFields.map(k => [k, null]));
				for (const where of list<Data>(nested["disconnect"] === true ? {} : nested["disconnect"])) await this.updateMany(target, { where: { AND: [foreign, where] }, data: nulls });
			}
			for (const update of list<Data>(nested.update)) await this.update(target, { where: { AND: [foreign, update["where"] ?? {}] }, data: update["data"] ?? update });
			for (const update of list<Data>(nested.updateMany)) await this.updateMany(target, { where: { AND: [foreign, update["where"] ?? {}] }, data: update["data"] });
			for (const value of list<Data>(nested.upsert)) {
				const where = { AND: [foreign, value["where"] ?? {}] };
				const found = (await this.find(target, { where, take: 1 }, true))[0];
				if (found) await this.update(target, { where: this.keyWhere(target, found), data: value["update"] });
				else await this.create(target, { data: { ...value["create"], ...foreign } });
			}
			if (nested["set"] !== undefined) {
				await this.updateMany(target, { where: foreign, data: Object.fromEntries(relation.targetFields.map(k => [k, null])) });
				for (const connect of list<Data>(nested["set"])) await this.update(target, { where: connect, data: foreign });
			}
		}
	}
	private validateNested(nested: Data, operations: string[]): void {
		if (typeof nested !== "object" || Array.isArray(nested)) throw new Error("Invalid nested relation mutation");
		for (const key of Object.keys(nested)) if (!operations.includes(key)) throw new Error(`Unsupported nested relation operation ${key}`);
	}
	private async mutateJoin(relation: RelationMetadata, parent: Data, nested: Data): Promise<void> {
		this.validateNested(nested, ["set", "connect", "create", "connectOrCreate", "disconnect", "deleteMany", "delete", "upsert", "update", "updateMany"]);
		const join = relation.join!;
		const target = getModelMeta(relation.target);
		const localValue = parent[relation.localFields[0]!];
		const attach = async (related: Data): Promise<void> => {
			const targetValue = related[relation.targetFields[0]!];
			const existing = await this.sql(`SELECT 1 FROM ${quoteIdent(join.table)} WHERE ${quoteIdent(join.localColumn)} = ? AND ${quoteIdent(join.targetColumn)} = ?`, [localValue, targetValue]);
			if (!existing.length) await this.sql(`INSERT INTO ${quoteIdent(join.table)} (${quoteIdent(join.localColumn)}, ${quoteIdent(join.targetColumn)}) VALUES (?, ?)`, [localValue, targetValue]);
		};
		if (nested["set"] !== undefined) {
			await this.sql(`DELETE FROM ${quoteIdent(join.table)} WHERE ${quoteIdent(join.localColumn)} = ?`, [localValue]);
			for (const connect of list<Data>(nested["set"])) await attach(await this.required(target, connect));
		}
		for (const connect of list<Data>(nested["connect"])) await attach(await this.required(target, connect));
		for (const create of list<Data>(nested["create"])) await attach(await this.create(target, { data: create }));
		for (const value of list<Data>(nested["connectOrCreate"])) {
			const found = (await this.find(target, { where: value["where"], take: 1 }, true))[0] ?? await this.create(target, { data: value["create"] });
			await attach(found);
		}
		for (const value of list<Data>(nested["upsert"])) {
			const found = (await this.related(relation, parent, { where: value["where"] ?? {} }))[0];
			if (found) await this.update(target, { where: this.keyWhere(target, found), data: value["update"] });
			else await attach(await this.create(target, { data: value["create"] }));
		}
		for (const value of list<Data>(nested["update"])) {
			const found = (await this.related(relation, parent, { where: value["where"] ?? {} }))[0];
			if (!found) throw knownError("P2025", `No related ${target.name} record was found`);
			await this.update(target, { where: this.keyWhere(target, found), data: value["data"] ?? value });
		}
		for (const value of list<Data>(nested["updateMany"])) {
			for (const found of await this.related(relation, parent, { where: value["where"] ?? {} })) await this.updateMany(target, { where: this.keyWhere(target, found), data: value["data"] });
		}
		for (const disconnect of list<Data>(nested["disconnect"])) {
			const found = await this.required(target, disconnect);
			await this.sql(`DELETE FROM ${quoteIdent(join.table)} WHERE ${quoteIdent(join.localColumn)} = ? AND ${quoteIdent(join.targetColumn)} = ?`, [localValue, found[relation.targetFields[0]!]]);
		}
		if (nested["deleteMany"] !== undefined) {
			for (const where of list<Data>(nested["deleteMany"])) for (const found of await this.related(relation, parent, { where })) await this.delete(target, { where: this.keyWhere(target, found) });
		}
		for (const where of list<Data>(nested["delete"])) {
			const found = (await this.related(relation, parent, { where }))[0];
			if (!found) throw knownError("P2025", `No related ${target.name} record was found`);
			await this.delete(target, { where: this.keyWhere(target, found) });
		}
	}
}

const delegateOperations = new Set(["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count", "aggregate", "groupBy", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert"]);
export function createNativeTenantClient(tenant: string, pool: Pool, connection?: PoolConnection, state?: ConnectionState): NativeTenantClient & Data {
	const client = new NativeTenantClient(tenant, pool, connection, state);
	const delegates = new Map(models.map(meta => [meta.delegate, meta]));
	const cache = new Map<string, any>();
	return new Proxy(client as NativeTenantClient & Data, {
		get(target, property, receiver) {
			if (typeof property === "string" && delegates.has(property)) {
				if (!cache.has(property)) cache.set(property, new Proxy({}, { get(_target, operation) {
					if (typeof operation !== "string" || !delegateOperations.has(operation)) return undefined;
					return (args: any = {}) => client.query(delegates.get(property)!.name, operation, args);
				} }));
				return cache.get(property);
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
}


