import { randomUUID } from "node:crypto";
import { isWabaMessageId, parseWabaReaction, wabaPhone } from "../utils/waba-reaction";
import { isNewerMessageReaction, type ReactionView } from "./message-reactions.types";
import { WabaReactionReceiptsService, type WabaReactionReceiptDatabase } from "./waba-reaction-receipts.service";
import { applyOdimOwnedProviderStatus } from "./odim-copy-provider-status";

type MysqlConnection = { execute(sql: string, values?: any[]): Promise<any> };
type Row = Record<string, any>;
interface Channel { id: number; phone: string; waba_account_id: string; waba_phone_id: string }
export interface OdimMirrorReactionChange { clientId: number; targetMessageId: string }
export interface OdimMirrorReactionSnapshot {
  chatId: number; messageId: number; messageType: "wpp"; clientId: number;
  reaction: string; reactions: ReactionView[]; reactionsUpdatedAt: string | null;
}
const date = (value: unknown): Date => value instanceof Date ? value
  : new Date(typeof value === "string" ? value.replace(" ", "T") + (/Z$|[+-]\d\d:\d\d$/.test(value) ? "" : "Z") : NaN);
const sqlDate = (value: Date) => value.toISOString().slice(0, 23).replace("T", " ");

/** Adapts the worker's transaction-owned connection; never constructs Prisma or a pool. */
export function odimReactionDatabase(db: MysqlConnection): WabaReactionReceiptDatabase {
  return {
    $queryRawUnsafe: async <T>(sql: string, ...values: any[]) => (await db.execute(sql, values))[0] as T,
    $executeRawUnsafe: async (sql, ...values) => Number((await db.execute(sql, values))[0].affectedRows),
  };
}

function targetPeer(target: Row, ownPhone: string): string | null {
  const outbound = String(target["from"] || "").startsWith("me:");
  const ownSide = outbound ? target["from"] : target["to"];
  const peer = wabaPhone(outbound ? target["to"] : target["from"]);
  if (!peer || peer === ownPhone || typeof ownSide !== "string" || !ownSide.startsWith("me:") ||
    ownSide !== "me:odim-legacy-copy" && wabaPhone(ownSide.slice(3)) !== ownPhone) return null;
  return peer;
}

async function configuredChannel(db: MysqlConnection, clientId: number): Promise<Channel | null> {
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return null;
  const [rows] = await db.execute("SELECT id,phone,waba_account_id,waba_phone_id FROM clients WHERE id=? AND instance='odim' AND type='WABA' AND is_active=1 AND waba_account_id IS NOT NULL AND waba_phone_id IS NOT NULL LIMIT 1", [clientId]);
  const channel = rows[0];
  return channel && /^\d{1,64}$/.test(channel.waba_account_id || "") && /^\d{1,64}$/.test(channel.waba_phone_id || "") && wabaPhone(channel.phone) ? channel : null;
}

export function isOdimMirrorReaction(kind: string, item: any): boolean {
  return kind === "reaction" || kind === "message" && item?.type === "reaction";
}

/** Old queue rows point at the reaction's own ID; source catchup needs its target instead. */
export function odimMirrorSourceId(kind: string, item: any, providerId: string): string | null {
  if (kind === "status" && isReactionReceipt(item)) return null;
  return isOdimMirrorReaction(kind, item) ? isWabaMessageId(item?.reaction?.message_id) ? item.reaction.message_id : null : providerId;
}

const isReactionReceipt = (item: any) => typeof item?.biz_opaque_callback_data === "string" && item.biz_opaque_callback_data.startsWith("inpulse:reaction:");

/** The old authenticated mirror omitted metadata; only an existing proven target may authorize that format. */
export async function applyOdimMirrorReaction(
  db: MysqlConnection, kind: string, item: any, clientId: number, now = new Date(),
): Promise<OdimMirrorReactionChange | null> {
  const inbound = isOdimMirrorReaction(kind, item);
  if (!inbound && kind !== "status") return null;
  const channel = await configuredChannel(db, clientId);
  if (!channel) return null;
  const scope = item?._inpulseWabaScope;
  const scoped = scope && scope.accountId === channel.waba_account_id && scope.phoneNumberId === channel.waba_phone_id;
  const legacy = kind === "message" && inbound && scope === undefined;
  if (!scoped && !legacy) return null;
  if (!inbound) {
    const receipt = await new WabaReactionReceiptsService(odimReactionDatabase(db), () => now).applyStatus("odim", item, {
      clientId, wabaAccountId: channel.waba_account_id, phoneNumberId: channel.waba_phone_id,
    });
    return receipt ? { clientId: receipt.clientId, targetMessageId: receipt.targetMessageId } : null;
  }
  let event;
  try { event = parseWabaReaction(clientId, item, now.getTime()); } catch { return null; }
  if (!event.timestamp || event.timestamp > now.getTime() + 300_000 || wabaPhone(item.from) === wabaPhone(channel.phone)) return null;
  const [targets] = await db.execute("SELECT id,`from`,`to` FROM messages WHERE instance='odim' AND client_id=? AND waba_id=? LIMIT 2 FOR UPDATE", [clientId, event.targetMessageId]);
  if (targets.length > 1 || !targets.length && !scoped) return null;
  if (!targets.length) {
    const [foreign] = await db.execute("SELECT id FROM messages WHERE waba_id=? AND NOT(instance='odim' AND client_id=?) LIMIT 1", [event.targetMessageId, clientId]);
    if (foreign.length) return null;
  }
  if (targets.length && targetPeer(targets[0], wabaPhone(channel.phone)!) !== wabaPhone(item.from)) return null;
  const identity = ["odim", clientId, event.targetMessageId, event.actorId!];
  const reactedAt = new Date(event.timestamp), receivedAt = sqlDate(now);
  const [rows] = await db.execute("SELECT id,emoji,reacted_at FROM message_reactions WHERE instance=? AND client_id=? AND target_message_id=? AND actor_id=? LIMIT 1 FOR UPDATE", identity);
  const old = rows[0];
  if (!old) {
    await db.execute("INSERT INTO message_reactions(id,instance,client_id,target_message_id,actor_id,from_me,emoji,reacted_at,received_at,source_event_id,internal_user_id,internal_user_name,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?,NULL,NULL,?,?)", [randomUUID(), ...identity, event.reaction, sqlDate(reactedAt), receivedAt, event.reactionId, receivedAt, receivedAt]);
  } else if (isNewerMessageReaction({ emoji: event.reaction, reactedAt }, { emoji: old.emoji, reactedAt: date(old.reacted_at) })) {
    await db.execute("UPDATE message_reactions SET emoji=?,reacted_at=?,received_at=?,source_event_id=?,internal_user_id=NULL,internal_user_name=NULL,updated_at=? WHERE id=? AND instance=? AND client_id=? AND target_message_id=? AND actor_id=?", [event.reaction, sqlDate(reactedAt), receivedAt, event.reactionId, receivedAt, old.id, ...identity]);
  }
  return { clientId, targetMessageId: event.targetMessageId };
}

/** Keeps the queue decision and projection in one transaction, then notifies after commit. */
export async function processOdimMirrorWebhook(
  db: MysqlConnection & { beginTransaction(): Promise<unknown>; commit(): Promise<unknown>; rollback(): Promise<unknown> },
  event: { id: string; kind: string; payload: any }, clientId: number, sourceObserved: boolean,
  publish: {
    message(change: { id: number; changed: boolean; chatId: number | null }): Promise<unknown>;
    reaction(change: OdimMirrorReactionChange): Promise<unknown>;
  },
  now = new Date(),
): Promise<boolean> {
  const reactionReceipt = event.kind === "status" && isReactionReceipt(event.payload);
  let found = !isOdimMirrorReaction(event.kind, event.payload) && !reactionReceipt && sourceObserved;
  let reaction: OdimMirrorReactionChange | null = null;
  let statusChange = null;
  await db.beginTransaction();
  try {
    reaction = await applyOdimMirrorReaction(db, event.kind, event.payload, clientId, now);
    if (reaction) found = true;
    else if (!found && event.kind === "status" && !reactionReceipt) {
      statusChange = await applyOdimOwnedProviderStatus(db, event.payload);
      found = !!statusChange;
    }
    await db.execute("UPDATE odim_operational_copy_webhooks SET state=?,attempts=attempts+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [found ? "APPLIED" : "PENDING", event.id]);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; }
  if (statusChange) await publish.message(statusChange);
  if (reaction) await publish.reaction(reaction);
  return found;
}

/** Scope external actors to the target peer, including reactions stored before the target arrived. */
export async function odimReactionSnapshot(
  db: MysqlConnection, clientId: number, targetMessageId: string,
): Promise<OdimMirrorReactionSnapshot | null> {
  const channel = await configuredChannel(db, clientId);
  if (!channel) return null;
  const [targets] = await db.execute("SELECT id,chat_id,`from`,`to` FROM messages WHERE instance='odim' AND client_id=? AND waba_id=? LIMIT 2", [clientId, targetMessageId]);
  const target = targets.length === 1 ? targets[0] : null;
  if (!target?.chat_id) return null;
  const peer = targetPeer(target, wabaPhone(channel.phone)!);
  if (!peer) return null;
  const [rows] = await db.execute("SELECT actor_id,from_me,emoji,reacted_at,source_event_id,internal_user_id,internal_user_name FROM message_reactions WHERE instance='odim' AND client_id=? AND target_message_id=? AND ((from_me=1 AND actor_id='self') OR (from_me=0 AND actor_id=?)) ORDER BY reacted_at,actor_id", [clientId, targetMessageId, `${peer}@s.whatsapp.net`]);
  const reactions: ReactionView[] = [];
  let latest: number | null = null;
  for (const row of rows) {
    const occurredAt = date(row.reacted_at);
    if (!Number.isFinite(occurredAt.getTime())) continue;
    latest = Math.max(latest ?? -Infinity, occurredAt.getTime());
    if (!row.emoji) continue;
    const fromMe = Number(row.from_me) === 1;
    reactions.push({ actorId: row.actor_id, emoji: row.emoji, fromMe, reactedAt: occurredAt.toISOString(),
      ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
      ...(fromMe && row.internal_user_id ? { internalUserId: Number(row.internal_user_id), internalUserName: row.internal_user_name } : {}),
    });
  }
  return { chatId: Number(target.chat_id), messageId: Number(target.id), messageType: "wpp", clientId,
    reaction: reactions.map((reaction) => reaction.emoji).join(""), reactions,
    reactionsUpdatedAt: latest === null ? null : new Date(latest).toISOString(),
  };
}
