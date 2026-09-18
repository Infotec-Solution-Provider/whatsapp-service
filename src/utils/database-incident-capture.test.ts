import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { automaticCaptureEnabled, DatabaseIncidentCapture } from "./database-incident-capture";

async function main(): Promise<void> {
	assert.equal(automaticCaptureEnabled("linux", { pm_id: "13" }), true);
	assert.equal(automaticCaptureEnabled("linux", { pm_id: "0" }), true);
	assert.equal(automaticCaptureEnabled("linux", { pm_id: "13", DATABASE_INCIDENT_AUTO_CAPTURE: "false" }), false);
	assert.equal(automaticCaptureEnabled("win32", { pm_id: "13" }), false);
	assert.equal(automaticCaptureEnabled("linux", {}), false);
	assert.equal(automaticCaptureEnabled("linux", { pm_id: "13;secret" }), false);
	assert.equal(automaticCaptureEnabled("linux", { pm_id: "1000001" }), false);
	const directory = await mkdtemp(join(tmpdir(), "whatsapp-auto-incident-"));
	try {
		let now = 0;
		let runs = 0;
		let release: (() => void) | undefined;
		const reports: Record<string, unknown>[] = [];
		const capture = new DatabaseIncidentCapture({
			directory, pm2Id: "13", clock: () => now, report: (entry) => { reports.push(entry); },
			runCollector: async () => {
				runs++;
				if (runs === 1) await new Promise<void>((done) => { release = done; });
				return { output: '{"type":"sample"}\n{"partial":', failed: runs === 1 };
			},
		});
		for (let index = 0; index < 65; index++) { now += 5_000; capture.sampleRuntime(); }
		now += 52_749; // A stalled event loop may not have executed its next timer yet.
		const trigger = { code: "P2028", source: "prisma-engine" };
		const pending = capture.capture(trigger);
		capture.sampleRuntime(); // A timer after the error cannot replace the trigger snapshot.
		// Yield to the actual filesystem, not a wall-clock sleep.
		const deadline = Date.now() + 5_000;
		while (!release && Date.now() < deadline) await new Promise<void>((done) => setImmediate(done));
		assert.ok(release, "collector should start after persisting history");
		const firstPath = String(reports[0]?.["path"]);
		const header = JSON.parse((await readFile(firstPath, "utf8")).trim());
		assert.equal(header.type, "trigger");
		assert.equal(header.code, "P2028");
		assert.equal(header.history.length, 60);
		assert.equal(header.current.timeSinceLastSampleMs, 52_749);
		assert.equal(header.history[59].timerDelayMs, 0);
		now += 300_001;
		await capture.capture(trigger); // Even after cooldown, an active collector is exclusive.
		assert.equal(runs, 1);
		release();
		await pending;
		const records = (await readFile(firstPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.length, 3);
		assert.equal(records[2].failed, true);
		assert.equal(reports[1]?.["event"], "collector_failed");

		await capture.capture(trigger);
		assert.equal(runs, 2);
		await capture.capture({ code: "P2024", source: "another-source" });
		assert.equal(runs, 2); // Cooldown spans different error codes/sources.

		await writeFile(join(directory, "operator-notes.txt"), "keep");
		await writeFile(join(directory, "incident-14-1000000000000-00000000-0000-0000-0000-000000000000.jsonl"), "keep");
		for (let index = 0; index < 7; index++) {
			now += 300_001;
			await capture.capture(trigger);
		}
		const files = await readdir(directory);
		assert.equal(files.filter((name) => name.startsWith("incident-13-")).length, 5);
		assert.equal(await readFile(join(directory, "operator-notes.txt"), "utf8"), "keep");
		assert.equal(files.filter((name) => name.startsWith("incident-14-")).length, 1);
		console.log("automatic incident capture: history, exclusivity, cooldown, partial output and retention passed");

		let failedRuns = 0;
		const failure = new DatabaseIncidentCapture({
			directory: join(directory, "failures"), pm2Id: "13", clock: () => now,
			report: () => { throw new Error("broken logger"); },
			runCollector: async () => { failedRuns++; throw new Error("private password"); },
		});
		await failure.capture(trigger); // Neither runner nor reporting errors escape into sending.
		await failure.capture(trigger);
		assert.equal(failedRuns, 1);
		now += 300_001;
		await failure.capture(trigger);
		assert.equal(failedRuns, 2);
		const noDisk = new DatabaseIncidentCapture({
			directory: join(directory, "operator-notes.txt", "invalid"), pm2Id: "13",
			report: () => undefined, runCollector: async () => { throw new Error("must not run"); },
		});
		await noDisk.capture(trigger);
		console.log("automatic incident capture: diagnostic failures do not escape and remain rate limited");
	} finally {
		assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
		assert.ok(directory.includes("whatsapp-auto-incident-"));
		await rm(directory, { recursive: true, force: true });
	}
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
