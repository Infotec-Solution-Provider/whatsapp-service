import assert from "node:assert/strict";
import { buildOdimInboundFlow } from "./odim-inbound";
import { StepRegistry } from "../step-registry";
import { BaseStep, StepContext, StepResult } from "../base/base.step";

async function main() {
	const targets = { instance: "fixture", sectorId: 110, clientId: 120, assigneeId: 1510, fallbackUserId: 1009 };
	const configuration = buildOdimInboundFlow(targets);
	let status = "not_found";
	let resolverCalls = 0;
	let primaryActive = "SIM";
	let fallbackActive = "SIM";
	let crmUnavailable = false;
	const logs: Array<{ message: string; data?: any }> = [];
	const db = { wppMessageFlow: { findUnique: async ({ where }: any) => where.instance_sectorId.instance === targets.instance ? { WppMessageFlowStep: configuration.steps } : null },
		wppChat: { groupBy: async () => [{ userId: 1529, _count: { id: 0 } }] } };
	require.cache[require.resolve("../../services/prisma.service")] = { exports: { __esModule: true, default: db } } as NodeModule;
	require.cache[require.resolve("../../services/instances.service")] = { exports: { __esModule: true, default: {
		executeQuery: async (_instance: string, sql: string) => {
			if (crmUnavailable) throw new Error("CRM unavailable");
			if (sql.includes("WHERE CODIGO IN")) return [{ CODIGO: targets.assigneeId, SETOR: targets.sectorId, ATIVO: primaryActive, NIVEL: "AMBOS" }, { CODIGO: targets.fallbackUserId, SETOR: targets.sectorId, ATIVO: fallbackActive, NIVEL: "ADMIN" }];
			if (sql.includes("campanhas_clientes")) return [{ OPERADOR: 1534 }];
			if (sql.includes("operadores")) return [{ CODIGO: 1534, SETOR: targets.sectorId }];
			throw new Error("Unexpected SQL");
		}
	} } } as NodeModule;
	require.cache[require.resolve("../../services/auth.service")] = { exports: { __esModule: true, default: {
		getOnlineSessions: async () => [{ data: { userId: 1529, sectorId: targets.sectorId } }]
	} } } as NodeModule;
	const { registerAllSteps } = require("../register-steps") as typeof import("../register-steps");
	registerAllSteps();
	const metadata = StepRegistry.getMetadata("QUERY")!;
	assert.doesNotThrow(() => StepRegistry.create("QUERY", { instance: "fixture", sectorId: 110, stepNumber: 2, config: { operation: "resolveContactCustomer", storeAs: "resolution" } }));
	assert.doesNotThrow(() => StepRegistry.create("QUERY", { instance: "fixture", sectorId: 110, stepNumber: 2, config: { query: "SELECT 1", storeAs: "result" } }));
	assert.throws(() => StepRegistry.create("QUERY", { instance: "fixture", sectorId: 110, stepNumber: 2, config: { operation: "unknown", storeAs: "result" } }));
	assert.throws(() => StepRegistry.create("QUERY", { instance: "fixture", sectorId: 110, stepNumber: 2, config: { operation: "resolveContactCustomer", storeAs: "contact" } }));
	assert.throws(() => StepRegistry.create("QUERY", { instance: "fixture", sectorId: 110, stepNumber: 2, config: { operation: "resolveContactCustomer", storeAs: "contact.customerId" } }));
	assert.throws(() => StepRegistry.create("ASSIGN", { instance: "fixture", sectorId: 110, stepNumber: 2, config: { userId: 1, validateUser: true, fallbackUserId: -1 } }));
	class ResolverFixtureStep extends BaseStep {
		async execute(context: StepContext): Promise<StepResult> {
			resolverCalls++;
			if (status === "throw") throw new Error("Resolver failed");
			context["customerResolution"] = { status };
			context.contact = { ...context.contact, customerId: status === "found" ? 202 : null };
			return this.continue(context);
		}
	}
	// The CRM implementation has its own SQL/CAS tests. Exercise the real router, target guard and business steps here.
	StepRegistry.register("QUERY", ResolverFixtureStep, metadata);
	const Factory = (require("../message-flow.factory") as typeof import("../message-flow.factory")).default;
	const execute = async (adminOnly = false, instance = targets.instance) => {
		logs.length = 0;
		const flow = await Factory.createMessageFlow(instance, targets.sectorId);
		return flow.getChatPayload({ log(message: string, data?: any) { logs.push({ message, data }); }, failed() {} } as any,
			{ id: 201, instance, customerId: null, isOnlyAdmin: adminOnly } as any, { id: 202 } as any);
	};
	for (const state of ["not_found", "ambiguous", "unavailable", "unexpected", "throw"]) {
		status = state;
		assert.equal((await execute()).userId, targets.assigneeId, "unidentified routes obey configuration even with a lower-load online operator");
		assert.ok(logs.some((item) => item.data?.reason === (state === "not_found" ? "customer_not_found" : state === "ambiguous" ? "customer_lookup_ambiguous" : "customer_lookup_unavailable")));
	}
	const callsBeforeAdmin = resolverCalls;
	assert.equal((await execute(true)).userId, -1);
	assert.equal(resolverCalls, callsBeforeAdmin, "admin-only precedence avoids the resolver");
	status = "found";
	assert.equal((await execute()).userId, 1534, "identified route preserves loyalty without requiring online presence");
	status = "not_found";
	primaryActive = "NAO";
	assert.equal((await execute()).userId, targets.fallbackUserId);
	fallbackActive = "NAO";
	await assert.rejects(execute(), /Configured assignment target/);
	crmUnavailable = true;
	assert.equal((await execute()).userId, targets.assigneeId, "CRM outage keeps the preflight-approved destination");
	assert.ok(logs.some((item) => item.data?.reason === "validation_unavailable"));
	crmUnavailable = false;
	assert.equal((await execute(false, "other-tenant")).userId, 1529, "other tenants retain generic availability distribution");
	console.log("Odim configured flow execution tests passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
