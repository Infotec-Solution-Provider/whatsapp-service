import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withWhatsappAdminRuntime } from "./runtime-availability";
import { createTenantSqlRouter, isTenantSqlTargetPrepared } from "../tenant-sql/router";
import type { AdminCommand, AdminSnapshot } from "./admin-protocol";

process.env["ADMIN_REVISION_KEY"] = "availability-regression-key-longer-than-thirty-two";
async function main() {
  let calls = 0;
  const database = async () => { calls++; throw new Error("unprepared runtime must not execute database work"); };
  const base: AdminCommand = { action: "getSettings", environment: "homolog", tenant: "infotec", source: "whatsapp", target: { scope: "INSTANCE" } };
  for (const source of ["whatsapp", "channels"]) {
    const result = await withWhatsappAdminRuntime({ ...base, source }, { tenantSql: true, prepared: false }, database) as AdminSnapshot;
    assert.equal(result.tenant, "infotec"); assert.equal(result.source, source);
    assert.ok(result.unavailableReason); assert.deepEqual(result.catalog, []); assert.deepEqual(result.values, {});
    assert.deepEqual(result.secrets, {}); assert.equal(result.application, undefined);
    assert.ok(!JSON.stringify(result).includes("homolog-crm"));
    const targets = await withWhatsappAdminRuntime({ ...base, source, action: "getTargets" }, { tenantSql: true, prepared: false }, database);
    assert.deepEqual((targets as { targets: unknown[] }).targets, []);
    for (const action of ["saveSettings", "applySettings", "getReceipt"] as const) {
      await assert.rejects(withWhatsappAdminRuntime({ ...base, source, action, operationId: randomUUID(), revision: "r", changes: [{ key: "example", action: "set", value: false }] }, { tenantSql: true, prepared: false }, database), { statusCode: 503 });
    }
  }
  assert.equal(calls, 0);
  await assert.rejects(withWhatsappAdminRuntime({ ...base, source: "ai" }, { tenantSql: true, prepared: false }, database), { statusCode: 400 });
  await assert.rejects(withWhatsappAdminRuntime({ action: "getSettings", environment: "homolog", source: "whatsapp" }, { tenantSql: true, prepared: false }, database), { statusCode: 400 });
  const prepared = async () => { calls++; return { existing: true }; };
  assert.deepEqual(await withWhatsappAdminRuntime({ ...base, tenant: "homolog" }, { tenantSql: true, prepared: true }, prepared), { existing: true });
  assert.deepEqual(await withWhatsappAdminRuntime(base, { tenantSql: false, prepared: false }, prepared), { existing: true });
  assert.equal(calls, 2);
  const databaseFailure = new Error("prepared database unavailable");
  await assert.rejects(withWhatsappAdminRuntime({ ...base, tenant: "homolog" }, { tenantSql: true, prepared: true }, async () => { throw databaseFailure; }), error => error === databaseFailure);
  const clients = new Map<string, Record<string, unknown>>([["homolog", {}], ["suprimaxxi", {}]]);
  const router = createTenantSqlRouter(new Map(), clients);
  assert.equal(isTenantSqlTargetPrepared(router, "homolog"), true);
  assert.equal(isTenantSqlTargetPrepared(router, "suprimaxxi"), true);
  assert.equal(isTenantSqlTargetPrepared(router, "infotec"), false);
  assert.equal(isTenantSqlTargetPrepared({}, "homolog"), false);
  clients.set("added-after-start", {});
  assert.equal(isTenantSqlTargetPrepared(router, "added-after-start"), false);
  console.log("WhatsApp admin runtime: unavailable sources remain readable; no DB work or receipt inference; prepared and central targets preserved.");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
