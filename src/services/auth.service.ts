import "dotenv/config";
import { AuthClient } from "../sdk-local";

const AUTH_API_URL = process.env["AUTH_API_URL"] || "http://localhost:8001";

export default new AuthClient(AUTH_API_URL);
