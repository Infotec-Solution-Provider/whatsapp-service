import assert from "node:assert/strict";
import type { SendFileOptions, SendTemplateOptions } from "../types/whatsapp-instance.types";
import { WabaDeliveryError, WabaTemplateBodyValuesError } from "../utils/waba-send";

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
		for (const emoji of ["👍", "❤️", ""]) {
			bodies.length = 0;
			send = () => ({ messages: [{ id: "wamid.reaction" }] });
			const receipt = await client.sendReaction({ to: options.to, messageId: "wamid.target", emoji, wabaCallbackData: "reaction-callback" });
			assert.equal(receipt.reactionId, "wamid.reaction");
			assert.equal(receipt.removed, emoji === "");
			assert.deepEqual(bodies, [{ messaging_product: "whatsapp", recipient_type: "individual", to: options.to,
				type: "reaction", reaction: { message_id: "wamid.target", emoji }, biz_opaque_callback_data: "reaction-callback" }]);
		}
		for (const response of [undefined, {}, { messages: [] }, { messages: [{ id: "local-uuid" }] }]) {
			bodies.length = 0; send = () => response;
			await assert.rejects(client.sendReaction({ to: options.to, messageId: "wamid.target", emoji: "👍" }),
				(error: any) => error.code === "REACTION_DELIVERY_UNKNOWN");
			assert.equal(bodies.length, 1);
		}
		for (const error of [{ code: "ETIMEDOUT" }, { response: { status: 503 } }, rejected]) {
			bodies.length = 0; send = () => { throw error; };
			await assert.rejects(client.sendReaction({ to: options.to, messageId: "wamid.target", emoji: "👍" }),
				(failure: any) => failure.code === (error === rejected ? "REACTION_REJECTED" : "REACTION_DELIVERY_UNKNOWN"));
			assert.equal(bodies.length, 1, "reaction failure must never dispatch twice");
		}
		bodies.length = 0;
		await assert.rejects(client.sendReaction({ to: "group@g.us", messageId: "wamid.target", emoji: "👍", isGroup: true }));
		assert.equal(bodies.length, 0);

		send = () => ({ messages: [{ id: "wamid.template" }] });
		const templateOptions: SendTemplateOptions = {
			to: options.to,
			components: [],
			templateVariables: {
				saudação_tempo: "Boa tarde", cliente_cnpj: "", cliente_razao: "Empresa C",
				contato_primeiro_nome: "Luiza", contato_nome_completo: "Luiza Martins",
				atendente_nome: "Bruno", atendente_nome_exibição: "Bruno"
			},
			template: {
				id: "legacy", name: "legacy", language: "pt_BR", category: "UTILITY", source: "waba", status: "APPROVED", text: "{{1}} da {{2}}",
				raw: { components: [
					{ type: "HEADER", format: "TEXT", text: "Olá {{1}}", example: { header_text: ["atendente_nome"] } },
					{ type: "BODY", text: "{{1}} da {{2}}", example: { body_text: [["contato_primeiro_nome", "cliente_razao"]] } }
				] }
			}
		};
		const legacyTemplate = await client.sendTemplate(templateOptions, 1, 2);
		assert.equal(legacyTemplate.body, "Olá Bruno\nLuiza da Empresa C");
		assert.deepEqual(bodies[0].template.components, [
			{ type: "header", parameters: [{ type: "text", text: "Bruno" }] },
			{ type: "body", parameters: [{ type: "text", text: "Luiza" }, { type: "text", text: "Empresa C" }] }
		]);

		const manualOptions: SendTemplateOptions = {
			...templateOptions,
			template: {
				...templateOptions.template,
				id: "aviso", name: "aviso", text: "Olá {{1}}. Valor {{2}} para {{1}}.",
				raw: { components: [
					{ type: "HEADER", format: "TEXT", text: "Comunicado" },
					{ type: "BODY", text: "Olá {{1}}. Valor {{2}} para {{1}}.", example: { body_text: [["Exemplo", "R$ 1"]] } }
				] }
			},
			templateVariables: { ...templateOptions.templateVariables, bodyValues: [" Luiza {{2}} ", "R$ 12,50 e $&"] }
		};
		const manualTemplate = await client.sendTemplate(manualOptions, 1, 2);
		assert.equal(manualTemplate.body, "Comunicado\nOlá  Luiza {{2}} . Valor R$ 12,50 e $& para  Luiza {{2}} .");
		assert.deepEqual(bodies[1].template.components, [{ type: "body", parameters: [
			{ type: "text", text: " Luiza {{2}} " }, { type: "text", text: "R$ 12,50 e $&" }
		] }]);

		bodies.length = 0;
		for (const invalid of [null, "texto", [], ["Luiza"], ["Luiza", "  "], ["Luiza", 4], ["Luiza", "12,50", "extra"], Array(2)]) {
			await assert.rejects(client.sendTemplate({
				...manualOptions, templateVariables: { ...manualOptions.templateVariables, bodyValues: invalid as string[] }
			}, 1, 2), WabaTemplateBodyValuesError);
		}
		assert.equal(bodies.length, 0, "invalid positional values must fail before dispatch");
		assert.doesNotMatch(JSON.stringify(logs), /never-log-this-token|Authorization/);
		console.log("waba-whatsapp-client: media renewal, reactions, positional and legacy templates passed");
	} finally {
		for (const [id, cached] of previous) { if (cached) require.cache[id] = cached; else delete require.cache[id]; }
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
