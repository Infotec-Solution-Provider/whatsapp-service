import "express-async-errors";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Prisma } from "@prisma/client";
import { handleRequestError } from "@rgranatodutra/http-errors";
import prisma from "./prisma.service";
import authService from "./auth.service";
import controller from "../controllers/parameters.controller";
import settingsService from "./parameter-settings.service";

type Row = {
	id: number;
	scope: string;
	instance: string;
	sectorId: number | null;
	userId: number | null;
	key: string;
	value: string;
};
let rows: Row[] = [];
const whereMatches = (row: Row, where: Record<string, unknown>) =>
	Object.entries(where).every(([key, value]) => {
		if (key === "key" && typeof value === "object" && value !== null)
			return (value as { in: string[] }).in.includes(row.key);
		return row[key as keyof Row] === value;
	});
const delegate = {
	async findMany({ where }: { where: Record<string, unknown> }) {
		return rows.filter((row) => whereMatches(row, where));
	},
	async deleteMany({ where }: { where: Record<string, unknown> }) {
		rows = rows.filter((row) => !whereMatches(row, where));
	},
	async updateMany({ where, data }: { where: Record<string, unknown>; data: { value: string } }) {
		rows.forEach((row) => {
			if (whereMatches(row, where)) row.value = data.value;
		});
	},
	async create({ data }: { data: Omit<Row, "id"> }) {
		rows.push({ id: rows.length + 1, ...data });
	}
};
const originalFindMany = prisma.parameter.findMany;
const originalTransaction = prisma.$transaction;
const originalSession = authService.fetchSessionData;
Object.assign(prisma.parameter, { findMany: delegate.findMany });
Object.assign(prisma, {
	$transaction: async (
		callback: (tx: { parameter: typeof delegate }) => Promise<unknown>,
		options: { isolationLevel: string }
	) => {
		assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
		const previous = structuredClone(rows);
		try {
			return await callback({ parameter: delegate });
		} catch (error) {
			rows = previous;
			throw error;
		}
	}
});
Object.assign(authService, {
	fetchSessionData: async (token: string) => ({
		instance: "tenant-a",
		role: token === "admin" ? "ADMIN" : "USER",
		userId: 7
	})
});

async function run() {
	const key = "chat_auto_finish_enabled";
	rows = [
		{ id: 1, scope: "INSTANCE", instance: "tenant-b", sectorId: null, userId: null, key, value: "true" },
		{ id: 2, scope: "USER", instance: "tenant-a", sectorId: null, userId: 7, key, value: "true" },
		{
			id: 3,
			scope: "INSTANCE",
			instance: "tenant-a",
			sectorId: null,
			userId: null,
			key: "custom_integration",
			value: "keep"
		}
	];
	const change = { key, value: "true", previousValue: null };
	await settingsService.save("tenant-a", { changes: [change] });
	assert.equal(rows.length, 4);
	await assert.rejects(() => settingsService.save("tenant-a", { changes: [change] }), /outra pessoa/);
	assert.equal(rows.length, 4, "stale save must not create duplicates");
	await settingsService.save("tenant-a", { changes: [{ ...change, value: null, previousValue: "true" }] });
	assert.equal(rows.length, 3, "restore removes only this instance's override");
	assert.equal(rows.find((row) => row.key === "custom_integration")?.value, "keep");
	assert.equal(rows.find((row) => row.scope === "USER")?.value, "true");
	await assert.rejects(
		() => settingsService.save("tenant-a", { changes: [{ ...change, key: "is_official" }] }),
		/desconhecida/
	);
	await assert.rejects(() => settingsService.save("tenant-a", { changes: [{ ...change, value: "yes" }] }), /ativado/);
	await assert.rejects(
		() =>
			settingsService.save("tenant-a", {
				changes: [{ key: "chat_auto_finish_idle_time", value: "0", previousValue: null }]
			}),
		/intervalo/
	);
	await assert.rejects(
		() =>
			settingsService.save("tenant-a", {
				changes: [change, { key: "feature_ai_enabled", value: "true", previousValue: "stale" }]
			}),
		/outra pessoa/
	);
	assert.equal(rows.length, 3, "entire batch rolls back on conflict");

	const app = express();
	app.use(express.json());
	app.use(controller.router);
	app.use(handleRequestError as unknown as express.ErrorRequestHandler);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	try {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/whatsapp/parameter-settings`;
		for (const method of ["GET", "PATCH"]) {
			assert.equal((await fetch(url, { method })).status, 401);
			assert.equal((await fetch(url, { method, headers: { Authorization: "operator" } })).status, 403);
		}
		const response = await fetch(`${url}?instance=tenant-b`, { headers: { Authorization: "admin" } });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const data = (await response.json()) as { data: { values: Record<string, string | null> } };
		assert.equal(data.data.values[key], null, "query tenant must not override authenticated tenant");
		assert.equal(data.data.values["custom_integration"], undefined);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	console.log(
		"Parameter settings: validation, tenant isolation, authorization, restore and atomic batch tests passed"
	);
}

run()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		Object.assign(prisma.parameter, { findMany: originalFindMany });
		Object.assign(prisma, { $transaction: originalTransaction });
		Object.assign(authService, { fetchSessionData: originalSession });
		await prisma.$disconnect();
	});
