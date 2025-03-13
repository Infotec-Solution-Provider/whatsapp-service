import { AuthSDK } from "@in.pulse-crm/sdk";

const baseURL = process.env["SERVICE_AUTH_URL"];

if (!baseURL) {
	throw new Error("Missing .env variable SERVICE_AUTH_URL");
}

const authService = new AuthSDK({
	axiosConfig: {
		baseURL,
		timeout: Number(process.env["SERVICE_AUTH_TIMEOUT"]) || 10000
	}
});

export default authService;
