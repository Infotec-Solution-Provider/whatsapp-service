import axios from "axios";
import "dotenv/config";

const WWEBJS_API_URL = process.env["WWEBJS_API_URL"] || "http://localhost:727";

export interface SessionInfo {
  phone: string;
  status: "open" | "close" | "connecting";
}

export interface ProbeStatus {
  received: boolean;
  receivedAt?: string;
}

const httpClient = axios.create({
  baseURL: `${WWEBJS_API_URL}/api`,
  timeout: 10_000,
});

async function getSessionInfo(): Promise<SessionInfo> {
  const { data } = await httpClient.get<SessionInfo>("/session/info");
  return data;
}

async function getProbeStatus(correlationId: string): Promise<ProbeStatus> {
  const { data } = await httpClient.get<ProbeStatus>(`/health/probe/${encodeURIComponent(correlationId)}`);
  return data;
}

async function forceReconnect(): Promise<void> {
  await httpClient.post("/session/reconnect");
}

const wwwebjsApiClient = { getSessionInfo, getProbeStatus, forceReconnect };
export default wwwebjsApiClient;
