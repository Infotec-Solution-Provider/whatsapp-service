import { InstanceSDK } from "@in.pulse-crm/sdk";

const baseURL = process.env["SERVICE_INSTANCES_URL"];

if (!baseURL) {
	throw new Error("Missing .env variable SERVICE_INSTANCES_URL");
}

const instanceService = new InstanceSDK({
	axiosConfig: {
		baseURL,
		timeout: Number(process.env["SERVICE_INSTANCES_TIMEOUT"]) || 10000
	}
});

export default instanceService;
