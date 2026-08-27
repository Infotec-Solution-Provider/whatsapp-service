import assert from "node:assert/strict";
import prismaService from "./prisma.service";
import frontendPerformanceService, { parseFrontendPerformanceBatch } from "./frontend-performance.service";

const tenantA = "telemetry-test-a";
const tenantB = "telemetry-test-b";
const sessionA = "74677154-a6db-4dd1-914f-25454acb5b34";
const sessionB = "7d9eb273-c319-4fb4-b303-e45da0c4a7ef";
const now = new Date();

function batch(sessionId: string, value: number) {
	return parseFrontendPerformanceBatch({
		schemaVersion: 1,
		sessionId,
		buildId: "b451e51",
		startedAt: now.toISOString(),
		device: {
			browser: "Chrome 140",
			hardwareConcurrency: 4,
			deviceMemoryGb: 4,
			effectiveType: "4g",
			viewportWidth: 1366,
			viewportHeight: 768
		},
		metrics: [
			{
				name: "web_vital.inp",
				value,
				unit: "ms",
				occurredAt: now.toISOString(),
				route: "/tenant/contacts",
				tags: { rating: "good" }
			}
		]
	});
}

async function run() {
	await prismaService.frontendPerformanceSession.deleteMany({
		where: { sessionId: { in: [sessionA, sessionB] } }
	});
	const tenantABatch = batch(sessionA, 120);
	assert.deepEqual(await frontendPerformanceService.ingest(tenantA, 11, tenantABatch), {
		accepted: 1,
		duplicate: false
	});
	assert.deepEqual(await frontendPerformanceService.ingest(tenantA, 11, tenantABatch), {
		accepted: 0,
		duplicate: true
	});
	await frontendPerformanceService.ingest(tenantB, 22, batch(sessionB, 900));

	const filters = {
		from: new Date(now.getTime() - 60_000),
		to: new Date(now.getTime() + 60_000)
	};
	const summaryA = await frontendPerformanceService.summary(tenantA, filters);
	const summaryB = await frontendPerformanceService.summary(tenantB, filters);
	assert.equal(summaryA.sessions, 1);
	assert.equal(summaryA.samples, 1);
	assert.equal(summaryA.metrics[0]?.p75, 120);
	assert.equal(summaryB.metrics[0]?.p75, 900);

	let csvA = "";
	for await (const chunk of frontendPerformanceService.exportCsvChunks(tenantA, filters)) csvA += chunk;
	assert.match(csvA, /74677154-a6db-4dd1-914f-25454acb5b34/);
	assert.doesNotMatch(csvA, /7d9eb273-c319-4fb4-b303-e45da0c4a7ef/);
	console.log("frontend-performance MySQL tenant isolation smoke passed");
}

run()
	.finally(async () => {
		await prismaService.frontendPerformanceSession.deleteMany({
			where: { sessionId: { in: [sessionA, sessionB] } }
		});
		await prismaService.$disconnect();
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
