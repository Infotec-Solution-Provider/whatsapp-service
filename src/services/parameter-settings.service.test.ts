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
import instances from "./instances.service";
import targets from "./parameter-settings-targets.service";
import parametersService from "./parameters.service";

type Row = {
	id: number;
	scope: string;
	instance: string | null;
	sectorId: number | null;
	userId: number | null;
	key: string;
	value: string;
};
let rows: Row[] = [];
const whereMatches = (row: Row, where: Record<string, unknown>): boolean =>
	Object.entries(where).every(([key, value]) => {
		if (key === "OR") return (value as Record<string, unknown>[]).some((branch) => whereMatches(row, branch));
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
const originalSectorFirst = prisma.wppSector.findFirst;
const originalSectorMany = prisma.wppSector.findMany;
const originalQuery = instances.executeQuery;
const sectors = [
	{ id: 11, instance: "tenant-a", name: "Comercial" },
	{ id: 22, instance: "tenant-b", name: "Suporte" }
];
Object.assign(prisma.wppSector, {
	findFirst: async ({ where }: { where: { id: number; instance: string } }) =>
		sectors.find((sector) => sector.id === where.id && sector.instance === where.instance) ?? null,
	findMany: async ({ where }: { where: { instance: string } }) =>
		sectors.filter((sector) => sector.instance === where.instance)
});
Object.assign(instances, {
	executeQuery: async (instance: string, query: string, values: unknown[]) => {
		assert.ok(!query.includes("SELECT *"), "target queries must exclude credentials");
		const users =
			instance === "tenant-a"
				? [
						{ CODIGO: 7, NOME: "Ana", SETOR: 11, ATIVO: "SIM" },
						{ CODIGO: 8, NOME: "Bruno", SETOR: 999, ATIVO: "NAO" }
					]
				: [];
		return query.includes("WHERE CODIGO = ?") ? users.filter((user) => user.CODIGO === values[0]) : users;
	}
});
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

	const sectorTarget = { scope: "SECTOR", sectorId: 11 };
	const userTarget = { scope: "USER", userId: 7 };
	rows = [
		{ id: 1, scope: "INSTANCE", instance: "tenant-a", sectorId: null, userId: null, key, value: "true" },
		{ id: 2, scope: "SECTOR", instance: null, sectorId: 11, userId: null, key, value: "false" },
		{ id: 3, scope: "USER", instance: "tenant-b", sectorId: null, userId: 7, key, value: "false" }
	];
	const userSnapshot = await settingsService.get("tenant-a", userTarget);
	assert.equal(userSnapshot.values[key], null);
	assert.deepEqual(userSnapshot.inherited[key], { value: "false", source: "SECTOR" });
	assert.ok(
		!userSnapshot.catalog.some((setting) => setting.key === "require_supervisor_approval_for_contact_deletion")
	);
	assert.ok(!userSnapshot.catalog.some((setting) => setting.key === "customer_linking_bot_enabled"));
	assert.equal(
		(await settingsService.get("tenant-a", sectorTarget)).values[key],
		"false",
		"legacy sector rows remain editable"
	);
	await settingsService.save("tenant-a", {
		target: userTarget,
		changes: [{ key, value: "true", previousValue: null }]
	});
	assert.equal(
		(await parametersService.getSessionParams({ instance: "tenant-a", sectorId: 11, userId: 7 }))[key],
		"true"
	);
	await settingsService.save("tenant-a", {
		target: userTarget,
		changes: [{ key, value: null, previousValue: "true" }]
	});
	assert.equal(
		(await parametersService.getSessionParams({ instance: "tenant-a", sectorId: 11, userId: 7 }))[key],
		"false"
	);
	assert.equal(rows.find((row) => row.scope === "USER" && row.instance === "tenant-b")?.value, "false");
	await settingsService.save("tenant-a", {
		target: sectorTarget,
		changes: [{ key, value: null, previousValue: "false" }]
	});
	assert.deepEqual((await settingsService.get("tenant-a", userTarget)).inherited[key], {
		value: "true",
		source: "INSTANCE"
	});
	await settingsService.save("tenant-a", {
		target: sectorTarget,
		changes: [{ key, value: "false", previousValue: null }]
	});
	assert.equal(
		rows.find((row) => row.scope === "SECTOR")?.instance,
		"tenant-a",
		"new scoped records are tenant-bound"
	);
	await assert.rejects(
		() =>
			settingsService.save("tenant-a", {
				target: sectorTarget,
				changes: [{ key, value: "true", previousValue: null }]
			}),
		/outra pessoa/
	);
	for (const input of [
		{ scope: "SECTOR", sectorId: 22 },
		{ scope: "USER", userId: 999 },
		{ scope: "USER", userId: "1x" },
		{ scope: "USER", userId: 0 },
		{ scope: "OTHER" },
		{ scope: "INSTANCE", sectorId: 11 }
	])
		await assert.rejects(() => settingsService.get("tenant-a", input));
	await assert.rejects(
		() =>
			settingsService.save("tenant-a", {
				target: sectorTarget,
				changes: [
					{ key: "require_supervisor_approval_for_contact_deletion", value: "true", previousValue: null }
				]
			}),
		/escopo/
	);
	assert.deepEqual(
		await parametersService.getSectorParams("tenant-a", 22),
		[],
		"foreign sector cannot participate in session inheritance"
	);
	assert.equal(
		(await settingsService.get("tenant-a", { scope: "USER", userId: 8 })).inherited[key]!.source,
		"INSTANCE"
	);
	assert.deepEqual((await targets.list("tenant-a", "Ana")).users[0], { id: 7, name: "Ana", active: true });
	assert.deepEqual((await targets.list("tenant-a", "", "SECTOR")).users, []);
	rows.push({ id: 99, scope: "SECTOR", instance: null, sectorId: 11, userId: null, key, value: "true" });
	assert.equal(
		(await settingsService.get("tenant-a", sectorTarget)).values[key],
		"true",
		"latest legacy duplicate wins"
	);
	await settingsService.save("tenant-a", {
		target: sectorTarget,
		changes: [{ key, value: "false", previousValue: "true" }]
	});
	assert.deepEqual(
		rows.filter((row) => row.scope === "SECTOR" && row.sectorId === 11).map((row) => row.value),
		["false", "false"]
	);
	await settingsService.save("tenant-a", {
		target: sectorTarget,
		changes: [{ key, value: null, previousValue: "false" }]
	});
	assert.equal(
		rows.filter((row) => row.scope === "SECTOR" && row.sectorId === 11).length,
		0,
		"reset removes duplicates without leaving a hidden override"
	);

	const app = express();
	rows = rows.filter((row) => row.scope !== "INSTANCE" || row.instance !== "tenant-a");
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
		assert.equal(
			(await fetch(`${url}?scope=SECTOR&sectorId=22`, { headers: { Authorization: "admin" } })).status,
			400
		);
		for (const authorization of [undefined, "operator"]) {
			const response = await fetch(`${url}/targets`, {
				headers: authorization ? { Authorization: authorization } : {}
			});
			assert.equal(response.status, authorization ? 403 : 401);
		}
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
		Object.assign(prisma.wppSector, { findFirst: originalSectorFirst, findMany: originalSectorMany });
		Object.assign(instances, { executeQuery: originalQuery });
		await prisma.$disconnect();
	});
