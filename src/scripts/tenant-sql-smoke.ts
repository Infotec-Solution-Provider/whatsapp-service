import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, type Connection } from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { loadTenantPools, validateRegistry } from "../tenant-sql/registry";
import { buildNativeMigrationMetadata, quoteMigrationIdentifier } from "../tenant-sql/migration";
import { withDatabaseTenant } from "../utils/database-tenant-context";

const REGISTRY_PATH = "/home/inpulse/htdocs/homolog/whatsapp/tenant-sql-registry.json";
const marker = `FICTICIO_SQL_SMOKE_${randomUUID()}`;
const ROLLBACK = new Error("SMOKE_EXPECTED_ROLLBACK");
const userId = 2_147_483_000;
let stage = "registry";
type Client = Record<string, any>;
type Counts = Record<string, number>;

async function centralCounts(connection: Connection): Promise<Counts> {
	const counts: Counts = {};
	for (const table of buildNativeMigrationMetadata()) {
		const [rows] = await connection.query<any[]>(`SELECT COUNT(*) AS total FROM \`homolog-whatsapp\`.${quoteMigrationIdentifier(table.source)}`);
		counts[table.source] = Number(rows[0].total);
	}
	return counts;
}
async function runtimeCounts(router: Client, tenant: string): Promise<Counts> {
	return withDatabaseTenant(tenant, async () => ({
		contacts: await router["wppContact"].count(), chats: await router["wppChat"].count(),
		messages: await router["wppMessage"].count(), internalMessages: await router["internalMessage"].count(),
		operatorOutbound: await router["operatorOutboundSend"].count(), reactions: await router["messageReaction"].count(),
		inbox: await router["remoteInboundEventInbox"].count(), clients: await router["wppClient"].count(),
		sectors: await router["wppSector"].count(), tags: await router["wppTag"].count()
	}));
}

async function transactionalSmoke(router: Client, tenant: string, offset: number): Promise<string[]> {
	const checks: string[] = [];
	const otherTenant = tenant === "homolog" ? "suprimaxxi" : "homolog";
	const before = await runtimeCounts(router, tenant);
	await withDatabaseTenant(tenant, async () => {
		stage = "scope";
		await assert.rejects(async () => await router["wppContact"].findMany({ where: { instance: otherTenant }, take: 1 }), /SCOPE_MISMATCH/);
		checks.push("wrong tenant scope rejected");
		try {
			await router["$transaction"](async (tx: Client) => {
				stage = "client-and-implicit-sector-join";
				const client = await tx["wppClient"].create({ data: { instance: tenant, name: `${marker}_${tenant}_client`, phone: null, type: "REMOTE", isActive: false } });
				assert.equal(client.id % 2, offset % 2, "New IDs must occupy the tenant allocation slot");
				const sector = await tx["wppSector"].create({
					data: { instance: tenant, name: `${marker}_${tenant}_sector`, startChats: false, receiveChats: false, clients: { connect: { id: client.id } }, defaultClient: { connect: { id: client.id } } },
					include: { clients: true, defaultClient: true }
				});
				assert.equal(sector.clients.length, 1);
				assert.equal(sector.clients[0].id, client.id);
				assert.equal(sector.defaultClient.id, client.id);
				checks.push("implicit sector client join and direct connect");
				stage = "nested-contact-chat-message";
				const contact = await tx["wppContact"].create({
					data: {
						instance: tenant, name: `${marker}_${tenant}_contact`, phone: null, whatsappId: `${marker}_${tenant}@ficticio.invalid`,
						WppChat: { create: { instance: tenant, type: "ACTIVE", sector: { connect: { id: sector.id } },
							wppTags: { create: { instance: tenant, name: `${marker}_${tenant}_tag`, color: "#000000" } },
							messages: { create: {
								instance: tenant, from: "FICTICIO", to: "FICTICIO", type: "chat", body: marker,
								timestamp: String(Date.now()), sentAt: new Date(), status: "UNKNOWN", client: { connect: { id: client.id } },
								mentionMetadata: { version: 1, users: [userId], smoke: true }
							} }
						} }
					}, include: { WppChat: { include: { messages: true, sector: { include: { clients: true } }, wppTags: true } } }
				});
				const chat = contact.WppChat[0];
				const message = chat.messages[0];
				assert.equal(chat.contactId, contact.id);
				assert.equal(message.chatId, chat.id);
				assert.equal(message.status, "UNKNOWN");
				assert.equal(message.mentionMetadata.smoke, true);
				assert.equal(chat.wppTags.length, 1);
				assert.equal(chat.sector.clients[0].id, client.id);
				checks.push("nested contact chat message writes and recursive includes");
				const related = await tx["wppContact"].findMany({ where: { id: contact.id, WppChat: { some: { messages: { some: { status: "UNKNOWN" } } } } } });
				assert.equal(related.length, 1);
				checks.push("nested relation filters");
				stage = "operator-idempotency";
				const outboundData = {
					instance: tenant, userId, clientId: client.id, idempotencyKey: `${marker}_${tenant}_operator`,
					payloadHash: "0".repeat(64), payload: { smoke: true }, messageId: message.id, deliveryMode: "REMOTE", status: "UNKNOWN"
				};
				const outbound = await tx["operatorOutboundSend"].create({ data: outboundData, include: { message: true } });
				assert.equal(outbound.message.id, message.id);
				await assert.rejects(async () => await tx["operatorOutboundSend"].create({ data: outboundData }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002");
				const reused = await tx["operatorOutboundSend"].upsert({
					where: { instance_userId_idempotencyKey: { instance: tenant, userId, idempotencyKey: outboundData.idempotencyKey } },
					create: outboundData, update: {}
				});
				assert.equal(reused.id, outbound.id);
				assert.equal(reused.status, "UNKNOWN");
				assert.equal(await tx["operatorOutboundSend"].count({ where: { idempotencyKey: outboundData.idempotencyKey } }), 1);
				checks.push("outbound idempotency tombstone and UNKNOWN retained");
				stage = "edit-and-reaction";
				const edited = await tx["wppMessage"].update({ where: { id: message.id }, data: { body: `${marker}_EDITED`, isEdited: true, mentionMetadata: { smoke: true, edited: true } } });
				assert.equal(edited.isEdited, true);
				assert.equal(edited.mentionMetadata.edited, true);
				const reactionKey = { instance: tenant, clientId: client.id, targetMessageId: `${marker}_provider_message`, actorId: `${marker}_actor` };
				await tx["messageReaction"].upsert({ where: { instance_clientId_targetMessageId_actorId: reactionKey }, create: { ...reactionKey, fromMe: true, emoji: "👍", reactedAt: new Date() }, update: { emoji: "👍" } });
				const tombstone = await tx["messageReaction"].upsert({ where: { instance_clientId_targetMessageId_actorId: reactionKey }, create: { ...reactionKey, fromMe: true, emoji: "", reactedAt: new Date() }, update: { emoji: "" } });
				assert.equal(tombstone.emoji, "");
				checks.push("message editing and reaction tombstones");
				stage = "internal-chat-and-mentions";
				const internal = await tx["internalChat"].create({
					data: { instance: tenant, isGroup: true, groupName: marker, participants: { create: { userId } },
						messages: { create: { instance: tenant, from: "FICTICIO", type: "chat", body: marker, timestamp: String(Date.now()), status: "UNKNOWN", isForwarded: false, isEdited: false, mentionMetadata: { smoke: true }, mentions: { create: { userId } } } } },
					include: { participants: true, messages: { include: { mentions: true } } }
				});
				assert.equal(internal.participants[0].userId, userId);
				assert.equal(internal.messages[0].mentions[0].userId, userId);
				checks.push("internal group membership and nested mentions");
				stage = "instance-less-inbox";
				const inbox = await tx["remoteInboundEventInbox"].create({ data: {
					idempotencyKey: `${marker}_inbox_${tenant}`, clientId: client.id, eventType: "FICTICIO", providerMessageId: marker,
					payloadHash: "0".repeat(64), payload: { smoke: true }, status: "FAILED"
				} });
				assert.equal(inbox.payload.smoke, true);
				checks.push("instance-less ownership within transaction");
				stage = "groupby-and-raw";
				const aggregate = await tx["wppMessage"].groupBy({ by: ["status"], where: { id: message.id }, _count: { _all: true }, _max: { id: true } });
				assert.equal(aggregate.length, 1);
				assert.equal(aggregate[0].status, "UNKNOWN");
				assert.equal(aggregate[0]._count._all, 1);
				assert.equal(aggregate[0]._max.id, message.id);
				const raw = await tx["$queryRawUnsafe"]("SELECT id, instance FROM contacts WHERE instance = ? AND id = ?", tenant, contact.id);
				assert.equal(raw.length, 1);
				assert.equal(raw[0].instance, tenant);
				const rawWrite = await tx["$executeRawUnsafe"]("UPDATE messages SET is_edited = ? WHERE instance = ? AND id = ?", 0, tenant, message.id);
				assert.equal(rawWrite, 1);
				checks.push("groupBy and native raw table rewriting");
				await assert.rejects(async () => await tx["wppContact"].create({ data: { instance: otherTenant, name: marker } }), /SCOPE_MISMATCH|CROSS_TENANT|Tenant mismatch/);
				checks.push("cross tenant transaction write rejected");
				stage = "nested-delete-and-cascade";
				await tx["operatorOutboundSend"].delete({ where: { id: outbound.id } });
				await tx["wppChat"].update({ where: { id: chat.id }, data: { messages: { deleteMany: { id: message.id } }, wppTags: { disconnect: { id: chat.wppTags[0].id } } } });
				assert.equal(await tx["wppMessage"].count({ where: { id: message.id } }), 0);
				assert.equal((await tx["wppChat"].findUnique({ where: { id: chat.id }, include: { wppTags: true } })).wppTags.length, 0);
				await tx["internalMessage"].delete({ where: { id: internal.messages[0].id } });
				assert.equal(await tx["internalMention"].count({ where: { messageId: internal.messages[0].id } }), 0);
				checks.push("nested deletion, join disconnect, and FK cascade");
				throw ROLLBACK;
			});
			assert.fail("Smoke transaction unexpectedly committed");
		} catch (error) { if (error !== ROLLBACK) throw error; }
	});
	stage = "rollback-verification";
	assert.deepEqual(await runtimeCounts(router, tenant), before, "Every synthetic write must roll back");
	checks.push("forced transaction rollback restored runtime counts");
	return checks;
}

async function main(): Promise<void> {
	if (process.argv.slice(2).join(" ") === "--help") {
		console.log("tenant-sql-smoke: prepared homolog registry only. Tests both tenants through the SQL router.\nAll synthetic native writes execute inside forced-rollback transactions; no service/provider imports or messages are sent.\nChecks central business-table counts before and after, and prints assertion labels only.");
		return;
	}
	if (process.argv.length > 2 || process.platform !== "linux") throw new Error("SMOKE_HOMOLOG_SERVER_ONLY");
	process.env["WHATSAPP_TENANT_SQL_REGISTRY"] ??= REGISTRY_PATH;
	if (process.env["WHATSAPP_TENANT_SQL_REGISTRY"] !== REGISTRY_PATH) throw new Error("SMOKE_FIXED_REGISTRY_REQUIRED");
	const registry = validateRegistry(JSON.parse(readFileSync(REGISTRY_PATH, "utf8")));
	const password = readFileSync(registry.credentialFile, "utf8").trim();
	const pools = loadTenantPools();
	const router = createTenantSqlRouter(pools);
	let source: Connection | undefined;
	try {
		stage = "source-baseline";
		source = await createConnection({ host: "127.0.0.1", port: 3306, user: "homolog", password, database: "homolog-whatsapp", supportBigNumbers: true, bigNumberStrings: true });
		await source.query("SET SESSION TRANSACTION READ ONLY");
		const before = await centralCounts(source);
		for (const tenant of registry.tenants) {
			stage = "tenant-read-baseline";
			const counts = await runtimeCounts(router, tenant.instance);
			const reads = await withDatabaseTenant(tenant.instance, async () => await router["wppMessage"].findMany({ where: { instance: tenant.instance }, select: { instance: true }, take: 5 }));
			assert(reads.every((row: { instance: string }) => row.instance === tenant.instance));
			const checks = await transactionalSmoke(router, tenant.instance, tenant.autoIncrementOffset);
			console.log(JSON.stringify({ component: "tenant-sql-smoke", tenant: tenant.instance, runtimeCounts: counts, checks, passed: true }));
		}
		stage = "source-final-verification";
		assert.deepEqual(await centralCounts(source), before, "Central business-table counts must remain unchanged");
		console.log(JSON.stringify({ component: "tenant-sql-smoke", stage: "complete", tenants: registry.tenants.map(tenant => tenant.instance), centralCountsUnchanged: true, allWritesRolledBack: true }));
	} finally {
		if (source) await source.end();
		await router["$disconnect"]();
	}
}

main().catch(error => {
	// Never print driver SQL, parameters, fixture IDs, or production message contents.
	const code = typeof error === "object" && error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "SMOKE_FAILED";
	console.error(JSON.stringify({ component: "tenant-sql-smoke", stage, code, assertion: error instanceof assert.AssertionError ? error.message.split("\n")[0] : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "" }));
	process.exitCode = 1;
});
