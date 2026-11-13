import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import { MessageFlowCache } from "../message-flow/message-flow-cache";
import type MessageFlow from "../message-flow/message-flow";

/** Explicitly confined to the disposable server agreed for this task. No environment files are loaded. */
async function main() {
	const host = "127.0.0.1";
	const port = 13418;
	const schema = `odim_flow_engine_qa_20261113_${Date.now()}`;
	const verifyDestination = () => {
		if (host !== "127.0.0.1" || port !== 13418 || !/^odim_flow_engine_qa_20261113_[0-9]+$/.test(schema)) throw new Error("Refusing non-QA MySQL destination");
	};
	verifyDestination();
	const admin = await mysql.createConnection({ host, port, user: "root", password: "" });
	let prisma: PrismaClient | undefined;
	try {
		await admin.query(`CREATE DATABASE \`${schema}\``);
		await admin.query(`CREATE TABLE \`${schema}\`.message_flows (
			id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, instance VARCHAR(191) NOT NULL, sector_id INT NOT NULL,
			description VARCHAR(191) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY tenant_sector(instance,sector_id))`);
		await admin.query(`CREATE TABLE \`${schema}\`.message_flows_steps (
			id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, type VARCHAR(80) NOT NULL, message_flow_id INT NOT NULL, step_number INT NOT NULL,
			config JSON NULL, connections JSON NULL, next_step_id INT NULL, fallback_step_id INT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
			description VARCHAR(191) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			UNIQUE KEY flow_number(message_flow_id,step_number), FOREIGN KEY(message_flow_id) REFERENCES \`${schema}\`.message_flows(id) ON DELETE CASCADE)`);
		prisma = new PrismaClient({ datasources: { db: { url: `mysql://root@${host}:${port}/${schema}` } } });
		// Select the isolated client before importing modules with a singleton dependency.
		require.cache[require.resolve("./prisma.service")] = { exports: { __esModule: true, default: prisma } } as NodeModule;
		require.cache[require.resolve("./instances.service")] = { exports: { __esModule: true, default: { executeQuery: async () => { throw new Error("Unexpected CRM access in flow CRUD test"); } } } } as NodeModule;
		const { registerAllSteps } = require("../message-flow/register-steps") as typeof import("../message-flow/register-steps");
		registerAllSteps();
		const { MessageFlowsService } = require("./message-flows.service") as typeof import("./message-flows.service");
		const Factory = (require("../message-flow/message-flow.factory") as typeof import("../message-flow/message-flow.factory")).default;
		const cache = new MessageFlowCache<MessageFlow>();
		const service = new MessageFlowsService(prisma as any, (instance, sector) => cache.invalidate(instance, sector));
		const one = await service.createFlow({ instance: "fixture-a", sectorId: 900 });
		const condition = await service.createStep(one.id, { type: "CONDITION", stepNumber: 1,
			config: { field: "contact.customerId", operator: "gt", value: 0 }, connections: { onTrue: 2, onFalse: 3 } });
		const known = await service.createStep(one.id, { type: "ASSIGN", stepNumber: 2, config: { userId: 501 } });
		const unknown = await service.createStep(one.id, { type: "ASSIGN", stepNumber: 3, config: { userId: 510 } });
		const logger = { log() {}, failed() {} } as any;
		const execute = async (instance = "fixture-a", customerId: number | null = null) => {
			const flow = await cache.get(instance, 900, () => Factory.createMessageFlow(instance, 900));
			return flow.getChatPayload(logger, { id: 801, instance, customerId } as any, { id: 802 } as any);
		};
		assert.equal((await execute()).userId, 510);
		assert.equal((await execute("fixture-a", 42)).userId, 501);
		await service.updateStep(unknown.id, { config: { userId: 511 } });
		assert.equal((await execute()).userId, 511, "next creation observes an edited cached flow");
		const copyId = await service.duplicateFlow(one.id, "fixture-b", 900);
		assert.equal((await execute("fixture-b")).userId, 511, "duplicate includes conditional connections");
		await service.reorderSteps(one.id, [{ stepId: known.id, stepNumber: 3 }, { stepId: unknown.id, stepNumber: 2 }]);
		assert.equal((await execute()).userId, 511, "swap under real unique index preserves destinations");
		const afterSwap = await service.getFlow(one.id);
		assert.deepEqual(afterSwap.WppMessageFlowStep.find((step) => step.id === condition.id)!.connections, { onTrue: 3, onFalse: 2 });
		await assert.rejects(service.reorderSteps(one.id, [{ stepId: (await service.getFlow(copyId)).WppMessageFlowStep[0]!.id, stepNumber: 10 }]), /foreign/);
		await service.updateStep(unknown.id, { enabled: false });
		await assert.rejects(execute(), /invalid onFalse/);
		await service.updateStep(unknown.id, { enabled: true });
		assert.equal((await execute()).userId, 511);
		await service.deleteFlow(one.id);
		assert.equal((await service.getFlow(copyId)).WppMessageFlowStep.length, 3, "delete is tenant scoped");
		console.log("Message flow MySQL CRUD, routing, reorder and cache tests passed");
	} finally {
		if (prisma) await prisma.$disconnect();
		verifyDestination();
		await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
		await admin.end();
	}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
