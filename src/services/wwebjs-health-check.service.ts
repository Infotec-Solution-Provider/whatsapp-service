import { Logger } from "@in.pulse-crm/utils";
import { randomUUID } from "crypto";
import "dotenv/config";
import wwwebjsApiClient from "../utils/wwebjs-api-client";
import whatsappService from "./whatsapp.service";

const HEALTH_CHECK_CLIENT_ID = Number(process.env["WWEBJS_HEALTH_CHECK_CLIENT_ID"] || "0");
const PROBE_TIMEOUT_MS = Number(process.env["WWEBJS_HEALTH_PROBE_TIMEOUT_MS"] || "60000");
const PROBE_POLL_INTERVAL_MS = 5_000;

async function runHealthCheck(): Promise<void> {
  const correlationId = randomUUID();
  Logger.info(`[WwebjsHealthCheck] Starting health check | correlationId=${correlationId}`);

  // 1. Obter informações da sessão do wwebjs-api
  let sessionInfo: Awaited<ReturnType<typeof wwwebjsApiClient.getSessionInfo>>;
  try {
    sessionInfo = await wwwebjsApiClient.getSessionInfo();
  } catch (err: any) {
    Logger.error(`[WwebjsHealthCheck] Failed to reach wwebjs-api: ${err?.message}`);
    return;
  }

  const { phone, status } = sessionInfo;
  Logger.info(`[WwebjsHealthCheck] Session info | phone=${phone} status=${status}`);

  if (status !== "open") {
    Logger.warn(`[WwebjsHealthCheck] Session not open (status=${status}), skipping probe`);
    return;
  }

  if (!phone) {
    Logger.warn(`[WwebjsHealthCheck] No phone number available, skipping probe`);
    return;
  }

  // 2. Obter o client configurado para enviar a sonda
  const senderClient = whatsappService.getClient(HEALTH_CHECK_CLIENT_ID);
  if (!senderClient) {
    Logger.error(
      `[WwebjsHealthCheck] Client with id=${HEALTH_CHECK_CLIENT_ID} not found. ` +
      `Check WWEBJS_HEALTH_CHECK_CLIENT_ID env var.`
    );
    return;
  }

  // 3. Enviar a mensagem de sonda
  const probeText = `HEALTHPROBE:${correlationId}`;
  try {
    await senderClient.sendMessage({ to: phone, text: probeText });
    Logger.info(`[WwebjsHealthCheck] Probe sent | to=${phone} correlationId=${correlationId}`);
  } catch (err: any) {
    Logger.error(`[WwebjsHealthCheck] Failed to send probe message: ${err?.message}`);
    return;
  }

  // 4. Aguardar recebimento da sonda com polling
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  let received = false;

  while (Date.now() < deadline) {
    await sleep(PROBE_POLL_INTERVAL_MS);

    try {
      const probeStatus = await wwwebjsApiClient.getProbeStatus(correlationId);
      if (probeStatus.received) {
        received = true;
        Logger.info(
          `[WwebjsHealthCheck] Probe received successfully | correlationId=${correlationId} receivedAt=${probeStatus.receivedAt}`
        );
        break;
      }
    } catch (err: any) {
      Logger.warn(`[WwebjsHealthCheck] Error polling probe status: ${err?.message}`);
    }
  }

  // 5. Agir conforme resultado
  if (!received) {
    Logger.error(
      `[WwebjsHealthCheck] PROBE TIMEOUT — session appears stuck | correlationId=${correlationId} ` +
      `timeout=${PROBE_TIMEOUT_MS}ms. Forcing reconnect...`
    );
    try {
      await wwwebjsApiClient.forceReconnect();
      Logger.info(`[WwebjsHealthCheck] Reconnect command sent successfully`);
    } catch (err: any) {
      Logger.error(`[WwebjsHealthCheck] Failed to send reconnect command: ${err?.message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const wwwebjsHealthCheckService = { runHealthCheck };
export default wwwebjsHealthCheckService;
