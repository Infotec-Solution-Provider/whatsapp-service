import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { admit, handoff, providerEvents } from "./homolog-ingress";

test("ingresso persiste durante queda, deduplica, isola tenants e limpa somente após o commit", {
  skip: !process.env["HOMOLOG_INGRESS_TEST_PORT"]
}, async () => {
  const pool = createPool({ host:"127.0.0.1",port:Number(process.env["HOMOLOG_INGRESS_TEST_PORT"]),user:"root",
    database:"ingress_test",multipleStatements:true });
  try {
    await pool.query(readFileSync("prisma/tenant-sql/homolog-central-ingress.sql","utf8"));
    await pool.query("INSERT INTO homolog_ingress_routes VALUES ('WABA','infotec',11,UNHEX(SHA2('test-channel',256))),('WABA','suprimaxxi',11,UNHEX(SHA2('test-channel',256)))");
    const batch = { entry:[{ changes:[{value:{metadata:{phone_number_id:"test-channel"},messages:[{id:"one",text:"example"},{id:"two"}]}}]}] };
    const entries = providerEvents("WABA", batch);
    assert.equal(entries.length, 2);
    const initial = await admit("WABA","infotec",entries,pool);
    const repeat = await admit("WABA","infotec",entries,pool);
    assert.deepEqual(repeat.map(r => r.id),initial.map(r => r.id));
    assert.ok(repeat.every(r => !r.created));
    await assert.rejects(admit("WABA",undefined,entries,pool), /AMBIGUOUS/);
    await admit("WABA","suprimaxxi",entries,pool);
    await assert.rejects(handoff("WABA","infotec",pool));
    const [pending] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM ingress_waba WHERE payload IS NOT NULL");
    assert.equal(pending[0]?.["n"],4);
    await pool.query("CREATE DATABASE `homolog-infotec-whatsapp-runtime`");
    await pool.query("CREATE TABLE `homolog-infotec-whatsapp-runtime`.wpp_runtime_waba_webhook_queue (id CHAR(36) PRIMARY KEY,instance VARCHAR(64),payload JSON,status VARCHAR(32),retry_count INT,max_retries INT,created_at DATETIME(3),updated_at DATETIME(3))");
    await Promise.all([handoff("WABA","infotec",pool),handoff("WABA","infotec",pool)]);
    while(await handoff("WABA","infotec",pool)) { /* drain */ }
    const [result] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM ingress_waba WHERE instance='infotec' AND delivered_at IS NOT NULL AND payload IS NULL");
    assert.equal(result[0]?.["n"],2);
    const [dest] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM `homolog-infotec-whatsapp-runtime`.wpp_runtime_waba_webhook_queue");
    assert.equal(dest[0]?.["n"],2);
    assert.equal((await admit("WABA","infotec",entries,pool))[0]?.created,false);
    assert.equal(await handoff("WABA","infotec",pool),false);
    const [other] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM ingress_waba WHERE instance='suprimaxxi' AND payload IS NOT NULL");
    assert.equal(other[0]?.["n"],2);
  } finally { await pool.end(); }
});
