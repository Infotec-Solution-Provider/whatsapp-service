import { Prisma } from "@prisma/client";
import { currentDatabaseTenant, normalizeDatabaseTenant } from "./database-tenant-context";

export interface DatabaseOperationTenant {
	tenant: string | null;
	tenantSource: "query" | "context" | "unknown" | "ambiguous";
}

const tenantModels = new Map(Prisma.dmmf.datamodel.models
	.filter((model) => model.fields.some((field) => field.name === "instance" && field.kind === "scalar" && field.type === "String"))
	.map((model) => [model.name, model.uniqueIndexes
		.filter((index) => index.fields.includes("instance"))
		.map((index) => index.name ?? index.fields.join("_"))]));

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// undefined: no tenant constraint; null: cannot identify one tenant safely.
type Constraint = string | null | undefined;
function exact(value: unknown): Constraint {
	if (value === undefined) return undefined;
	if (typeof value === "string") return normalizeDatabaseTenant(value);
	const filter = record(value);
	if (filter?.["equals"] !== undefined) return normalizeDatabaseTenant(filter["equals"]);
	const values = filter?.["in"];
	return Array.isArray(values) && values.length === 1 ? normalizeDatabaseTenant(values[0]) : null;
}

/** Only inspect schema-approved tenant fields and Boolean filters, never JSON payloads or SQL. */
function whereTenant(value: unknown, compounds: string[], budget: { left: number }, depth = 0): Constraint {
	if (--budget.left < 0 || depth > 8) return null;
	const where = record(value);
	if (!where) return undefined;
	const constraints: Constraint[] = [exact(where["instance"])];
	for (const key of compounds) constraints.push(exact(record(where[key])?.["instance"]));
	for (const operator of ["AND", "OR"] as const) {
		const operand = where[operator];
		if (operand === undefined) continue;
		const children = Array.isArray(operand) ? operand : [operand];
		if (children.length > 64) return null;
		const tenants = children.map((child) => whereTenant(child, compounds, budget, depth + 1));
		if (operator === "AND") constraints.push(...tenants);
		else if (tenants.length && !tenants.every((tenant) => tenant === undefined)) {
			constraints.push(tenants.every((tenant) => typeof tenant === "string" && tenant === tenants[0]) ? tenants[0] : null);
		}
	}
	// A positive equality in an AND still scopes a broader OR/NOT condition.
	const known = constraints.filter((tenant): tenant is string => typeof tenant === "string");
	if (known.length) return known.every((tenant) => tenant === known[0]) ? known[0] : null;
	return constraints.includes(null) ? null : undefined;
}

export function resolveDatabaseOperationTenant(model: string | undefined, operation: string, args: unknown): DatabaseOperationTenant {
	const compounds = model ? tenantModels.get(model) : undefined;
	const input = record(args);
	let tenant: Constraint;
	if (compounds && input) {
		if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
			const data = input["data"];
			const rows = Array.isArray(data) ? data : [data];
			// Bound diagnostics independently of batch size. Never infer from just the first row.
			if (rows.length > 64) tenant = null;
			else {
				const tenants = rows.map((row) => exact(record(row)?.["instance"]));
				tenant = tenants.every((item) => item === tenants[0]) ? tenants[0] : null;
			}
		} else tenant = whereTenant(input["where"], compounds, { left: 64 });
	}
	if (tenant === null) return { tenant: null, tenantSource: "ambiguous" };
	if (tenant !== undefined) return { tenant, tenantSource: "query" };
	const context = currentDatabaseTenant();
	return { tenant: context, tenantSource: context ? "context" : "unknown" };
}
