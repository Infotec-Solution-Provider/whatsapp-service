import assert from "node:assert/strict";
import http from "node:http";
import InstancesClient from "./instance.client";

async function main() {
	let requests = 0;
	const server = http.createServer((req, res) => {
		requests++;
		assert.equal(req.url, "/api/instances/qa-tenant/query");
		let text = "";
		req.on("data", chunk => { text += String(chunk); });
		req.on("end", () => {
			const body = JSON.parse(text) as { query: string; parameters: unknown[]; timeoutMs?: number };
			assert.deepEqual(body.parameters, [7]);
			assert.equal(body.timeoutMs, undefined, "transport options do not enter SQL parameters/body");
			const timer = setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: [{ id: 7 }] })); }, body.query === "slow" ? 1000 : 0);
			res.on("close", () => clearTimeout(timer));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert(address && typeof address === "object");
		const client = new InstancesClient(`http://127.0.0.1:${address.port}`);
		assert.equal(client.ax.defaults.timeout, 60000, "existing callers retain their default");
		assert.deepEqual(await client.executeQuery("qa-tenant", "fast", [7]), [{ id: 7 }]);
		const started = Date.now();
		await assert.rejects(() => client.executeQuery("qa-tenant", "slow", [7], { timeoutMs: 80 }), /timeout of 80ms exceeded/);
		assert.ok(Date.now() - started < 800, "Axios aborts the request before the delayed response");
		assert.equal(client.ax.defaults.timeout, 60000, "one bounded call does not mutate the shared SDK");
		const before = requests;
		for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 60001]) await assert.rejects(() => client.executeQuery("qa-tenant", "fast", [7], { timeoutMs }), /INVALID_INSTANCE_QUERY_TIMEOUT/);
		assert.equal(requests, before, "invalid timeout is rejected before any network request");
		console.log("instance-query-timeout: PASS real HTTP abort, default preservation and option validation");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
