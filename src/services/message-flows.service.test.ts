import assert from "node:assert/strict";
import { StepRegistry } from "../message-flow/step-registry";
import { MessageFlowCache } from "../message-flow/message-flow-cache";

// Isolate repository behavior from all network/Prisma startup side effects.
const prismaPath = require.resolve("./prisma.service");
require.cache[prismaPath] = { exports: { __esModule: true, default: {} } } as NodeModule;
const { MessageFlowsService } = require("./message-flows.service") as typeof import("./message-flows.service");
const constructor = class {} as any;
for (const type of ["ASSIGN", "ROUTER", "CONDITION", "QUERY"]) StepRegistry.register(type, constructor);

async function main() {
	const flow: any = { id: 1, instance: "fixture-a", sectorId: 21, description: "original", WppMessageFlowStep: [] };
	let steps: any[] = [];
	let nextId = 10;
	let failWrite = false;
	const events: string[] = [];
	const all = () => ({ ...flow, WppMessageFlowStep: structuredClone(steps) });
	const db: any = {
		wppMessageFlow: {
			findUnique: async ({ where }: any) => where.instance_sectorId ? null : all(),
			update: async ({ data }: any) => { if (failWrite) throw new Error("write failed"); Object.assign(flow, data); events.push("commit"); return all(); },
			delete: async () => { events.push("commit"); return all(); },
			create: async ({ data }: any) => { events.push("commit"); return { ...data, id: 2 }; }
		},
		wppMessageFlowStep: {
			findFirst: async ({ where }: any) => steps.find((step) => step.stepNumber === where.stepNumber) ?? null,
			findUniqueOrThrow: async ({ where }: any) => { const row = steps.find((step) => step.id === where.id); if (!row) throw new Error("not found"); return structuredClone(row); },
			create: async ({ data }: any) => { const row = { id: nextId++, ...data }; steps.push(row); events.push("commit"); return structuredClone(row); },
			update: async ({ where, data }: any) => {
				const row = steps.find((step) => step.id === where.id);
				if (steps.some((step) => step.id !== row.id && step.stepNumber === data.stepNumber)) throw new Error("unique step number");
				Object.assign(row, data); events.push("commit"); return structuredClone(row);
			},
			delete: async ({ where }: any) => { steps = steps.filter((step) => step.id !== where.id); events.push("commit"); }
		},
		$transaction: async (run: (tx: any) => Promise<void>) => { await run(db); events.push("commit"); }
	};
	const cache = new MessageFlowCache<string>();
	let invalidated = 0;
	const service = new MessageFlowsService(db, (instance, sectorId) => { assert.equal(events.at(-1), "commit", "cache invalidates after mutation commits"); assert.equal(instance, "fixture-a"); assert.equal(sectorId, 21); invalidated++; cache.invalidate(instance, sectorId); });
	await cache.get(flow.instance, flow.sectorId, async () => "old");
	await service.updateFlow(1, { description: "edited" });
	assert.equal(await cache.get(flow.instance, flow.sectorId, async () => "edited"), "edited");
	failWrite = true;
	await assert.rejects(service.updateFlow(1, { description: "failure" }));
	assert.equal(invalidated, 1, "failed mutation does not invalidate");
	failWrite = false;
	const router = await service.createStep(1, { type: "ROUTER", stepNumber: 1, config: { field: "state" }, connections: { routes: { found: 2 }, defaultRoute: 3 } });
	assert.deepEqual(router.connections, { routes: { found: 2 }, defaultRoute: 3 }, "create preserves nested connections");
	const first = await service.createStep(1, { type: "ASSIGN", stepNumber: 2, config: { userId: 50 } });
	const second = await service.createStep(1, { type: "ASSIGN", stepNumber: 3, config: { userId: 60 } });
	await service.updateStep(first.id, { config: { userId: 70 } });
	assert.equal(steps.find((step) => step.id === first.id).config.userId, 70);
	const before = invalidated;
	await assert.rejects(service.reorderSteps(1, [{ stepId: 999, stepNumber: 1 }]), /foreign/);
	assert.equal(invalidated, before, "foreign step reorder performs no mutation");
	await service.reorderSteps(1, [{ stepId: first.id, stepNumber: 3 }, { stepId: second.id, stepNumber: 2 }]);
	assert.deepEqual(steps.find((step) => step.id === router.id).connections, { routes: { found: 3 }, defaultRoute: 2 }, "reorder preserves branch identity under unique number swaps");
	assert.equal((await service.validateFlow(1)).valid, true);
	let copyData: any;
	db.wppMessageFlow.create = async ({ data }: any) => { copyData = data; events.push("commit"); return { id: 2, instance: "fixture-a", sectorId: 21 }; };
	await service.duplicateFlow(1, "fixture-a", 21);
	assert.deepEqual(copyData.WppMessageFlowStep.create[0].connections, steps[0].connections, "duplicate retains routing graph");
	await service.deleteStep(second.id);
	assert.ok((await service.validateFlow(1)).errors.length, "dangling routes are reported");
	await service.createFlow({ instance: "fixture-a", sectorId: 21 });
	await service.deleteFlow(1);
	assert.equal(invalidated, 10, "all successful CRUD/reorder/duplicate paths invalidate");
	console.log("Message flow CRUD/cache tests passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
