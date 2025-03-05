import { AuthSDK } from "@in.pulse-crm/sdk";

const baseURL = process.env["AUTH_SERVICE_URL"];

if (!baseURL) {
	throw new Error("Missing .env variable AUTH_SERVICE_URL");
}

const authService = new AuthSDK({
	axiosConfig: {
		baseURL,
		timeout: Number(process.env["AUTH_SERVICE_TIMEOUT"]) || 10000
	}
});

export default authService;
