import { InstanceSDK } from "@in.pulse-crm/sdk";

const baseURL = process.env["INSTANCE_SERVICE_URL"];

if (!baseURL) {
	throw new Error("Missing .env variable INSTANCE_SERVICE_URL");
}

const instanceService = new InstanceSDK({
	axiosConfig: {
		baseURL,
		timeout: Number(process.env["INSTANCE_SERVICE_TIMEOUT"]) || 10000
	}
});

export default instanceService;
