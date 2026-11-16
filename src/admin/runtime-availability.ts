import { AdminProtocolError, opaqueRevision, type AdminCommand, type AdminSnapshot } from "./admin-protocol";

export interface WhatsappRuntimeAvailability { tenantSql: boolean; prepared: boolean }
const unavailableReason = "WhatsApp e canais não estão habilitados para este tenant neste ambiente. Selecione outro tenant ou outra configuração.";

/** Do not query an absent runtime, provision it implicitly or infer receipt outcomes. */
export async function withWhatsappAdminRuntime<T>(
  command: AdminCommand,
  availability: WhatsappRuntimeAvailability,
  execute: () => Promise<T>,
): Promise<T | AdminSnapshot | { targets: never[]; hasMore: false; unavailableReason: string }> {
  if (!command.tenant) throw new AdminProtocolError(400, "Selecione o tenant.");
  if (!["whatsapp", "channels"].includes(command.source ?? "")) throw new AdminProtocolError(400, "Fonte WhatsApp inválida.");
  if (!availability.tenantSql || availability.prepared) return execute();
  if (command.action === "getSettings") {
    return {
      source: command.source!, tenant: command.tenant, ...(command.target ? { target: command.target } : {}),
      revision: opaqueRevision({ environment: command.environment, tenant: command.tenant, source: command.source, target: command.target ?? null }, { available: false, reason: "TENANT_NOT_PREPARED" }),
      catalog: [], values: {}, secrets: {}, resources: [], unavailableReason,
    };
  }
  if (command.action === "getTargets") return { targets: [], hasMore: false, unavailableReason };
  // A missing runtime cannot confirm that a past write did not happen.
  throw new AdminProtocolError(503, command.action === "getReceipt"
    ? "O runtime WhatsApp deste tenant está indisponível para confirmar a operação. A ação não será repetida automaticamente."
    : unavailableReason);
}
