import assert from "node:assert/strict";
import type { SendFileOptions } from "../types/whatsapp-instance.types";
import { WabaDeliveryError } from "../utils/waba-send";

async function main() {
	const previous = new Map<string, NodeModule | undefined>();
	const stub = (path: string, exports: unknown) => {
		const id = require.resolve(path);
		previous.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
	};
	const bodies: any[] = [];
	const uploads: Array<[number, string | undefined]> = [];
	const logs: unknown[] = [];
	let send: () => unknown = () => ({ messages: [{ id: "wamid.sent" }] });
	let upload: (rejected?: string) => string = (rejected) => rejected ? "222" : "111";
	try {
		stub("../services/files.service", { __esModule: true, default: {
			getWabaMedia: async (fileId: number, rejected?: string) => { uploads.push([fileId, rejected]); return upload(rejected); },
		} });
		stub("../services/prisma.service", { __esModule: true, default: {} });
		stub("../adapters/template.adapter", { __esModule: true, default: {} });
		stub("@in.pulse-crm/utils", { Logger: { info: () => {}, error: (...data: unknown[]) => logs.push(data) } });
		stub("axios", { __esModule: true, default: { post: async (_url: string, body: unknown) => {
			bodies.push(structuredClone(body));
			return { data: await send() };
		} } });
		stub("../utils/processing-logger", { __esModule: true, default: class {
			log(...data: unknown[]) { logs.push(data); }
			success(data: unknown) { logs.push(data); }
			failed(data: unknown) { logs.push(data); }
		} });
		const path = require.resolve("./waba-whatsapp-client");
		previous.set(path, require.cache[path]);
		delete require.cache[path];
		const Client = (require("./waba-whatsapp-client") as typeof import("./waba-whatsapp-client")).default;
		const client = new Client(6, "tenant", "Official", "5500000000", "phone-id", "account-id", "never-log-this-token");
		const options = {
			to: "5511999999999", text: "Caption", fileId: 42,
			file: { id: 42, name: "image.png", size: 52831, mime_type: "image/png" },
			localFileUrl: "http://files.test/42", publicFileUrl: "https://files.test/42", sendAsDocument: false,
		} as SendFileOptions;
		const rejected = { response: { status: 400, data: { error: {
			code: 100, message: "Param image.id is not a valid whatsapp business account media attachment ID", fbtrace_id: "trace",
		} } }, config: { headers: { Authorization: "Bearer never-log-this-token" } } };
		send = () => { if (bodies.length === 1) throw rejected; return { messages: [{ id: "wamid.sent" }] }; };
		const result = await client.sendMessage(options);
		assert.equal(result.wabaId, "wamid.sent");
		assert.deepEqual(uploads, [[42, undefined], [42, "111"]]);
		assert.equal(bodies.length, 2);
		assert.deepEqual(bodies.map((body) => body.image), [{ id: "111", caption: "Caption" }, { id: "222", caption: "Caption" }]);
		assert.equal(result.type, "image");
		assert.doesNotMatch(JSON.stringify(logs), /never-log-this-token|Authorization/);
		assert.ok(JSON.stringify(logs).includes('"id":"111"'), "original failed payload must retain its original media ID in diagnostics");

		bodies.length = uploads.length = 0;
		upload = () => { throw new Error("file unavailable"); };
		await assert.rejects(() => client.sendMessage(options), (e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === "FAILED");
		assert.equal(bodies.length, 0, "initial upload failure is safely unsent");

		bodies.length = uploads.length = 0;
		upload = () => "111";
		send = () => { throw { code: "ETIMEDOUT" }; };
		await assert.rejects(() => client.sendMessage(options), (e: unknown) => e instanceof WabaDeliveryError && e.deliveryStatus === "UNKNOWN");
		assert.equal(bodies.length, 1);
		assert.equal(uploads.length, 1, "timeout cannot renew media or send again");

		bodies.length = uploads.length = 0;
		send = () => ({ messages: [{ id: "wamid.text" }] });
		const text = await client.sendMessage({ to: options.to, text: "hello" });
		assert.equal(text.wabaId, "wamid.text");
		assert.equal(bodies[0].type, "text");
		assert.equal("biz_opaque_callback_data" in bodies[0], false, "ordinary messages must remain unmarked");
		assert.equal(uploads.length, 0);
		await client.sendMessage({ to: options.to, text: "HEALTHPROBE:test", wabaCallbackData: "probe-callback" });
		assert.equal(bodies[1].biz_opaque_callback_data, "probe-callback");
		console.log("waba-whatsapp-client: real client media renewal, caption/type, upload failure, timeout and credential-free logs passed");
	} finally {
		for (const [id, cached] of previous) { if (cached) require.cache[id] = cached; else delete require.cache[id]; }
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
