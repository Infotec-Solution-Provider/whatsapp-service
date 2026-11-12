import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseWabaReaction } from "../utils/waba-reaction";
export function mirrorEventRows(payload: any): any[][] {
 if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry) || payload.entry.length > 20) throw Error("INVALID_WEBHOOK");
 const events: any[][] = [];
 for (const entry of payload.entry) {
  if (!Array.isArray(entry.changes) || entry.changes.length > 20) throw Error("INVALID_WEBHOOK");
  for (const change of entry.changes) {
   if (change.field !== "messages") continue;
   for (const [kind, items] of [["message", change.value?.messages || []], ["status", change.value?.statuses || []]] as const) {
    if (!Array.isArray(items) || items.length > 100) throw Error("INVALID_WEBHOOK");
    for (const item of items) {
     if (typeof item.id !== "string" || !item.id || item.id.length > 191) throw Error("INVALID_WEBHOOK");
     const eventKind = kind === "message" && item.type === "reaction" ? "reaction" : kind;
     const scope = { accountId: entry.id, phoneNumberId: change.value?.metadata?.phone_number_id };
     if (eventKind === "reaction") {
      if (!/^\d{1,64}$/.test(scope.accountId || "") || !/^\d{1,64}$/.test(scope.phoneNumberId || "")) throw Error("INVALID_WEBHOOK");
      parseWabaReaction(1, item); // Validate the provider shape; channel ownership is checked by the worker.
     }
     const id = createHash("sha256").update(JSON.stringify([entry.id, scope.phoneNumberId, eventKind, item.id, item.status || "", item.timestamp])).digest("hex");
     events.push([id, eventKind === "reaction" ? item.reaction.message_id : item.id, eventKind,
      JSON.stringify({ ...item, _inpulseWabaScope: scope })]);
    }
   }
  }
 }
 if (events.length > 200) throw Error("INVALID_WEBHOOK"); return events;
}
export function createOdimCopyIngress(key: string, persist: (rows: any[][]) => Promise<void>, health: () => Promise<unknown>) {
 const handle = async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  if (req.url === "/health" && req.method === "GET") { res.end(JSON.stringify(await health())); return; }
  if (req.url !== "/odim-copy/webhooks" || req.method !== "POST") { res.writeHead(404); res.end("{}"); return; }
  const supplied = String(req.headers["x-odim-mirror-key"] || "");
  if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) { res.writeHead(401); res.end("{}"); return; }
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); length += b.length; if (length > 524288) { res.writeHead(413); res.end("{}"); return; } chunks.push(b); }
  let events: any[][];
  try { events = mirrorEventRows(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { res.writeHead(400); res.end("{}"); return; }
  await persist(events); res.end(JSON.stringify({ accepted: events.length, readOnly: true, providerProcessed: false }));
 };
 return (req: IncomingMessage, res: ServerResponse) => { void handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(503); res.end(JSON.stringify({ code: "COPY_INGRESS_RETRY" })); } else res.destroy(); }); };
}
