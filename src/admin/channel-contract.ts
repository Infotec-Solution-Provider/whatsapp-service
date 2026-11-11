import { AdminProtocolError } from "./admin-protocol";

export function validateChannel(next: Record<string, unknown>): void {
  if (typeof next["name"] !== "string" || !next["name"].trim() || next["name"].length > 191) throw new AdminProtocolError(400, "Nome do canal inválido.");
  if (!["WABA", "GUPSHUP", "REMOTE", "WWEBJS"].includes(String(next["type"]))) throw new AdminProtocolError(400, "Provedor inválido.");
  if (next["isActive"] === true || next["isActive"] === "true" || next["isActive"] === 1) {
    const required = next["type"] === "WABA" ? ["WABAPhoneId", "WABAAccountId", "WABAToken"] : next["type"] === "GUPSHUP" ? ["gupshupToken", "gupshupAppName", "gupshupAppId"] : next["type"] === "REMOTE" ? ["remoteClientUrl"] : [];
    if (required.some(key => typeof next[key] !== "string" || !String(next[key]).trim())) throw new AdminProtocolError(400, "Preencha as credenciais obrigatórias do provedor antes de ativar o canal.");
  }
  if (next["remoteClientUrl"]) { try { const url = new URL(String(next["remoteClientUrl"])); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); } catch { throw new AdminProtocolError(400, "URL remota inválida."); } }
}
