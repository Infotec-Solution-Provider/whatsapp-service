import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { operatorCustomerMatchQuery, parseOperatorCustomerFilters } from "./operator-customer-filters";
import { parseScheduleQuery } from "./operator-schedules.contract";

const db = new DatabaseSync(":memory:");
after(() => db.close());
db.exec(`CREATE TABLE clientes (CODIGO INTEGER PRIMARY KEY,CPF_CNPJ TEXT,COD_ERP TEXT,CIDADE TEXT,ATIVO TEXT,PESSOA TEXT,EMAIL TEXT,ESTADO TEXT,SEGMENTO INTEGER,GRUPO INTEGER,ORIGEM INTEGER,COD_MIDIA INTEGER,COD_UNIDADE INTEGER,DATACAD TEXT,FONE1 TEXT,FONE2 TEXT,FONE3 TEXT,BLOCK_COMPRAS TEXT);
CREATE TABLE compras(CODIGO INTEGER,CLIENTE INTEGER,DATA TEXT);
CREATE TABLE clientes_marcas(CLIENTE INTEGER,MARCA INTEGER);
CREATE TABLE contatos(CLIENTE INTEGER,CARGO INTEGER);
CREATE TABLE campanhas_clientes(CLIENTE INTEGER,OPERADOR INTEGER,CONCLUIDO TEXT,DT_RESULTADO TEXT);
INSERT INTO clientes VALUES
(1,'12345678901','ERP%_!1','Porto Alegre','SIM','FIS','a@exa%mple.com','RS',1,10,100,2,3,'2026-11-13 23:59:59','(51) 1234-5678',NULL,NULL,'NAO'),
(2,'12345678902','ERP2','Florianopolis','NAO','JUR','b@example.com','SC',2,10,101,2,3,'2026-11-14 00:00:00',NULL,'+55 48 9876.5432',NULL,'NAO'),
(3,'12345678903','ERP3','Porto Alegre','SIM','JUR','c@example.com','RS',1,20,100,4,4,'2026-11-13 00:00:00',NULL,NULL,'51 1234-0000','SIM'),
(0,'00000000000','PUBLIC','Public','SIM','FIS',NULL,'RS',0,0,0,0,0,NULL,'000-000',NULL,NULL,'NAO'),
(-1,'11111111111','OLD','Old','SIM','FIS','old@example.com','PR',-1,-1,-1,-1,-1,'2026-11-12 12:00:00','111-111',NULL,NULL,NULL),
(10,'10101010101','OTHER','Other','SIM','JUR','other@example.com','SP',1,10,100,2,3,'2026-11-13 12:00:00','222-222',NULL,NULL,'NAO');
INSERT INTO compras VALUES(1,1,'2026-11-13'),(2,1,'2026-11-13'),(3,1,'2026-01-01'),(4,3,'2026-11-13'),(5,10,'2026-11-14');
INSERT INTO clientes_marcas VALUES(1,7),(1,7),(2,8),(3,7);
INSERT INTO contatos VALUES(1,9),(1,9),(2,10),(3,11);
INSERT INTO campanhas_clientes VALUES(1,7,'SIM','1969-12-31'),(1,7,'SIM','1969-12-31'),(2,0,'NAO','2026-11-13'),(3,7,'SIM','2026-11-13'),(-1,7,NULL,NULL);`);
// MySQL coerces a DATE column against the owner's midnight DATETIME bound.
// SQLite TEXT does not, so give date fixtures their equivalent midnight value.
db.exec("UPDATE compras SET DATA=DATA||' 00:00:00'");
const candidates = [-1, 0, 1, 2, 3, 10];
function run(filters: Record<string, string>, actor = { admin: false, allowed: true }, ids = candidates): number[] {
	const query = operatorCustomerMatchQuery(ids, parseOperatorCustomerFilters(filters), actor);
	const sql = query.sql
		.replace(/\/\*\+ MAX_EXECUTION_TIME\(5000\) \*\//g, "")
		.replace(/DATE_ADD\(\?, INTERVAL 1 DAY\)/g, "datetime(?, '+1 day')");
	return db
		.prepare(sql)
		.all(...(query.parameters as any[]))
		.map((row) => Number(row["CODIGO"]));
}

test("customer predicates use OR inside lists and AND across groups before any pagination", () => {
	assert.deepEqual(run({ segmentIds: "1,2", groupIds: "10" }), [1, 2, 10]);
	assert.deepEqual(
		run({ segmentIds: "1,2", groupIds: "10", originIds: "100", mediaIds: "2", unitIds: "3", states: "RS,SC" }),
		[1]
	);
	assert.deepEqual(run({ segmentIds: "0,-1" }), [-1, 0]);
});
test("relation predicates do not duplicate customers and loyalty follows CRM pending/historical rule", () => {
	assert.deepEqual(run({ brandIds: "7", positionIds: "9" }), [1]);
	assert.deepEqual(run({ loyaltyOperatorIds: "7" }), [1]);
	assert.deepEqual(run({ loyaltyOperatorIds: "0" }), [2]);
	assert.deepEqual(run({ brandIds: "7,8" }), [1, 2, 3]);
});
test("purchase periods are inclusive civil dates, dates alone imply EXISTS, without purchases means all history", () => {
	assert.deepEqual(run({ purchaseStatus: "with_purchases", purchaseFrom: "2026-11-13", purchaseTo: "2026-11-13" }), [
		1
	]);
	assert.deepEqual(run({ purchaseFrom: "2026-11-14" }), [10]);
	assert.deepEqual(run({ purchaseStatus: "without_purchases" }), [-1, 0, 2]);
	assert.deepEqual(run({ registeredFrom: "2026-11-13", registeredTo: "2026-11-13" }), [1, 3, 10]);
	assert.deepEqual(run({ registeredTo: "2026-11-12" }), [-1]);
});
test("financial permission and blocked-customer rules apply to positive and negative purchase inference", () => {
	for (const input of [
		{ purchaseStatus: "with_purchases" },
		{ purchaseStatus: "without_purchases" },
		{ purchaseFrom: "2026-11-13" }
	])
		assert.throws(
			() => run(input, { admin: false, allowed: false }),
			(error: any) => error.status === 403
		);
	assert.deepEqual(run({ purchaseStatus: "with_purchases" }), [1, 10]);
	assert.deepEqual(run({ purchaseStatus: "with_purchases" }, { admin: true, allowed: true }), [1, 3, 10]);
	assert.deepEqual(run({ segmentIds: "1" }, { admin: false, allowed: false }), [1, 3, 10]);
});
test("basic filters preserve CRM semantics: signed code substring, exact document/city, literal ERP and email", () => {
	assert.deepEqual(run({ CODIGO: "1" }), [-1, 1, 10]);
	assert.deepEqual(run({ CODIGO: "-1" }), [-1]);
	assert.deepEqual(run({ CPF_CNPJ: "123.456.789-01" }), [1]);
	assert.deepEqual(run({ CPF_CNPJ: "456" }), []);
	assert.deepEqual(run({ CIDADE: "Porto" }), []);
	assert.deepEqual(run({ CIDADE: "Porto Alegre", ATIVO: "SIM", PESSOA: "FIS" }), [1]);
	assert.deepEqual(run({ COD_ERP: "%_!" }), [1]);
	assert.deepEqual(run({ email: "@exa%" }), [1]);
});
test("phone matches the three normalized customer phones and cannot escape its predicate", () => {
	assert.deepEqual(run({ phone: "(51) 1234" }), [1, 3]);
	assert.deepEqual(run({ phone: "+55 (48) 9876-5432" }), [2]);
	assert.deepEqual(run({ phone: "0000" }), [0, 3]);
});
test("candidate boundary includes signed/zero CRM identities, excludes other customers and handles empty data", () => {
	assert.deepEqual(run({}, { admin: false, allowed: true }, [0, -1, 999]), [-1, 0]);
	assert.deepEqual(run({ segmentIds: "1" }, { admin: false, allowed: true }, []), []);
	assert.throws(() =>
		operatorCustomerMatchQuery(
			Array.from({ length: 201 }, (_, id) => id),
			parseOperatorCustomerFilters({}),
			{ admin: true, allowed: true }
		)
	);
});
test("invalid business filters fail even with no candidate customers", () => {
	for (const input of [
		{ purchaseStatus: "without_purchases", purchaseFrom: "2026-11-13" },
		{ purchaseFrom: "2026-02-30" },
		{ registeredFrom: "2026-11-14", registeredTo: "2026-11-13" },
		{ phone: "12" },
		{ email: "x".repeat(256) },
		{ states: "RS, SC" },
		{ states: "rs" },
		{ segmentIds: "1,,2" },
		{ groupIds: "2147483648" },
		{ loyaltyOperatorIds: "1.0" },
		{ positionIds: "1;DELETE" },
		{ PESSOA: "other" },
		{ ATIVO: "true" },
		{ CPF_CNPJ: "---" },
		{ CODIGO: "x" },
		{ page: "1" }
	])
		assert.throws(
			() => parseOperatorCustomerFilters(input),
			(error: any) => error.status === 400
		);
	assert.throws(() =>
		parseScheduleQuery(
			{ segmentIds: [1] },
			{ instance: "fixture", userId: 7, sectorId: 3, role: "ATIVO", name: "Fixture" },
			true
		)
	);
	assert.equal(
		parseScheduleQuery(
			{ view: "crm", loyaltyOperatorIds: "0,-1", customerCampaignIds: "0,-1" },
			{ instance: "fixture", userId: 7, sectorId: 3, role: "ATIVO", name: "Fixture" },
			true
		).loyaltyOperatorIds,
		"0,-1"
	);
});
