import "dotenv/config";
import { UsersClient } from "@in.pulse-crm/sdk";

const USERS_API_RL = process.env["USERS_API_RL"] || "http://localhost:8001";

export default new UsersClient(USERS_API_RL);
