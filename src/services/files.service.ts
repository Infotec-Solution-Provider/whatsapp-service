import { FilesClient } from "@in.pulse-crm/sdk";
import "dotenv/config";

const FILES_API_URL = process.env["FILES_API_URL"] || "http://localhost:8003";

export default new FilesClient(FILES_API_URL);