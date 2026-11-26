// Run from the whatsapp-service checkout with a deployment credential supplied by the DBA.
const mysql = require("mysql2/promise");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const src = "homolog-infotec-whatsapp-runtime";
const dst = "crm-sgr-infotec-prod";
const q = s => { assert.match(s, /^[A-Za-z0-9_-]{1,64}$/); return "\x60" + s + "\x60"; };
const fq = (db, name) => q(db) + "." + q(name);
const dest = n => "wpp_hml_" + n.replace(/^wpp_runtime_/, "");
const hold = n => "res26_" + n;
const bridge = n => "view26_" + n;
const modes = ["--inspect","--apply","--retire-origin"];
async function main() {
  const mode = process.argv[2];
  assert(modes.includes(mode), "Use --inspect, --apply or --retire-origin");
  const receiptFile = process.argv[3];
  if (mode !== "--inspect") assert(receiptFile, "Pass a private filename for the cutover receipt");
  assert(process.env.HOMOLOG_RESIDENCY_DBA_URL, "DBA deployment connection required");
  const c = await mysql.createConnection(process.env.HOMOLOG_RESIDENCY_DBA_URL);
  const rows = async (sql, args=[]) => (await c.query(sql,args))[0];
  let fenced = false, active = false;
  let names = [];
  const rename = pairs => c.query("RENAME TABLE " + pairs.map(([a,b]) => fq(src,a) + " TO " + fq(src,b)).join(","));
  try {
    const [identity] = await rows("SELECT @@server_uuid uuid,GET_LOCK('homolog-infotec-wa-residency',0) acquired");
    assert.equal(identity.uuid,"fa36075c-fd89-11ef-b8d7-bc241123d405");
    assert.equal(identity.acquired,1);
    const catalog = await rows("SELECT instance_name FROM `homolog-instances`.clients_servers WHERE instance_name='infotec' AND `database`=? AND host='127.0.0.1' AND port=3306",[dst]);
    assert.equal(catalog.length,1);
    await c.query("SET SESSION lock_wait_timeout=8,innodb_lock_wait_timeout=8,information_schema_stats_expiry=0,time_zone='+00:00'");
    if (mode === "--retire-origin") {
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      assert(receipt.server === identity.uuid && receipt.src === src && receipt.dst === dst && receipt.tables.length >= 61);
      const retained = await rows("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",[src]);
      assert.deepEqual(retained.map(r => r.n).sort(),receipt.tables.map(t=>hold(t.name)).sort());
      for (const {name,checksum} of receipt.tables) {
        assert(name === "admin_operation_receipts" || /^wpp_runtime_[A-Za-z0-9_]+$/.test(name));
        const [view] = await rows("SELECT IS_UPDATABLE u,SECURITY_TYPE s FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",[src,name]);
        assert(view && view.u==="YES" && view.s==="INVOKER",name);
        const usage = await rows("SELECT TABLE_SCHEMA db,TABLE_NAME n FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA=? AND VIEW_NAME=?",[src,name]);
        assert.deepEqual(usage.map(x=>[x.db,x.n]),[[dst,dest(name)]]);
        const [frozen] = await rows("CHECKSUM TABLE "+fq(src,hold(name))+" EXTENDED");
        assert.equal(String(frozen.Checksum),checksum);
      }
      const externalEdges = await rows("SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IN (?) AND (TABLE_SCHEMA<>? OR TABLE_NAME NOT IN (?))",[src,retained.map(t=>t.n),src,retained.map(t=>t.n)]);
      assert.equal(externalEdges.length,0);
      await c.query("SET FOREIGN_KEY_CHECKS=0");
      await c.query("DROP TABLE "+retained.map(t=>fq(src,t.n)).join(","));
      console.log(JSON.stringify({state:"ORIGIN_RETIRED",views:receipt.tables.length}));
      return;
    }
    names = (await rows("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",[src])).map(r=>r.n);
    assert(names.includes("admin_operation_receipts") && names.includes("wpp_runtime_waba_reaction_operations") &&
      names.every(n=>n==="admin_operation_receipts" || /^wpp_runtime_[A-Za-z0-9_]+$/.test(n)), "unexpected source or existing maintenance fence");
    const indexes = new Map(names.map(n=>[n,dest(n)]));
    const targetTables = await rows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,8)='wpp_hml_'",[dst]);
    assert.equal(targetTables.length,0,"Target namespace already populated. Reconcile the previous run before retrying.");
    const external = await rows("SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE (TABLE_SCHEMA=? AND REFERENCED_TABLE_SCHEMA<>?) OR (REFERENCED_TABLE_SCHEMA=? AND TABLE_SCHEMA<>?)",[src,src,src,src]);
    assert.equal(external.length,0);
    const triggers = await rows("SELECT TRIGGER_NAME n,EVENT_OBJECT_TABLE t,EVENT_MANIPULATION op,ACTION_TIMING timing,ACTION_STATEMENT body,SQL_MODE mode FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_ORDER",[src]);
    const rewrite = sql => sql.replace(/\b(?:wpp_runtime_\w+|admin_operation_receipts)\b/g, n=>indexes.get(n)||n);
    const ddls = [];
    const checksums = [];
    for (const n of names) {
      const [row] = await rows("SHOW CREATE TABLE "+fq(src,n));
      assert(row["Create Table"].includes("ENGINE=InnoDB"));
      const ddl = rewrite(row["Create Table"]).replace(/CONSTRAINT `([^`]+)`/g,(_,key)=>"CONSTRAINT "+q("wpp_hml_c_"+createHash("sha256").update(n+"/"+key).digest("hex").slice(0,24)));
      ddls.push(ddl);
    }
    console.log(JSON.stringify({mode,source:src,target:dst,tables:names.length,triggers:triggers.length}));
    if (mode==="--inspect") return;
    // DDL is additive on the target. Existing target names are rejected above.
    await c.query("USE "+q(dst));
    await c.query("SET FOREIGN_KEY_CHECKS=0");
    for (const ddl of ddls) await c.query(ddl);
    await c.query("SET FOREIGN_KEY_CHECKS=1");
    for (const n of names) {
      await c.query("GRANT SELECT,INSERT,UPDATE,DELETE,TRIGGER ON "+fq(dst,dest(n))+" TO 'homolog'@'%'");
      await c.query("CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW "+fq(src,bridge(n))+" AS SELECT * FROM "+fq(dst,dest(n)));
    }
    // Atomic fence. All writers lose the old names before the first row is copied.
    await rename(names.map(n=>[n,hold(n)]));
    fenced = true;
    await c.query("SET FOREIGN_KEY_CHECKS=0");
    await c.beginTransaction();
    for (const n of names) {
      const source = fq(src,hold(n)), target = fq(dst,dest(n));
      await c.query("INSERT INTO "+target+" SELECT * FROM "+source);
      const totals = await rows("SELECT (SELECT COUNT(*) FROM "+source+") a,(SELECT COUNT(*) FROM "+target+") b");
      assert.equal(String(totals[0].a),String(totals[0].b),n);
    }
    await c.commit();
    await c.query("SET FOREIGN_KEY_CHECKS=1");
    for (const n of names) {
      const [a,b] = await rows("CHECKSUM TABLE "+fq(src,hold(n))+","+fq(dst,dest(n))+" EXTENDED");
      assert(a.Checksum!=null && String(a.Checksum)===String(b.Checksum),n+" checksum");
      checksums.push({name:n,checksum:String(a.Checksum)});
      const [sequence] = await rows("SELECT AUTO_INCREMENT ai FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",[src,hold(n)]);
      if (sequence.ai!=null) {
        assert.match(String(sequence.ai),/^\d+$/);
        await c.query("ALTER TABLE "+fq(dst,dest(n))+" AUTO_INCREMENT="+sequence.ai);
      }
    }
    for (const t of triggers) {
      assert(["INSERT","UPDATE","DELETE"].includes(t.op) && ["AFTER","BEFORE"].includes(t.timing));
      assert(indexes.has(t.t));
      await c.query("SET SESSION sql_mode=?",[t.mode]);
      const name="wpp_hml_t_"+createHash("sha256").update(t.n).digest("hex").slice(0,24);
      await c.query("CREATE DEFINER='homolog'@'%' TRIGGER "+fq(dst,name)+" "+t.timing+" "+t.op+" ON "+fq(dst,dest(t.t))+" FOR EACH ROW "+rewrite(t.body));
    }
    writeFileSync(receiptFile, JSON.stringify({server:identity.uuid,src,dst,tables:checksums},null,2), { flag:"wx", mode:0o600 });
    await rename(names.map(n=>[bridge(n),n]));
    active = true;
    console.log(JSON.stringify({state:"ACTIVE",tables:names.length,verified:"checksum,count",retained:"res26_* for verified retirement"}));
  } catch (error) {
    await c.rollback().catch(()=>{});
    // Never roll back after consumers could have written through active views.
    if (fenced && !active) {
      const present = await rows("SELECT COUNT(*) AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (?)",[src,names]);
      if (Number(present[0].n)===0) await rename(names.map(n=>[hold(n),n]));
    }
    throw error;
  } finally { await c.end(); }
}
main().catch(e=>{console.error("Infotec cutover halted:", e.code || e.message);process.exitCode=1;});
