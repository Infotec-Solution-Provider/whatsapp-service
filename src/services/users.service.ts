import "dotenv/config";
import { UsersClient } from "@in.pulse-crm/sdk";

const USERS_API_RL = process.env["USERS_API_RL"] || "http://localhost:8001";

function getUsersClient() {
  return new UsersClient(USERS_API_RL);
}

export default getUsersClient;
