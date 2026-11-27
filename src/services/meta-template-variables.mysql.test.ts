import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import mysql from "mysql2/promise";
import { createTenantSqlRouter } from "../tenant-sql/router";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import type { TemplateVariableSource } from "../utils/meta-template-variable-sources";
import type { DatabaseClient } from "./prisma.service";

const port = Number(process.env["META_TEMPLATE_VARIABLES_MYSQL_PORT"]);

test("template variable sources persist independently by tenant and WABA in both storage modes", { skip: !port }, async () => {
	assert.ok(port > 1024 && port !== 3306, "use a disposable MySQL fixture on a nonstandard loopback port");
	const schema = `meta_variables_test_${randomUUID().replaceAll("-", "")}`;
	const config = { host: "127.0.0.1", port, user: "root", password: "", connectionLimit: 4 };
	const root = mysql.createPool(config);
	const pool = mysql.createPool({ ...config, database: schema });
	const central = new PrismaClient({ datasourceUrl: `mysql://root@127.0.0.1:${port}/${schema}` });
	const fixture = createTenantSqlRouter(new Map([["fixture-a", pool], ["fixture-b", pool]])) as unknown as DatabaseClient;
	const path = require.resolve("./prisma.service");
	const previous = require.cache[path];
	let selected: DatabaseClient = fixture;

	try {
		await root.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		await pool.query(await readFile("prisma/tenant-sql/20261127151000_meta_template_variable_bindings.sql", "utf8"));
		await pool.query(await readFile("prisma/migrations/20261127151000_meta_template_variable_bindings/migration.sql", "utf8"));
		require.cache[path] = { id: path, filename: path, loaded: true, exports: {
			__esModule: true, get default() { return selected; }
		} } as NodeModule;
		const { loadTemplateVariableSources, saveTemplateVariableSources } = require("./meta-template-variables.service") as typeof import("./meta-template-variables.service");
		const body = "Seu pedido, {{1}}.\nRetire no balcão {{2}}.";
		const catalog = [{ id: "300", body }];
		const automatic: TemplateVariableSource[] = ["contato_primeiro_nome", "manual"];
		const manual: TemplateVariableSource[] = ["manual", "manual"];

		for (const db of [fixture, central]) {
			selected = db;
			assert.deepEqual(await Promise.all([
				saveTemplateVariableSources("fixture-a", "100", "300", body, manual),
				saveTemplateVariableSources("fixture-a", "100", "300", body, manual)
			]), [true, true]);
			assert.equal(await saveTemplateVariableSources("fixture-a", "100", "300", body, automatic), true);
			assert.equal(await saveTemplateVariableSources("fixture-b", "100", "300", body, manual), true);
			assert.equal(await saveTemplateVariableSources("fixture-a", "200", "300", body, manual), true);
			assert.equal(await withDatabaseTenant("fixture-b", () => saveTemplateVariableSources("fixture-a", "100", "300", body, manual)), false);

			assert.deepEqual((await loadTemplateVariableSources("fixture-a", "100", catalog)).get("300"), automatic);
			assert.deepEqual((await loadTemplateVariableSources("fixture-b", "100", catalog)).get("300"), manual);
			assert.deepEqual((await loadTemplateVariableSources("fixture-a", "200", catalog)).get("300"), manual);
			assert.deepEqual((await loadTemplateVariableSources("fixture-a", "100", [{ id: "300", body: ` ${body.replace("\n", "\r\n")} ` }])).get("300"), automatic);
			assert.equal((await loadTemplateVariableSources("fixture-a", "100", [{ id: "300", body: "Prazo: {{2}}. Pedido: {{1}}." }])).size, 0);
			assert.equal((await withDatabaseTenant("fixture-b", () => loadTemplateVariableSources("fixture-a", "100", catalog))).size, 0);
		}
	} finally {
		if (previous) require.cache[path] = previous;
		else delete require.cache[path];
		await central.$disconnect();
		await pool.end();
		await root.query(`DROP DATABASE IF EXISTS \`${schema}\``);
		await root.end();
	}
});
