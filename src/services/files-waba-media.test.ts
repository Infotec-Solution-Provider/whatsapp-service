import assert from "node:assert/strict";

async function main() {
	const sdkPath = require.resolve("../sdk-local");
	const servicePath = require.resolve("./files.service");
	const previousSdk = require.cache[sdkPath];
	const previousService = require.cache[servicePath];
	const calls: Array<{ path: string; body: unknown }> = [];
	let mediaId: unknown = "111";
	try {
		// Exercise the real HTTP adapter without loading SDK service clients or making requests.
		require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: {
			FilesClient: class {
				ax = { post: async (path: string, body: unknown) => {
					calls.push({ path, body });
					return { data: { data: { mediaId } } };
				} };
			},
		} } as NodeModule;
		delete require.cache[servicePath];
		const client = (require(servicePath) as typeof import("./files.service")).default;
		assert.equal(await client.getWabaMedia(42), "111");
		assert.deepEqual(calls[0], { path: "/api/waba/get-media-id", body: { fileId: 42 } });
		await assert.rejects(() => client.getWabaMedia(42, "111"), /novo identificador válido/,
			"an old files-service ignoring the renewal option must not allow another send with the rejected ID");
		assert.deepEqual(calls[1]?.body, { fileId: 42, rejectedMediaId: "111" });
		mediaId = "222";
		assert.equal(await client.getWabaMedia(42, "111"), "222");
		for (const invalid of [undefined, null, 222, "", "not-a-media-id", "123\n", "1".repeat(256)]) {
			mediaId = invalid;
			await assert.rejects(() => client.getWabaMedia(42), /identificador válido/);
		}
		console.log("files-waba-media: renewal request compatibility, unchanged/invalid ID rejection and fresh ID accepted");
	} finally {
		if (previousSdk) require.cache[sdkPath] = previousSdk; else delete require.cache[sdkPath];
		if (previousService) require.cache[servicePath] = previousService; else delete require.cache[servicePath];
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
