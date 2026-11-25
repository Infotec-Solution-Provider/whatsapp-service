import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AdminCommand, AdminMutationResult, AdminSnapshot } from "./admin-protocol";
import { withAdminActor } from "./settings-utils";

test("a channel revision accepts the same string and numeric IDs, but rejects changed settings", async (t) => {
  const revisionKey = process.env["ADMIN_REVISION_KEY"];
  process.env["ADMIN_REVISION_KEY"] = "test-only-channel-revision-key-with-enough-bytes";
  t.after(() => {
    if (revisionKey === undefined) delete process.env["ADMIN_REVISION_KEY"];
    else process.env["ADMIN_REVISION_KEY"] = revisionKey;
  });

  const id = 2000000003;
  let name = "Canal de teste";
  let requestHash: unknown;
  let reloads = 0;
  const database = {
    async $queryRawUnsafe(sql: string, ...params: unknown[]) {
      if (sql.startsWith("SELECT id,name AS label")) return [{ id, label: name }];
      if (sql.startsWith("SELECT id,")) {
        assert.deepEqual(params, [id, "infotec"]);
        return [{ id, name, isActive: false }];
      }
      if (sql.includes("information_schema.TABLES")) {
        return params.map(table => ({ name: table, engine: "InnoDB" }));
      }
      if (sql.startsWith("SELECT request_hash,result_json")) return [];
      if (sql.startsWith("SELECT request_hash FROM")) return [{ request_hash: requestHash }];
      assert.match(sql, /^SELECT 1 FROM /);
      return [];
    },
    async $executeRawUnsafe(sql: string, ...params: unknown[]) {
      if (sql.startsWith("INSERT INTO admin_operation_receipts")) requestHash = params[1];
      else assert.match(sql, /^UPDATE admin_operation_receipts /);
      return 1;
    },
  };

  function stub(path: string, exports: unknown) {
    const filename = require.resolve(path);
    const previous = require.cache[filename];
    require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
    t.after(() => {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    });
  }

  stub("../services/prisma.service", {
    ...database,
    $transaction: (run: (tx: typeof database) => Promise<unknown>) => run(database),
  });
  stub("../services/parameter-settings-targets.service", {});
  stub("../services/whatsapp.service", {
    async reloadClient(tenant: string, channelId: number) {
      assert.deepEqual([tenant, channelId], ["infotec", id]);
      reloads++;
    },
  });
  stub("../tenant-sql/registry", { tenantSqlEnabled: () => false });
  stub("../tenant-sql/router", { isTenantSqlTargetPrepared: () => false });

  const { whatsappSettings } = require("./settings") as typeof import("./settings");
  const get: AdminCommand = {
    action: "getSettings", environment: "homolog", tenant: "infotec", source: "channels",
    target: { resourceId: String(id) },
  };
  const saved = await whatsappSettings(get) as AdminSnapshot;
  const apply: AdminCommand = {
    ...get, action: "applySettings", operationId: randomUUID(), revision: saved.revision,
    target: { resourceId: id },
  };
  const actor = { instance: "infotec", userId: 1, role: "ADMIN", name: "Teste" } as const;
  const result = await withAdminActor(actor, () => whatsappSettings(apply)) as AdminMutationResult;
  assert.equal(result.application?.state, "applied");
  assert.equal(result.revision, saved.revision);
  assert.equal(reloads, 1);

  name = "Configuração alterada";
  await assert.rejects(withAdminActor(actor, () => whatsappSettings({ ...apply, operationId: randomUUID() })),
    { statusCode: 409 });
  assert.equal(reloads, 1);
});
