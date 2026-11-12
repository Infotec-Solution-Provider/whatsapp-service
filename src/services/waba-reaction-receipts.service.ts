import { randomUUID } from "node:crypto";
import { isWabaMessageId, wabaPhone } from "../utils/waba-reaction";
import { reactionEmoji } from "../utils/message-reaction";

/** Adapter around an already owned Prisma/MySQL connection, never a new pool. */
export interface WabaReactionReceiptDatabase {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: any[]): Promise<number>;
}
export interface PrepareWabaReaction {
  instance: string; clientId: number; targetMessageId: string; to: string; emoji: string;
  internalUserId?: number | null; internalUserName?: string | null;
}
export interface WabaReactionOperation {
  id: string; sequence: number; createdAt: string; instance: string; clientId: number; targetMessageId: string; to: string;
  emoji: string; providerMessageId: string | null; status: string;
}
export interface WabaReactionReceiptScope { clientId?: number; wabaAccountId?: string; phoneNumberId?: string }
export interface WabaReactionStatusResult {
  operationId: string; clientId: number; targetMessageId: string; status: string;
  changed: boolean; reactionChanged: boolean;
}

type Row = Record<string, any>;
type PreviousReaction = { emoji: string; sourceEventId: string | null; reactedAt: string; internalUserId: number | null; internalUserName: string | null };
const CALLBACK_PREFIX = "inpulse:reaction:";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const projection = "o.id,o.sequence,o.created_at AS createdAt,o.instance,o.client_id AS clientId,o.target_message_id AS targetMessageId,o.recipient_id AS `to`,o.emoji,o.provider_message_id AS providerMessageId,o.status,o.status_at AS statusAt,o.baseline_reaction_json AS baselineReactionJson,o.internal_user_id AS internalUserId,o.internal_user_name AS internalUserName";
const sqlDate = (value: Date) => value.toISOString().slice(0, 23).replace("T", " ");
const date = (value: unknown): Date => value instanceof Date ? value : new Date(typeof value === "string" ? value.replace(" ", "T") + (/Z$|[+-]\d\d:\d\d$/.test(value) ? "" : "Z") : NaN);
const previous = (row: Row | undefined): PreviousReaction | null => row ? {
  emoji: String(row["emoji"]), sourceEventId: row["source_event_id"] ?? null,
  reactedAt: date(row["reacted_at"]).toISOString(), internalUserId: row["internal_user_id"] ?? null,
  internalUserName: row["internal_user_name"] ?? null,
} : null;
function parsePrevious(raw: unknown): PreviousReaction | null {
  if (raw == null) return null;
  try {
    const row = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof row?.emoji !== "string" || !Number.isFinite(Date.parse(row.reactedAt))) return null;
    return { emoji: reactionEmoji(row.emoji), sourceEventId: typeof row.sourceEventId === "string" ? row.sourceEventId : null,
      reactedAt: row.reactedAt, internalUserId: Number.isSafeInteger(row.internalUserId) ? row.internalUserId : null,
      internalUserName: typeof row.internalUserName === "string" ? row.internalUserName : null };
  } catch { return null; }
}

/** prepare commits before POST. accept/applyStatus must run inside the caller's
 * transaction; publication/hydration must happen after that transaction commits. */
export class WabaReactionReceiptsService {
  constructor(private readonly db: WabaReactionReceiptDatabase, private readonly now: () => Date = () => new Date()) {}

  async prepare(input: PrepareWabaReaction): Promise<{ id: string; callbackData: string; sequence: number; createdAt: string }> {
    const to = wabaPhone(input.to), emoji = reactionEmoji(input.emoji);
    if (!input.instance || !Number.isSafeInteger(input.clientId) || input.clientId <= 0 || !isWabaMessageId(input.targetMessageId) || !to) throw Error("INVALID_WABA_REACTION_OPERATION");
    const [old] = await this.db.$queryRawUnsafe<Row[]>("SELECT emoji,source_event_id,reacted_at,internal_user_id,internal_user_name FROM message_reactions WHERE instance=? AND client_id=? AND target_message_id=? AND actor_id='self' LIMIT 1", input.instance, input.clientId, input.targetMessageId);
    let baseline = previous(old);
    if (baseline?.sourceEventId) {
      const synthetic = baseline.sourceEventId.startsWith("waba-reaction-ledger:") ? baseline.sourceEventId.slice("waba-reaction-ledger:".length) : null;
      const [owned] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.instance=? AND o.client_id=? AND o.target_message_id=? AND ${synthetic !== null ? "o.id" : "o.provider_message_id"}=? LIMIT 1`, input.instance, input.clientId, input.targetMessageId, synthetic ?? baseline.sourceEventId);
      if (owned) baseline = parsePrevious(owned["baselineReactionJson"]);
      else {
        // A rollback can restore a pre-ledger source with a newer UI version.
        // Keep its original event time instead of mistaking that version for
        // a newer external-device reaction which could block an in-flight send.
        const [last] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.instance=? AND o.client_id=? AND o.target_message_id=? ORDER BY o.sequence DESC LIMIT 1`, input.instance, input.clientId, input.targetMessageId);
        const original = parsePrevious(last?.["baselineReactionJson"]);
        if (original && original.sourceEventId === baseline.sourceEventId && original.emoji === baseline.emoji) baseline = original;
      }
    }
    const id = randomUUID(), at = sqlDate(this.now());
    await this.db.$executeRawUnsafe("INSERT INTO waba_reaction_operations(id,instance,client_id,target_message_id,recipient_id,emoji,status,baseline_reaction_json,internal_user_id,internal_user_name,created_at,updated_at) VALUES(?,?,?,?,?,?,'PREPARED',?,?,?,?,?)",
      id, input.instance, input.clientId, input.targetMessageId, to, emoji, JSON.stringify(baseline), input.internalUserId ?? null,
      input.internalUserName?.slice(0, 191) ?? null, at, at);
    const [row] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.id=? LIMIT 1 FOR UPDATE`, id);
    if (!row || !Number.isSafeInteger(Number(row["sequence"]))) throw Error("WABA_REACTION_ORDER_INVALID");
    return { id, callbackData: CALLBACK_PREFIX + id, sequence: Number(row["sequence"]), createdAt: date(row["createdAt"]).toISOString() };
  }

  async accept(id: string, providerMessageId: string): Promise<WabaReactionOperation & { reactionChanged: boolean }> {
    if (!UUID.test(id) || !isWabaMessageId(providerMessageId)) throw Error("INVALID_WABA_REACTION_RECEIPT");
    const [hint] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.id=? LIMIT 1`, id);
    if (!hint) throw Error("WABA_REACTION_OPERATION_NOT_FOUND");
    await this.lockTarget(hint);
    const [locked] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.id=? LIMIT 1 FOR UPDATE`, id);
    if (!locked || locked["providerMessageId"] !== null && locked["providerMessageId"] !== providerMessageId) throw Error("WABA_REACTION_RECEIPT_CONFLICT");
    const at = sqlDate(this.now());
    await this.db.$executeRawUnsafe("UPDATE waba_reaction_operations SET provider_message_id=?,status=CASE WHEN status IN ('PREPARED','UNKNOWN') THEN 'ACCEPTED' ELSE status END,accepted_at=COALESCE(accepted_at,?),updated_at=? WHERE id=? AND (provider_message_id IS NULL OR provider_message_id=?) AND status<>'REJECTED'", providerMessageId, at, at, id, providerMessageId);
    const [row] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.id=? LIMIT 1 FOR UPDATE`, id);
    if (!row || row["providerMessageId"] !== providerMessageId) throw Error("WABA_REACTION_RECEIPT_CONFLICT");
    return { ...row, sequence: Number(row["sequence"]), clientId: Number(row["clientId"]), createdAt: date(row["createdAt"]).toISOString(), reactionChanged: await this.materializeLatest(row) } as WabaReactionOperation & { reactionChanged: boolean };
  }

  async unknown(id: string): Promise<void> {
    await this.db.$executeRawUnsafe("UPDATE waba_reaction_operations SET status='UNKNOWN',updated_at=? WHERE id=? AND status='PREPARED'", sqlDate(this.now()), id);
  }

  async reject(id: string): Promise<void> {
    await this.db.$executeRawUnsafe("UPDATE waba_reaction_operations SET status='REJECTED',updated_at=? WHERE id=? AND status IN ('PREPARED','UNKNOWN')", sqlDate(this.now()), id);
  }

  async applyStatus(instance: string, item: any, scope: WabaReactionReceiptScope = {}): Promise<WabaReactionStatusResult | null> {
    const next = ({ sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" } as Record<string, string>)[item?.status];
    const recipient = wabaPhone(item?.recipient_id);
    if (!next || !isWabaMessageId(item?.id) || !recipient || !/^\d{10}$/.test(String(item?.timestamp))) return null;
    const occurredAt = new Date(Number(item.timestamp) * 1000);
    if (occurredAt.getTime() > this.now().getTime() + 300_000) return null;
    const callback = typeof item.biz_opaque_callback_data === "string" && item.biz_opaque_callback_data.startsWith(CALLBACK_PREFIX)
      ? item.biz_opaque_callback_data.slice(CALLBACK_PREFIX.length) : null;
    if (callback !== null && !UUID.test(callback)) return null;
    const conditions = ["o.instance=?", "o.recipient_id=?", "c.instance=o.instance", "c.type='WABA'", "c.waba_account_id IS NOT NULL", "c.waba_phone_id IS NOT NULL"], params: any[] = [instance, recipient];
    conditions.push(callback === null ? "o.provider_message_id=?" : "o.id=? AND (o.provider_message_id IS NULL OR o.provider_message_id=?)");
    params.push(...(callback === null ? [item.id] : [callback, item.id]));
    for (const [column, value] of [["o.client_id", scope.clientId], ["c.waba_account_id", scope.wabaAccountId], ["c.waba_phone_id", scope.phoneNumberId]] as const) if (value !== undefined) { conditions.push(column + "=?"); params.push(value); }
    const rows = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o JOIN clients c ON c.id=o.client_id WHERE ${conditions.join(" AND ")} LIMIT 2`, ...params);
    if (rows.length !== 1) return null;
    await this.lockTarget(rows[0]!);
    const [op] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.id=? LIMIT 1 FOR UPDATE`, rows[0]!["id"]);
    if (!op || op["providerMessageId"] !== null && op["providerMessageId"] !== item.id) return null;
    const rank: Record<string, number> = { PREPARED: 0, UNKNOWN: 0, ACCEPTED: 0, SENT: 1, DELIVERED: 2, READ: 3 };
    const changed = !["FAILED", "REJECTED"].includes(op["status"]) && (next === "FAILED" ? !["DELIVERED", "READ"].includes(op["status"]) : rank[next]! > (rank[op["status"]] ?? -1));
    if (!changed) return { operationId: op["id"], clientId: Number(op["clientId"]), targetMessageId: op["targetMessageId"], status: op["status"], changed: false, reactionChanged: await this.materializeLatest(op) };
    const at = sqlDate(this.now()), error = next === "FAILED" ? String(item.errors?.[0]?.code ?? "WABA_REACTION_FAILED").slice(0, 64) : null;
    const count = await this.db.$executeRawUnsafe("UPDATE waba_reaction_operations SET provider_message_id=?,status=?,status_at=?,error_code=?,updated_at=? WHERE id=? AND status=? AND (provider_message_id IS NULL OR provider_message_id=?)", item.id, next, sqlDate(occurredAt), error, at, op["id"], op["status"], item.id);
    if (count !== 1) return this.applyStatus(instance, item, scope);
    const reactionChanged = await this.materializeLatest(op);
    return { operationId: op["id"], clientId: Number(op["clientId"]), targetMessageId: op["targetMessageId"], status: next, changed: true, reactionChanged };
  }

  private async lockTarget(op: Row): Promise<void> {
    const rows = await this.db.$queryRawUnsafe<Row[]>("SELECT id FROM messages WHERE instance=? AND client_id=? AND waba_id=? LIMIT 1 FOR UPDATE", op["instance"], op["clientId"], op["targetMessageId"]);
    if (rows.length !== 1) throw Error("WABA_REACTION_TARGET_LOCK_REQUIRED");
  }

  private async materializeLatest(scope: Row): Promise<boolean> {
    const params = [scope["instance"], scope["clientId"], scope["targetMessageId"]];
    const [last] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.instance=? AND o.client_id=? AND o.target_message_id=? ORDER BY o.sequence DESC LIMIT 1 FOR UPDATE`, ...params);
    const [valid] = await this.db.$queryRawUnsafe<Row[]>(`SELECT ${projection} FROM waba_reaction_operations o WHERE o.instance=? AND o.client_id=? AND o.target_message_id=? AND o.provider_message_id IS NOT NULL AND o.status IN ('ACCEPTED','SENT','DELIVERED','READ') ORDER BY o.sequence DESC LIMIT 1 FOR UPDATE`, ...params);
    if (!last) return false;
    const external = parsePrevious(last["baselineReactionJson"]);
    const desired = valid && (!external || date(valid["createdAt"]).getTime() >= Date.parse(external.reactedAt)) ? {
      emoji: String(valid["emoji"]), sourceEventId: String(valid["providerMessageId"]), internalUserId: valid["internalUserId"] ?? null, internalUserName: valid["internalUserName"] ?? null,
    } : { emoji: external?.emoji ?? "", sourceEventId: external?.sourceEventId ?? "waba-reaction-ledger:" + last["id"], internalUserId: external?.internalUserId ?? null, internalUserName: external?.internalUserName ?? null };
    const [current] = await this.db.$queryRawUnsafe<Row[]>("SELECT emoji,source_event_id,reacted_at,internal_user_id,internal_user_name FROM message_reactions WHERE instance=? AND client_id=? AND target_message_id=? AND actor_id='self' LIMIT 1 FOR UPDATE", ...params);
    if (current && current["emoji"] === desired.emoji && current["source_event_id"] === desired.sourceEventId) return false;
    if (current?.["source_event_id"] && !String(current["source_event_id"]).startsWith("waba-reaction-ledger:") && date(current["reacted_at"]).getTime() > date(last["createdAt"]).getTime()) {
      const [owned] = await this.db.$queryRawUnsafe<Row[]>("SELECT id FROM waba_reaction_operations WHERE instance=? AND client_id=? AND target_message_id=? AND provider_message_id=? LIMIT 1 FOR UPDATE", ...params, current["source_event_id"]);
      if (!owned) return false;
    }
    const at = sqlDate(new Date(Math.max(this.now().getTime(), current ? date(current["reacted_at"]).getTime() + 1 : 0)));
    if (!current) {
      await this.db.$executeRawUnsafe("INSERT INTO message_reactions(id,instance,client_id,target_message_id,actor_id,from_me,emoji,reacted_at,received_at,source_event_id,internal_user_id,internal_user_name,created_at,updated_at) VALUES(?,?,?,?,'self',1,?,?,?,?,?,?,?,?)", randomUUID(), ...params, desired.emoji, at, at, desired.sourceEventId, desired.internalUserId, desired.internalUserName, at, at);
    } else {
      await this.db.$executeRawUnsafe("UPDATE message_reactions SET emoji=?,source_event_id=?,reacted_at=?,received_at=?,internal_user_id=?,internal_user_name=?,updated_at=? WHERE instance=? AND client_id=? AND target_message_id=? AND actor_id='self'", desired.emoji, desired.sourceEventId, at, at, desired.internalUserId, desired.internalUserName, at, ...params);
    }
    return true;
  }
}
