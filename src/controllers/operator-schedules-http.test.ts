import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import "express-async-errors";
import { handleRequestError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";

const saved = new Map<string, NodeModule | undefined>();
function stub(path: string, value: unknown) {
	const filename = require.resolve(path);
	saved.set(filename, require.cache[filename]);
	require.cache[filename] = {
		id: filename,
		filename,
		loaded: true,
		exports: { __esModule: true, default: value }
	} as NodeModule;
}
for (const path of [
	"../services/prisma.service",
	"../services/instances.service",
	"../services/parameters.service",
	"../services/customer-profile-tags.service"
])
	stub(path, {});
const { UnifiedSchedulesService } =
	require("../services/unified-schedules.service") as typeof import("../services/unified-schedules.service");
const actor: SessionData = { instance: "fixture", userId: 7, sectorId: 3, role: "ATIVO", name: "Fixture" };
const service = new UnifiedSchedulesService(
	{ wppSchedule: { findMany: async () => [] } } as any,
	{ executeQuery: async () => [{ VISUALIZA_COMPRAS: "SIM" }] } as any,
	{ getSessionParams: async () => ({}) } as any,
	{} as any,
	() => new Date("2026-11-13T15:00:00Z"),
	() => undefined
);
stub("../services/unified-schedules.service", service);
const legacyReads: unknown[] = [];
stub("../services/schedules.service", {
	getSchedulesBySession: async (_session: SessionData, filters: unknown) => {
		legacyReads.push(filters);
		return [];
	}
});
stub(
	"../middlewares/is-authenticated.middleware",
	(req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (!req.headers.authorization) {
			res.status(401).json({ message: "Unauthorized" });
			return;
		}
		req.session = { ...actor, role: req.headers.authorization === "admin" ? "ADMIN" : "ATIVO" };
		next();
	}
);
const controller = (require("./schedules.controller") as typeof import("./schedules.controller")).default;
for (const [filename, previous] of saved) {
	if (previous) require.cache[filename] = previous;
	else delete require.cache[filename];
}

test("personal HTTP contract authenticates, disables caching, validates queries and preserves admin unified pagination", async () => {
	const app = express();
	app.use(controller.router);
	app.use(handleRequestError as unknown as express.ErrorRequestHandler);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}/api/whatsapp/schedules`;
		assert.equal((await fetch(base + "/mine")).status, 401);
		const ok = await fetch(base + "/mine", { headers: { Authorization: "operator" } });
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("cache-control"), "private, no-store");
		assert.match(ok.headers.get("vary") ?? "", /Authorization/i);
		const result = (await ok.json()) as Record<string, any>;
		assert.equal(result["referenceAt"], "2026-11-13T15:00:00.000Z");
		assert.equal(result["timeZone"], "America/Sao_Paulo");
		assert.deepEqual(result["capabilities"], { channels: ["WHATSAPP"], commercial: true });
		assert.equal(result["pagination"].totalRows, 0);
		for (const values of [
			{
				view: "crm",
				segmentIds: "0,-1",
				groupIds: "3",
				loyaltyOperatorIds: "0",
				states: "RS,SC",
				phone: "(51) 1234",
				email: "@example",
				CODIGO: "-1",
				CPF_CNPJ: "123.456.789-01",
				COD_ERP: "ERP",
				CIDADE: "Porto Alegre",
				ATIVO: "SIM",
				PESSOA: "FIS"
			},
			{
				view: "crm",
				purchaseStatus: "without_purchases",
				registeredFrom: "2026-11-13",
				registeredTo: "2026-11-13"
			},
			{
				view: "crm",
				purchaseFrom: "2026-11-13",
				purchaseTo: "2026-11-13",
				brandIds: "2",
				positionIds: "3",
				originIds: "4",
				mediaIds: "5",
				unitIds: "6"
			}
		]) {
			const query = new URLSearchParams(
				Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string")
			);
			assert.equal(
				(await fetch(base + "/mine?" + query, { headers: { Authorization: "operator" } })).status,
				200
			);
		}
		for (const query of [
			"userId=7",
			"sectorId=3",
			"channels[]=WHATSAPP",
			"channels[bad]=WHATSAPP",
			"search[bad]=x",
			"unknown=x",
			"view=legacy",
			"segmentIds[]=1",
			"segmentIds=2147483648",
			"states=rs",
			"phone=12",
			"CPF_CNPJ=---",
			"purchaseStatus=without_purchases&purchaseFrom=2026-11-13",
			"registeredTo=2026-02-30",
			"perPage=101",
			"period=custom&scheduledFrom=2026-02-31T00:00:00Z&scheduledTo=2026-03-04T00:00:00Z"
		]) {
			const response = await fetch(base + "/mine?" + query, { headers: { Authorization: "operator" } });
			assert.equal(response.status, 400, query);
		}
		assert.equal((await fetch(base + "/unified?userId=8", { headers: { Authorization: "operator" } })).status, 403);
		assert.equal((await fetch(base + "?userId=8", { headers: { Authorization: "operator" } })).status, 403);
		assert.equal((await fetch(base, { headers: { Authorization: "operator" } })).status, 200);
		assert.deepEqual(legacyReads, [{ userId: 7, sectorId: 3 }]);
		const admin = await fetch(base + "/unified?userId=8&perPage=100", { headers: { Authorization: "admin" } });
		assert.equal(admin.status, 200);
		assert.equal(((await admin.json()) as Record<string, any>)["pagination"].perPage, 100);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
