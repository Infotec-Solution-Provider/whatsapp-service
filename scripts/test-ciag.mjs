import { createConnection } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
if (!process.env.MYSQL_TEST_USER || !process.env.MYSQL_TEST_PASSWORD)
	throw new Error("Configure MYSQL_TEST_USER e MYSQL_TEST_PASSWORD em um servidor de testes.");
const database = "ciag_autotest_" + randomUUID().replaceAll("-", "");
const manager = await createConnection({
	host: process.env.MYSQL_TEST_HOST ?? "127.0.0.1",
	user: process.env.MYSQL_TEST_USER,
	password: process.env.MYSQL_TEST_PASSWORD
});
await manager.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
const url = new URL("mysql://localhost");
url.hostname = process.env.MYSQL_TEST_HOST ?? "127.0.0.1";
url.username = process.env.MYSQL_TEST_USER;
url.password = process.env.MYSQL_TEST_PASSWORD;
url.pathname = "/" + database;
const env = {
	...process.env,
	WHATSAPP_DATABASE_URL: url.href,
	CIAG_INTEGRATION_ENABLED: "true",
	NODE_ENV: "test",
	CACHE_PROVIDER: "memory"
};
try {
	const schema = spawnSync("npx", ["prisma", "db", "push", "--skip-generate"], { env, encoding: "utf8" });
	if (schema.status !== 0) throw new Error("Não foi possível criar o schema descartável de testes.");
	const test = spawnSync(
		process.execPath,
		process.env.CIAG_TEST_COMPILED_ENTRY
			? [process.env.CIAG_TEST_COMPILED_ENTRY]
			: ["-r", "ts-node/register/transpile-only", "src/integrations/ciag/service-mysql.test.ts"],
		{ env, stdio: "inherit", timeout: 120_000 }
	);
	process.exitCode = test.status ?? 1;
} finally {
	await manager.query(`DROP DATABASE \`${database}\``);
	await manager.end();
}
