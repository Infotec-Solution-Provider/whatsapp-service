import axios, { AxiosInstance } from "axios";
import "dotenv/config";

const DEFAULT_WWEBJS_API_URL = process.env["WWEBJS_API_URL"] || "http://localhost:727";

export interface SessionInfo {
  phone: string;
  status: "open" | "close" | "connecting";
}

export interface ProbeStatus {
  received: boolean;
  receivedAt?: string;
}

export interface WwebjsSessionDirectoryItem {
  sessionId: string;
  clientId: number;
  instance: string;
  library: "BAILEYS" | "ZAPO";
  enabled: boolean;
  isDefault: boolean;
  monitorGroupId: string | null;
  monitorRole: "PRIMARY" | "SHADOW";
  monitoringEnabled: boolean;
  runtimeStatus: string;
  available: boolean;
  lastError: string | null;
}

export interface WwebjsApiClient {
  listSessions(): Promise<WwebjsSessionDirectoryItem[]>;
  getSessionInfo(sessionId?: string): Promise<SessionInfo>;
  getProbeStatus(correlationId: string, sessionId?: string): Promise<ProbeStatus>;
  forceReconnect(sessionId?: string): Promise<void>;
}

function sessionPath(sessionId: string | undefined, suffix: string): string {
  return sessionId ? `/sessions/${encodeURIComponent(sessionId)}${suffix}` : suffix;
}

export function createWwebjsApiClient(baseUrl = DEFAULT_WWEBJS_API_URL): WwebjsApiClient {
  const httpClient: AxiosInstance = axios.create({
    baseURL: `${baseUrl.replace(/\/+$/, "")}/api`,
    timeout: 10_000,
  });

  return {
    async listSessions(): Promise<WwebjsSessionDirectoryItem[]> {
      const { data } = await httpClient.get<{ sessions: WwebjsSessionDirectoryItem[] }>("/sessions");
      return data.sessions || [];
    },

    async getSessionInfo(sessionId?: string): Promise<SessionInfo> {
      const { data } = await httpClient.get<SessionInfo>(sessionPath(sessionId, "/session/info"));
      return data;
    },

    async getProbeStatus(correlationId: string, sessionId?: string): Promise<ProbeStatus> {
      const path = sessionPath(sessionId, `/health/probe/${encodeURIComponent(correlationId)}`);
      const { data } = await httpClient.get<ProbeStatus>(path);
      return data;
    },

    async forceReconnect(sessionId?: string): Promise<void> {
      await httpClient.post(sessionPath(sessionId, "/session/reconnect"));
    },
  };
}

export default createWwebjsApiClient();
