import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request } from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { tenantSqlEnabled, validateRegistry } from "../tenant-sql/registry";
import { splitWabaWebhook } from "../utils/waba-reaction";

const queues = { WABA: "ingress_waba", GUPSHUP: "ingress_gupshup", REMOTE: "ingress_remote" } as const;
const targets = {
  suprimaxxi: "`homolog-crm-suprimaxxi`.",
  infotec: "`homolog-infotec-whatsapp-runtime`."
} as const;
type Provider = keyof typeof queues;
type Tenant = keyof typeof targets;
const providers = Object.keys(queues) as Provider[];
const tenants = Object.keys(targets) as Tenant[];
type EventInput = { route: string; key: string; transportKey: string; content: unknown; hash?: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
export function providerEvents(provider: "WABA" | "GUPSHUP", body: unknown): EventInput[] {
  return splitWabaWebhook(body).map((item: any) => {
    const change = item?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    const route = provider === "WABA" ? value?.metadata?.phone_number_id : item?.gs_app_id;
    if (typeof route !== "string" || !route) throw new Error("INGRESS_CHANNEL_REQUIRED");
    const status = value?.statuses?.[0], msg = value?.messages?.[0];
    const key = msg?.id ? canonical(["message", msg.id]) : status?.id && status?.status
      ? canonical(["status", status.id, status.status]) : digest(canonical(item));
    return { route, key, transportKey: key, content: item };
  });
}

const registryPath = process.env["WHATSAPP_TENANT_SQL_REGISTRY"];
export const centralIngressEnabled = Boolean(tenantSqlEnabled() && registryPath &&
  existsSync(join(dirname(registryPath), "homolog-central-ingress.enabled")));
// Official callbacks use the exact signed bytes; the homolog REMOTE simulators call
// the private port directly. A forwarded request must carry the configured credential.
export function ingressParser() {
  return express.json({ limit: "2gb", verify(request, _res, body) {
    const req = request as Request;
    const [provider, tenant] = req.originalUrl.split("?")[0]!.split("/").slice(3);
    if (provider === "remote" && ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") &&
      !["forwarded","x-forwarded-for","x-real-ip","x-forwarded-proto","x-forwarded-host"].some(h => req.headers[h] !== undefined) &&
      /^(127\.0\.0\.1|localhost):7105$/.test(req.headers.host ?? "")) return;
    const kind = provider === "meta" ? "gupshup" : provider;
    if (kind !== "remote" && kind !== "waba" && kind !== "gupshup") throw new Error("UNKNOWN_PROVIDER");
    if (kind !== "remote" && !tenants.includes(tenant as Tenant)) throw new Error("UNKNOWN_TENANT");
    const name = kind === "remote" ? "HOMOLOG_REMOTE_CALLBACK_TOKEN" : "HOMOLOG_" + kind.toUpperCase() + "_" + tenant!.toUpperCase() + "_SECRET";
    const secret = process.env[name];
    if (!secret) throw new Error("INGRESS_ORIGIN_UNCONFIGURED");
    const expected = kind === "waba" ? "sha256=" + createHmac("sha256", secret).update(body).digest("hex") : secret;
    const header = req.get(kind === "waba" ? "X-Hub-Signature-256" : "X-Inpulse-Webhook-Token") ?? "";
    if (!timingSafeEqual(Buffer.from(digest(header), "hex"), Buffer.from(digest(expected), "hex"))) throw new Error("INGRESS_ORIGIN_INVALID");
  }});
}
let pool: Pool | undefined;
function database(): Pool {
  if (!centralIngressEnabled || !registryPath) throw new Error("HOMOLOG_INGRESS_DISABLED");
  if (!pool) {
    const r = validateRegistry(JSON.parse(readFileSync(registryPath, "utf8")));
    pool = createPool({ host: r.host, port: r.port, user: r.user, database: r.sourceDatabase,
      password: readFileSync(r.credentialFile, "utf8").trim(), connectionLimit: 8, queueLimit: 32,
      connectTimeout: 3000, timezone: "Z", charset: "utf8mb4" });
  }
  return pool;
}

async function transaction<T>(source: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const c = await source.getConnection();
  try {
    await c.beginTransaction();
    const result = await work(c);
    await c.commit();
    return result;
  } catch (err) {
    try { await c.rollback(); } catch { c.destroy(); }
    throw err;
  } finally { c.release(); }
}

export class IngressConflict extends Error {}
export async function admit(provider: Provider, instance: string | undefined, entries: EventInput[], source = database()) {
  if (instance !== undefined && !tenants.includes(instance as Tenant)) throw new Error("UNKNOWN_INGRESS_TENANT");
  return transaction(source, async c => {
    const receipts = [];
    for (const event of entries) {
      const [routes] = await c.query<RowDataPacket[]>(
        "SELECT instance,client_id FROM homolog_ingress_routes WHERE provider=? AND route_hash=UNHEX(SHA2(?,256))" +
        (instance === undefined ? "" : " AND instance=?") + " LIMIT 2 FOR SHARE",
        instance === undefined ? [provider,event.route] : [provider,event.route,instance]);
      const owner = routes[0];
      if (routes.length !== 1 || !owner || !tenants.includes(owner["instance"])) throw new Error("UNKNOWN_OR_AMBIGUOUS_INGRESS_CHANNEL");
      const table = queues[provider], id = randomUUID();
      const hash = event.hash ?? digest(canonical(event.content));
      const scope = [owner["instance"], owner["client_id"]];
      await c.execute(`INSERT INTO ${table}(id,instance,client_id,event_key,transport_key,payload_hash,payload)
        VALUES(?,?,?,UNHEX(?),UNHEX(?),UNHEX(?),?) ON DUPLICATE KEY UPDATE seq=seq`,
        [id,...scope,digest(event.key),digest(event.transportKey),hash,JSON.stringify(event.content)]);
      const [matches] = await c.query<RowDataPacket[]>(`SELECT id,delivered_at,HEX(event_key) ek,HEX(transport_key) tk,HEX(payload_hash) ph
        FROM ${table} WHERE instance=? AND client_id=? AND (event_key=UNHEX(?) OR transport_key=UNHEX(?)) FOR UPDATE`,
        [...scope,digest(event.key),digest(event.transportKey)]);
      const row = matches[0];
      if (matches.length !== 1 || !row || row["ek"].toLowerCase() !== digest(event.key) ||
        (provider === "REMOTE" && row["tk"].toLowerCase() === digest(event.transportKey) && row["ph"].toLowerCase() !== hash))
        throw new IngressConflict("INGRESS_IDENTITY_CONFLICT");
      receipts.push({ id: String(row["id"]), created: row["id"] === id, handedOff: row["delivered_at"] != null,
        tenant: owner["instance"] as Tenant });
    }
    return receipts;
  });
}

// A duplicate already delivered to the tenant retains the REMOTE HTTP contract:
// only a finished domain event can receive a COMPLETED response. During an outage
// the durable central receipt is sufficient for an accepted response.
export async function remoteReceiptCompleted(tenant: Tenant, client: number, eventType: string, providerId: string): Promise<boolean> {
  try {
    const [rows] = await database().query<RowDataPacket[]>({ sql:
      "SELECT status FROM " + targets[tenant] + "wpp_runtime_remote_inbound_event_inbox WHERE client_id=? AND event_type=? AND provider_message_id=?",
      timeout: 1500 }, [client,eventType,providerId]);
    return rows[0]?.["status"] === "COMPLETED";
  } catch { return false; }
}

// Both schemas share the homolog MySQL server. InnoDB commits the tenant queue entry and
// erasure of the central payload together. A lost commit reply is safe to reconcile by ID.
export async function handoff(provider: Provider, tenant: Tenant, source = database()): Promise<boolean> {
  return transaction(source, async c => {
    const table = queues[provider];
    const [rows] = await c.query<RowDataPacket[]>(`SELECT id,client_id,payload,HEX(payload_hash) ph FROM ${table}
      WHERE instance=? AND delivered_at IS NULL ORDER BY seq LIMIT 1 FOR UPDATE`, [tenant]);
    const row = rows[0];
    if (!row) return false;
    const id = row["id"], client = row["client_id"];
    const input = typeof row["payload"] === "string" ? JSON.parse(row["payload"]) : row["payload"];
    const target = targets[tenant] + "wpp_runtime_";
    if (provider === "REMOTE") {
      const inbox = target + "remote_inbound_event_inbox";
      const { payload, key, providerId, eventType } = input;
      const [prior] = await c.query<RowDataPacket[]>(`SELECT id,payload_hash,idempotency_key,client_id,event_type,provider_message_id FROM ${inbox}
        WHERE idempotency_key=? OR (client_id=? AND event_type=? AND provider_message_id=?) FOR UPDATE`, [key,client,eventType,providerId]);
      if (prior.length) {
        const existing = prior[0]!;
        if (prior.length !== 1 || existing["client_id"] !== client || existing["event_type"] !== eventType ||
          existing["provider_message_id"] !== providerId || (existing["idempotency_key"] === key &&
          existing["payload_hash"] !== row["ph"].toLowerCase())) throw new IngressConflict("TENANT_RECEIPT_CONFLICT");
      } else {
        await c.execute(`INSERT INTO ${inbox}(id,idempotency_key,client_id,event_type,provider_message_id,payload_hash,payload,status,retry_count,max_retries,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'PENDING',0,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
          [id,key,client,eventType,providerId,row["ph"].toLowerCase(),JSON.stringify(payload)]);
      }
    } else {
      const inbox = target + (provider === "WABA" ? "waba_webhook_queue" : "gupshup_webhook_queue");
      await c.execute(`INSERT INTO ${inbox}(id,instance,payload,status,retry_count,max_retries,created_at,updated_at)
        VALUES(?,?,?,'PENDING',0,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [id,tenant,JSON.stringify(input),provider === "WABA" ? Number(process.env["WABA_WEBHOOK_MAX_RETRIES"] || 30) : 3]);
    }
    await c.execute(`UPDATE ${table} SET delivered_at=UTC_TIMESTAMP(3),payload=NULL WHERE id=?`,[id]);
    return true;
  });
}

let timer: NodeJS.Timeout | undefined;
const running = new Set<string>();
const retryAt = new Map<string, number>();
export function startCentralIngress(): void {
  if (!centralIngressEnabled || timer) return;
  timer = setInterval(() => {
    for (const tenant of tenants) for (const provider of providers) {
      const key = tenant + "/" + provider;
      if (running.has(key) || (retryAt.get(key) ?? 0) > Date.now()) continue;
      running.add(key);
      void (async () => {
        for (let i = 0; i < 16 && await handoff(provider,tenant); i++) { /* bounded batch */ }
      })().catch(() => { retryAt.set(key, Date.now() + 10000); console.error("[homolog-ingress] handoff pending", key); })
        .finally(() => running.delete(key));
    }
  }, 1000);
  timer.unref();
}
export async function stopCentralIngress(): Promise<void> {
  clearInterval(timer);
  timer = undefined;
  await pool?.end();
}
