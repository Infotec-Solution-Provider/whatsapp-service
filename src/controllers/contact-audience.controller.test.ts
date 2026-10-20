import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

class Reply extends EventEmitter {
	destroyed = false;
	statusCode = 200;
	body: any;
	headers: Record<string, string> = {};
	status(code: number) { this.statusCode = code; return this; }
	json(body: unknown) { this.body = body; return this; }
	setHeader(key: string, value: string) { this.headers[key] = value; }
}
async function main() {
	const saved = new Map<string, NodeModule | undefined>();
	const stub = (path: string, value: unknown) => {
		const id = require.resolve(path); saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: value } as NodeModule;
	};
	let calls = 0;
	let hold: (() => void) | undefined;
	let active = Promise.resolve();
	try {
		stub("../services/auth.service", { __esModule: true, default: { fetchSessionData: async () => ({ instance: "a", userId: 1, sectorId: 2, name: "Test", role: "USER" }) } });
		stub("../services/contact-audience/service", { searchContactAudience: async (session: unknown, authorization: string, body: unknown) => {
			calls++;
			assert.equal(authorization, "Bearer test");
			assert.equal((session as { instance: string }).instance, "a");
			await active;
			return { data: [], body };
		} });
		const controller = (require("./contact-audience.controller") as typeof import("./contact-audience.controller")).default;
		const route = controller.router.stack.find((entry: any) => entry.route?.path === "/api/whatsapp/contacts/customer/search")!.route as unknown as { methods: { post: boolean }; stack: Array<{ handle: unknown }> };
		assert.equal(route.methods.post, true);
		const authentication = route.stack[0]!.handle as (req: Request, res: Response, next: () => void) => Promise<void>;
		const search = route.stack[1]!.handle as (req: Request, res: Response) => Promise<void>;
		const request = (cursor: number) => ({ headers: { authorization: "Bearer test" }, params: {}, query: {}, body: { contactFilters: {}, customerFilters: {}, pagination: { afterId: cursor, limit: 200 } } } as unknown as Request);
		const unauthenticated = new Reply(); let passed = false;
		await authentication({ headers: {} } as Request, unauthenticated as unknown as Response, () => { passed = true; });
		assert.equal(unauthenticated.statusCode, 401);
		assert.equal(passed, false);
		assert.equal(calls, 0);
		const req = request(0);
		await authentication(req, new Reply() as unknown as Response, () => { passed = true; });
		assert.equal(passed, true);
		const response = new Reply();
		await search(req, response as unknown as Response);
		assert.equal(response.statusCode, 200);
		assert.deepEqual(response.body.data, []);
		// Long exports must not inherit the legacy thirty sequential reads quota.
		for (let index = 1; index <= 40; index++) {
			const sequential = request(index); sequential.session = req.session;
			const reply = new Reply();
			await search(sequential, reply as unknown as Response);
			assert.equal(reply.statusCode, 200);
		}
		active = new Promise<void>(resolve => { hold = resolve; });
		const first = request(101), second = request(102), third = request(103);
		for (const pending of [first, second, third]) pending.session = req.session;
		const one = search(first, new Reply() as unknown as Response);
		const two = search(second, new Reply() as unknown as Response);
		await Promise.resolve();
		const crowded = new Reply();
		await search(third, crowded as unknown as Response);
		assert.equal(crowded.statusCode, 429, "parallel export/search work must remain bounded");
		assert.equal(crowded.body.code, "READ_REQUEST_LIMIT");
		hold!(); await Promise.all([one, two]);
		console.log("contact-audience HTTP authentication and admission: passed");
	} finally {
		hold?.();
		for (const [id, previous] of saved) { if (previous) require.cache[id] = previous; else delete require.cache[id]; }
	}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
