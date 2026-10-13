import assert from "node:assert/strict";
import { currentDatabaseTenant } from "../utils/database-tenant-context";

async function main(): Promise<void> {
	const stub = (path: string, exports: unknown): void => {
		const id = require.resolve(path);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	const calls: Array<{ clientId: number; stage: string; tenant: string | null }> = [];
	const tenants = new Map([[7, "homolog"], [9, "suprimaxxi"]]);
	class RuntimeClient {
		constructor(readonly id: number) {}
		async handleMessageStatus(_messageId: string, _status: string): Promise<void> {
			await new Promise<void>(resolve => setImmediate(resolve));
			calls.push({ clientId: this.id, stage: "process", tenant: currentDatabaseTenant() });
		}
	}
	const clients = new Map([...tenants.keys()].map(id => [id, new RuntimeClient(id)]));
	stub("@in.pulse-crm/utils", { Logger: { info() {}, error() {} } });
	stub("../tenant-sql/registry", { tenantSqlEnabled: () => true });
	stub("../whatsapp-client/remote-whatsapp-client", { __esModule: true, default: RuntimeClient });
	stub("./whatsapp.service", { __esModule: true, default: { getClient: (id: number) => clients.get(id) } });
	stub("./remote-session-monitor.service", { __esModule: true, default: {} });
	stub("./message-reactions.service", { __esModule: true, default: {} });
	stub("./prisma.service", { __esModule: true, default: { wppClient: {
		findFirst: async ({ where }: { where: { id: number } }) => tenants.has(where.id) ? { instance: tenants.get(where.id) } : null
	} } });
	stub("./remote-inbound-event-inbox.service", { __esModule: true, default: {
		enqueueStatus: async (clientId: number) => {
			calls.push({ clientId, stage: "admit", tenant: currentDatabaseTenant() });
			return { created: true, status: "PENDING", id: `receipt-${clientId}`, idempotencyKey: `key-${clientId}` };
		}
	} });
	const service = (require("./remote-client.service") as typeof import("./remote-client.service")).default;
	const receipt = { type: "message-status-received" as const, messageId: "same-provider-stanza", status: "READ" as const };
	const accepted = await Promise.all([...tenants.keys()].map(clientId => service.handleEventReceived(clientId, { ...receipt, clientId, timestamp: 1 })));
	assert(accepted.every(result => result?.status === "PENDING"));
	await Promise.all([...tenants.keys()].map(clientId => service.processInboundInboxItem(
		{ id: `inbox-${clientId}`, clientId } as any, { ...receipt, clientId }
	)));
	assert.deepEqual(calls, [
		{ clientId: 7, stage: "admit", tenant: "homolog" },
		{ clientId: 9, stage: "admit", tenant: "suprimaxxi" },
		{ clientId: 7, stage: "process", tenant: "homolog" },
		{ clientId: 9, stage: "process", tenant: "suprimaxxi" }
	]);
	await assert.rejects(service.processInboundInboxItem({ id: "bad", clientId: 7 } as any, { ...receipt, clientId: 9 }), /Inbox client mismatch/);
	await assert.rejects(service.handleEventReceived(11, { ...receipt, clientId: 11, timestamp: 1 }), /Remote client not found/);
	assert.equal(calls.length, 4);
	assert.equal(currentDatabaseTenant(), null);
	console.log("Durable REMOTE receipt admission and asynchronous processing retain each tenant; mismatched and missing clients are rejected");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
