import assert from "node:assert/strict";
import type { WppContact, WppMessage } from "@prisma/client";
import { QueryStep } from "./query.step";
import type { StepContext } from "./base.step";

async function main() {
	const logs: unknown[] = [];
	const contact = { id: 8, instance: "qa-tenant", customerId: null, phone: "5511987654321", name: "private-name" } as WppContact;
	let calls = 0;
	const resolver = async (scope: { instance: string; sectorId: number }, supplied: WppContact) => {
		calls++;
		assert.deepEqual(scope, { instance: "qa-tenant", sectorId: 17 });
		return { contact: { ...supplied, customerId: 42 }, resolution: { status: "found" as const, customerId: 42, reason: "linked" as const } };
	};
	const step = (config: Record<string, unknown>) => new QueryStep({ instance: "qa-tenant", sectorId: 17, stepNumber: 1, nextStepNumber: 2, config }, resolver);
	const context = (): StepContext => ({ contact, message: { instance: "qa-tenant" } as WppMessage, logger: { log: (...args: unknown[]) => { logs.push(args); } } as any });
	const normal = context();
	const result = await step({ operation: "resolveContactCustomer", storeAs: "customerResolution" }).execute(normal);
	assert.equal(result.nextStepNumber, 2);
	assert.equal(result.context.contact.customerId, 42);
	assert.deepEqual(result.context["customerResolution"], { status: "found", customerId: 42, reason: "linked" });
	assert.ok(!JSON.stringify(logs).includes("5511987654321"));
	assert.ok(!JSON.stringify(logs).includes("private-name"));
	for (const storeAs of ["__proto__", "prototype", "constructor", "contact", "message", "customer", "logger", "instance", "sectorId", "contact.customerId", "", "legacySchedule"]) {
		await assert.rejects(() => step({ operation: "resolveContactCustomer", storeAs }).execute(context()), /INVALID_CUSTOMER_RESOLUTION_STORE_AS/);
	}
	const occupied = context(); occupied["customerResolution"] = { userChoice: true };
	await assert.rejects(() => step({ operation: "resolveContactCustomer", storeAs: "customerResolution" }).execute(occupied), /INVALID_CUSTOMER_RESOLUTION_STORE_AS/);
	const wrongTenant = context(); wrongTenant.message = { instance: "other" } as WppMessage;
	await assert.rejects(() => step({ operation: "resolveContactCustomer", storeAs: "customerResolution" }).execute(wrongTenant), /SCOPE_MISMATCH/);
	const wrongSector = context(); wrongSector.sectorId = 18;
	await assert.rejects(() => step({ operation: "resolveContactCustomer", storeAs: "customerResolution" }).execute(wrongSector), /SCOPE_MISMATCH/);
	await assert.rejects(() => step({ operation: "unsupported", storeAs: "customerResolution" }).execute(context()), /UNKNOWN_QUERY_OPERATION/);
	assert.equal(calls, 1, "invalid scope/configuration must not read CRM or change a link");
	console.log("QUERY customer resolution: dispatch, reserved context guards, isolation and private logs passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
