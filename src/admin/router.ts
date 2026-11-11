import { Router } from "express";
import { createAdminHandler } from "./admin-protocol";
import { whatsappSettings } from "./settings";
import { withAdminActor } from "./settings-utils";
import { processingLogs } from "./processing-logs";

export function createAdminRouter() {
  const router = Router();
  router.post("/api/internal/admin", createAdminHandler("whatsapp", async (command, context) => withAdminActor(context.actor, async () => {
    if (command.action === "listSources") return { sources: [{ id: "whatsapp", label: "Parâmetros e recursos WhatsApp", category: "WhatsApp", available: true }, { id: "channels", label: "Canais e credenciais", category: "WhatsApp", available: true }] };
    if (command.action === "getLogs") return processingLogs(command);
    return whatsappSettings(command);
  })));
  return router;
}
