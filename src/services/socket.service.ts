import "dotenv/config";
import { SocketServerClient } from "@in.pulse-crm/sdk";

const SOCKET_API_URL = process.env["SOCKET_API_URL"] || "http://localhost:8004";

export default new SocketServerClient(SOCKET_API_URL);
