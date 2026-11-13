import assert from "node:assert/strict";
import type { WppContact } from "@prisma/client";
import { createConnection } from "mysql2/promise";
import { buildContactCustomerResolutionQuery, ContactCustomerResolutionService } from "./contact-customer-resolution.service";

// Intentionally fixed disposable endpoints: this test never reads application environment/configuration.
const CRM = { host: "127.0.0.1", port: 13455, user: "root", password: "" };
const CENTRAL = { host: "127.0.0.1", port: 13418, user: "root", password: "" };
const database = "odim_flow_crm_qa_20261113_resolution";
if (!/^odim_flow_crm_qa_20261113_[a-z_]+$/.test(database) || CRM.host !== "127.0.0.1" || CRM.port !== 13455 || CENTRAL.host !== "127.0.0.1" || CENTRAL.port !== 13418) throw Error("UNSAFE_TEST_DATABASE");

async function main() {
	const crm = await createConnection(CRM), central = await createConnection(CENTRAL), concurrent = await createConnection(CENTRAL);
	try {
		for (const connection of [crm, central]) {
			await connection.query(`CREATE DATABASE IF NOT EXISTS ${database}`);
			await connection.query(`USE ${database}`);
		}
		await concurrent.query(`USE ${database}`);
		await crm.query("CREATE TABLE IF NOT EXISTS clientes (CODIGO INT PRIMARY KEY, AREA1 INT, AREA2 INT, AREA3 INT, FONE1 VARCHAR(32), FONE2 VARCHAR(32), FONE3 VARCHAR(32))");
		await crm.query("CREATE TABLE IF NOT EXISTS contatos (CODIGO INT PRIMARY KEY, CLIENTE INT, AREA_CEL VARCHAR(5), AREA_DIRETO VARCHAR(5), AREA_RESI VARCHAR(5), CELULAR VARCHAR(32), FONE_DIRETO VARCHAR(32), FONE_RESIDENCIAL VARCHAR(32))");
		await central.query("CREATE TABLE IF NOT EXISTS contacts (id INT PRIMARY KEY, instance VARCHAR(64), customer_id INT NULL, phone VARCHAR(32), whatsapp_id VARCHAR(32), is_deleted TINYINT DEFAULT 0, name VARCHAR(64))");
		await crm.query("DELETE FROM clientes");
		await crm.query("DELETE FROM contatos");
		await central.query("DELETE FROM contacts");
		const lookup = async (phone: string) => { const built = buildContactCustomerResolutionQuery(phone)!; const [rows] = await crm.execute(built.sql, built.params); return rows as Array<{ customer_id: number }>; };
		await crm.query("INSERT INTO clientes(CODIGO,AREA1,FONE1,AREA2,FONE2) VALUES (42,11,'(9) 8765-4321',11,'8765-4321'),(43,21,'2345-6789',NULL,NULL)");
		await crm.query("INSERT INTO contatos(CODIGO,CLIENTE,AREA_CEL,CELULAR) VALUES(90,999,'11','98765-4321'),(91,998,'31','99999-9999')");
		for (let i = 0; i < 20; i++) await crm.execute("INSERT INTO contatos(CODIGO,CLIENTE,AREA_CEL,CELULAR) VALUES(?,?,?,?)", [i + 1, 42, "11", "9 8765-4321"]);
		assert.deepEqual(await lookup("551187654321"), [{ customer_id: 42 }], "many rows for one customer remain one identity across both sources");
		await crm.query("INSERT INTO contatos(CODIGO,CLIENTE,AREA_RESI,FONE_RESIDENCIAL) VALUES(99,43,'11','98765-4321')");
		assert.deepEqual(await lookup("5511987654321"), [{ customer_id: 42 }, { customer_id: 43 }], "second distinct identity is not hidden after duplicate contact rows");
		assert.deepEqual(await lookup("5531999999999"), [], "orphan CRM contacts cannot create a customer link");
		await crm.query("DELETE FROM contatos WHERE CODIGO=99");
		await central.query("INSERT INTO contacts(id,instance,customer_id,phone,whatsapp_id,is_deleted,name) VALUES(8,'qa-tenant',NULL,'5511987654321','5511987654321',0,'Manual'),(9,'other-tenant',NULL,'5511987654321','5511987654321',0,'Other')");
		const getContact = async (instance: string, id: number) => {
			const [rows] = await central.execute("SELECT id,instance,customer_id customerId,phone,whatsapp_id whatsappId,is_deleted isDeleted,name FROM contacts WHERE id=? AND instance=?", [id, instance]);
			const row = (rows as WppContact[])[0];
			return row ? { ...row, isDeleted: Boolean(row.isDeleted) } : null;
		};
		let race = false, changePhone = false, syncs = 0;
		const resolver = new ContactCustomerResolutionService({
			sectorBelongsToInstance: async (instance, sectorId) => instance === "qa-tenant" && sectorId === 17,
			getContact,
			query: async (_instance, sql, params) => { const [rows] = await crm.execute(sql, params); return rows as Array<{ customer_id: number }>; },
			linkIfUnchanged: async (contact, customerId) => {
				if (race) await concurrent.execute("UPDATE contacts SET customer_id=99 WHERE id=8 AND instance='qa-tenant'");
				if (changePhone) await concurrent.execute("UPDATE contacts SET phone='5511999999999' WHERE id=8 AND instance='qa-tenant'");
				const [result] = await central.execute("UPDATE contacts SET customer_id=? WHERE id=? AND instance=? AND customer_id <=> ? AND phone <=> ? AND whatsapp_id <=> ? AND is_deleted=0", [customerId, contact.id, contact.instance, contact.customerId, contact.phone, contact.whatsappId]);
				return (result as { affectedRows: number }).affectedRows;
			},
			syncContact: async () => { syncs++; }
		});
		const scope = { instance: "qa-tenant", sectorId: 17 };
		for (const placeholder of [null, 0, -1]) {
			await central.execute("UPDATE contacts SET customer_id=?,phone='5511987654321' WHERE id=8", [placeholder]);
			assert.deepEqual((await resolver.resolve(scope, (await getContact(scope.instance, 8))!)).resolution, { status: "found", customerId: 42, reason: "linked" });
		}
		assert.equal(syncs, 3);
		await central.query("UPDATE contacts SET customer_id=NULL WHERE id=8");
		race = true;
		assert.deepEqual((await resolver.resolve(scope, (await getContact(scope.instance, 8))!)).resolution, { status: "found", customerId: 99, reason: "concurrent_link" });
		assert.equal(syncs, 3, "a separate connection's manual link wins the CAS");
		race = false; changePhone = true;
		await central.query("UPDATE contacts SET customer_id=NULL WHERE id=8");
		assert.equal((await resolver.resolve(scope, (await getContact(scope.instance, 8))!)).resolution.status, "unavailable");
		assert.equal((await getContact(scope.instance, 8))!.customerId, null);
		await crm.query("RENAME TABLE contatos TO contatos_unavailable");
		try {
			changePhone = false;
			await central.query("UPDATE contacts SET phone='5511987654321' WHERE id=8");
			assert.deepEqual((await resolver.resolve(scope, (await getContact(scope.instance, 8))!)).resolution, { status: "unavailable", reason: "lookup_unavailable" }, "one healthy source cannot turn a missing second source into found/not_found");
		} finally { await crm.query("RENAME TABLE contatos_unavailable TO contatos"); }
		const [identity] = await crm.query("SELECT VERSION() version");
		console.log(JSON.stringify({ result: "passed", crm: identity, states: ["found", "not_found", "ambiguous", "unavailable"], cas: "two connections preserve manual link/address change", limitation: "QA MySQL 5.5.62 differs from production 5.5.0-m2" }));
	} finally { await Promise.all([crm.end(), central.end(), concurrent.end()]); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
