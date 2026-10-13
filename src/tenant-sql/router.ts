import { Prisma } from "@prisma/client";
import type { Pool } from "mysql2/promise";
import { currentDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";
import { resolveDatabaseOperationTenant } from "../utils/database-operation-tenant";
import { createNativeTenantClient } from "./engine";
import { model, models } from "./metadata";
import { loadTenantPools } from "./registry";

type Client = Record<string, any>;
interface Operation { model: string; operation: string; args: any; }
const ROUTED_OPERATION = Symbol("tenant-sql-operation");
const reads = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"]);

class RoutedQuery implements PromiseLike<any> {
	private started: Promise<any> | undefined;
	private reserved = false;
	readonly [ROUTED_OPERATION]: Operation;
	constructor(operation: Operation, private readonly execute: () => Promise<any>) { this[ROUTED_OPERATION] = operation; }
	then<TResult1 = any, TResult2 = never>(onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
		if (this.reserved && !this.started) return Promise.reject(new Error("Operation is reserved for its transaction")).then(onfulfilled, onrejected);
		return (this.started ??= this.execute()).then(onfulfilled, onrejected);
	}
	get hasStarted(): boolean { return this.started !== undefined || this.reserved; }
	reserve(): void { if (this.hasStarted) throw new Error("Operation already started"); this.reserved = true; }
	settle(value: any, error?: unknown): void {
		this.started = error === undefined ? Promise.resolve(value) : Promise.reject(error);
		void this.started.catch(() => undefined);
	}
	catch(onrejected: (reason: any) => any): Promise<any> { return Promise.resolve(this).catch(onrejected); }
	finally(onfinally: () => void): Promise<any> { return Promise.resolve(this).finally(onfinally); }
}

function orders(orderBy: any): Array<[string, string]> {
	return (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((item: object) => Object.entries(item));
}
function page(rows: any[], args: any): any[] {
	const sorted = [...rows];
	const order = orders(args?.orderBy);
	if (order.length) sorted.sort((a, b) => {
		for (const [key, direction] of order) {
			const av = a[key], bv = b[key];
			const result = av == null ? (bv == null ? 0 : -1) : bv == null ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
			if (result) return direction === "desc" ? -result : result;
		}
		return 0;
	});
	return sorted.slice(args?.skip ?? 0, args?.take === undefined ? undefined : (args?.skip ?? 0) + args.take);
}

export function createTenantSqlRouter(pools: Map<string, Pool> = loadTenantPools(), injected?: Map<string, Client>): Client {
	const clients = injected ?? new Map([...pools].map(([tenant, pool]) => [tenant, createNativeTenantClient(tenant, pool) as Client]));
	const scoped = (op: Operation): string | null => {
		const context = currentDatabaseTenant();
		let tenant = op.model === "$raw" ? null : resolveDatabaseOperationTenant(model(op.model).name, op.operation, op.args).tenant;
		if (op.model === "$raw") {
			const candidates = [...new Set((op.args.slice(1) as unknown[]).filter((value): value is string => typeof value === "string" && clients.has(value)))];
			if (candidates.length === 1) tenant = candidates[0]!;
		}
		if (context && tenant && context !== tenant) throw new Error("TENANT_SQL_SCOPE_MISMATCH");
		tenant ??= context;
		if (tenant && !clients.has(tenant)) throw new Error("TENANT_SQL_NOT_PREPARED");
		return tenant;
	};
	const call = (client: Client, op: Operation): Promise<any> => Promise.resolve(op.model === "$raw"
		? client[op.operation](...op.args) : client[model(op.model).delegate][op.operation](op.args));
	const owner = async (op: Operation): Promise<string | null> => {
		const known = scoped(op);
		if (known) return known;
		if (op.model === "$raw") throw new Error("TENANT_SQL_TRANSACTION_REQUIRES_SCOPE");
		const owners: string[] = [];
		for (const [tenant, client] of clients) {
			const rows = await client[model(op.model).delegate].findMany({ where: op.args?.where, take: 1 });
			if (rows.length) owners.push(tenant);
		}
		if (owners.length > 1) throw new Error("TENANT_SQL_AMBIGUOUS_ID");
		return owners[0] ?? null;
	};
	const execute = async (op: Operation): Promise<any> => {
		const tenant = scoped(op);
		if (tenant) return call(clients.get(tenant)!, op);
		if (op.operation === "create" || op.operation === "createMany" || op.operation === "upsert")
			throw new Error("TENANT_SQL_WRITE_REQUIRES_SCOPE");
		if (!reads.has(op.operation) && op.model !== "$raw") {
			if (op.operation !== "updateMany" && op.operation !== "deleteMany") {
				const target = await owner(op);
				if (!target) throw new Prisma.PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion: "tenant-sql" });
				return call(clients.get(target)!, op);
			}
			const counts = await Promise.all([...clients.values()].map(client => call(client, op)));
			return { count: counts.reduce((sum, result) => sum + result.count, 0) };
		}
		const multi = op.model === "$raw" ? op : { ...op, operation: op.operation.replace(/OrThrow$/, ""), args: { ...op.args, skip: undefined,
			take: op.operation === "findMany" && op.args?.take !== undefined ? (op.args.skip ?? 0) + op.args.take : op.args?.take } };
		const results = await Promise.all([...clients.values()].map(client => call(client, multi)));
		if (op.model === "$raw") return op.operation.startsWith("$execute") ? results.reduce((sum, item) => sum + Number(item), 0) : results.flat();
		if (op.operation === "count") return results.reduce((sum, item) => sum + item, 0);
		if (op.operation === "findMany") return page(results.flat(), op.args);
		if (op.operation.startsWith("find")) {
			const found = results.filter(Boolean);
			if (op.operation.includes("Unique") && found.length > 1) throw new Error("TENANT_SQL_AMBIGUOUS_ID");
			const first = page(found, { ...op.args, take: 1 })[0];
			if (!first && op.operation.endsWith("OrThrow")) throw new Prisma.PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion: "tenant-sql" });
			return first ?? null;
		}
		if (op.args?._avg) throw new Error("TENANT_SQL_AVERAGE_REQUIRES_SCOPE");
		const by: string[] = op.operation === "groupBy" ? op.args.by : [];
		const groups = new Map<string, any>();
		for (const row of op.operation === "groupBy" ? results.flat() : results) {
			const key = JSON.stringify(by.map(field => row[field]));
			if (!groups.has(key)) { groups.set(key, structuredClone(row)); continue; }
			const result = groups.get(key);
			for (const aggregate of ["_count", "_sum", "_min", "_max"]) {
				if (typeof row[aggregate] === "number") { result[aggregate] += row[aggregate]; continue; }
				for (const [field, value] of Object.entries(row[aggregate] ?? {})) {
					if (value == null) continue;
					const previous = result[aggregate][field];
					result[aggregate][field] = previous == null ? value : aggregate === "_min" ? (value < previous ? value : previous)
						: aggregate === "_max" ? (value > previous ? value : previous) : Number(previous) + Number(value);
				}
			}
		}
		return op.operation === "groupBy" ? page([...groups.values()], op.args) : groups.values().next().value;
	};
	const query = (op: Operation) => new RoutedQuery(op, () => execute(op));
	const transaction = async (input: any, options?: any): Promise<any> => {
		let boundTenant = currentDatabaseTenant();
		if (boundTenant && !clients.has(boundTenant)) throw new Error("TENANT_SQL_NOT_PREPARED");
		if (Array.isArray(input)) {
			if (new Set(input).size !== input.length) throw new Error("A transaction cannot contain the same operation twice");
			const ops: Operation[] = input.map(item => {
				if (!(item instanceof RoutedQuery) || item.hasStarted) throw new Error("TENANT_SQL_TRANSACTION_REQUIRES_LAZY_OPERATIONS");
				return item[ROUTED_OPERATION];
			});
			for (const item of input as RoutedQuery[]) item.reserve();
			try {
			for (const op of ops) {
				const target = scoped(op) ?? await owner(op);
				if (target && boundTenant && target !== boundTenant) throw new Error("TENANT_SQL_CROSS_TENANT_TRANSACTION");
				boundTenant ??= target;
			}
			if (!boundTenant) throw new Error("TENANT_SQL_TRANSACTION_REQUIRES_SCOPE");
			const result = await clients.get(boundTenant)!["$transaction"](async (tx: Client) => {
				const results = [];
				for (const op of ops) results.push(await call(tx, op));
				return results;
			}, options);
			for (let index = 0; index < input.length; index++) input[index].settle(result[index]);
			return result;
			} catch (error) { for (const item of input as RoutedQuery[]) item.settle(undefined, error); throw error; }
		}
		if (typeof input !== "function") throw new Error("Invalid tenant SQL transaction");
		let nativeTx: Client | undefined;
		let acquiring: Promise<Client> | undefined;
		let commit: Promise<any> | undefined;
		let finish!: (value: any) => void;
		let fail!: (error: unknown) => void;
		let queued: Promise<any> = Promise.resolve();
		let closed = false;
		const finished = new Promise<any>((resolve, reject) => { finish = resolve; fail = reject; });
		// A rejection before the first query must not produce an unhandled promise.
		void finished.catch(() => undefined);
		const executeTxCall = async (op: Operation) => {
			if (closed) throw new Error("TENANT_TRANSACTION_CLOSED");
			const target = scoped(op);
			if (target && boundTenant && target !== boundTenant) throw new Error("TENANT_SQL_CROSS_TENANT_TRANSACTION");
			if (!nativeTx && acquiring) nativeTx = await acquiring;
			if (!nativeTx) {
				boundTenant ??= target ?? await owner(op);
				if (!boundTenant) {
					if (op.operation === "updateMany" || op.operation === "deleteMany") return { count: 0 };
					if (op.operation === "findUnique" || op.operation === "findFirst") return null;
					throw new Error("TENANT_SQL_TRANSACTION_REQUIRES_SCOPE");
				}
				let ready!: (tx: Client) => void;
				let readyFail!: (error: unknown) => void;
				const acquired = new Promise<Client>((resolve, reject) => { ready = resolve; readyFail = reject; });
				acquiring = acquired;
				commit = clients.get(boundTenant)!["$transaction"](async (tx: Client) => { ready(tx); return finished; }, options);
				void commit!.catch(readyFail);
				nativeTx = await acquired;
			}
			return call(nativeTx, op);
		};
		const txCall = (op: Operation) => {
			const result = queued.then(() => executeTxCall(op));
			queued = result.catch(() => undefined);
			return result;
		};
		const txProxy = new Proxy({}, { get: (_target, key: string) => key.startsWith("$")
			? (...args: any[]) => txCall({ model: "$raw", operation: key, args })
			: new Proxy({}, { get: (_inner, method: string) => (args: any) => txCall({ model: key, operation: method, args }) }) });
		try {
			const result = await input(txProxy);
			await queued;
			closed = true;
			finish(result);
			return commit ? await commit : result;
		} catch (error) {
			closed = true;
			fail(error);
			if (commit) await commit.catch(() => undefined);
			throw error;
		}
	};
	return new Proxy({}, { get: (_target, key: string) => {
		if (key === "$transaction") return transaction;
		if (key === "$disconnect") return async () => { await Promise.all([...pools.values()].map(pool => pool.end())); };
		if (key === "$connect") return async () => { await Promise.all([...pools.values()].map(pool => pool.query("SELECT 1"))); };
		if (key.startsWith("$")) return (...args: any[]) => query({ model: "$raw", operation: key, args });
		if (!models.some(item => item.delegate === key)) throw new Error(`TENANT_SQL_UNSUPPORTED_MODEL: ${key}`);
		return new Proxy({}, { get: (_inner, operation: string) => (args: any = {}) => query({ model: key, operation, args }) });
	} });
}

export async function withTenantSql<T>(tenant: string, execute: () => Promise<T>): Promise<T> {
	return withDatabaseTenant(tenant, execute);
}
