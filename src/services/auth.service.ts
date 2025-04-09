import "dotenv/config";
import { AuthClient } from "@in.pulse-crm/sdk";

const INSTANCES_SERVICE_URL = process.env["AUTH_API_URL"] || "http://localhost:8001";

export default new AuthClient(INSTANCES_SERVICE_URL);
