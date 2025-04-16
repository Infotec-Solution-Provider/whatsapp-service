import { CustomersClient } from "@in.pulse-crm/sdk";

const CUSTOMERS_API_URL =
	process.env["CUSTOMERS_API_URL"] || "http://localhost:8002";

export default new CustomersClient(CUSTOMERS_API_URL);
