export const TRIAGE_FLAG = "enable_whatsapp_triage";

/** Only the explicitly tagged homolog process can enable every tenant in its own runtime. */
export function homologTriageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env["INPULSE_ENVIRONMENT"] === "homolog" &&
		env["TRIAGE_HOMOLOG_ENABLED"] === "true" &&
		(!env["name"] || env["name"] === "homolog-whatsapp")
	);
}
export function resolveTriageFlag(value: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	return homologTriageEnabled(env) || value === "true";
}
