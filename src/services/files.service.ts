import { FilesClient } from "@in.pulse-crm/sdk";
import "dotenv/config";

const FILES_API_URL = process.env["FILES_API_URL"] || "http://localhost:8003/api";

export default new FilesClient(FILES_API_URL);