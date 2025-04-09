import "dotenv/config";
import { InstancesClient } from "@in.pulse-crm/sdk";

const INSTANCES_API_URL = process.env["INSTANCES_API_URL"] || "http://localhost:8000";

export default new InstancesClient(INSTANCES_API_URL);
