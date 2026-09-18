import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseIncidentDetails, flushDatabaseIncidentLog, recordDatabaseIncident } from "./database-incident-log";

const poolTimeout = databaseIncidentDetails({
	code: "P2024",
	message: "Timed out fetching a new connection from the connection pool",
});
assert.equal(poolTimeout?.code, "P2024");
assert.match(poolTimeout?.message ?? "", /connection pool/);
assert.equal(databaseIncidentDetails(new Error("invalid request payload")), null);
assert.equal(databaseIncidentDetails({
	message: "Invalid `tx.wppMessage.create()` invocation:\nTransaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
})?.code, "P2028");

void (async () => {
	const directory = await mkdtemp(join(tmpdir(), "whatsapp-db-incident-"));
	const path = join(directory, "incident.log");
	const previousPath = process.env["DATABASE_INCIDENT_LOG_PATH"];
	process.env["DATABASE_INCIDENT_LOG_PATH"] = path;
	try {
		assert.equal(recordDatabaseIncident({ code: "P2024", message: "Timed out fetching a new connection from the connection pool" }, {
			source: "test", operation: "findMany",
		}), true);
		await flushDatabaseIncidentLog();
		assert.match(await readFile(path, "utf8"), /P2024/);
	} finally {
		if (previousPath === undefined) delete process.env["DATABASE_INCIDENT_LOG_PATH"];
		else process.env["DATABASE_INCIDENT_LOG_PATH"] = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
	console.log("database incident file logger classification passed");
})().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
