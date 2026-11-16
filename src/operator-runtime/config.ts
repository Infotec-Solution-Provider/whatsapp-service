import fs from "node:fs";
import path from "node:path";
import { canonicalRuntimeInstance, unavailable, validInstance, OperatorRuntimeError } from "./core";
export interface OperatorRuntimeConfig {
	authority: "central-v1";
	instances: string[];
	signingKeyFile: string;
	customersApiUrl?: string;
	whatsappApiUrl?: string;
}
export const configPath = path.resolve(__dirname, "../../operator-runtime.config.json");
/** A server-owned profile, never a JWT/browser selector, decides the central authority. */
export function isCentralRuntimeConfigured(instance: string, file = configPath): boolean {
	const canonical=canonicalRuntimeInstance(instance);
	try { fs.lstatSync(file); }
	catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return false;return unavailable(); }
	try { return readRuntimeConfig(file).instances.includes(canonical); }
	catch { return unavailable(); }
}
export function readRuntimeConfig(file = configPath): OperatorRuntimeConfig {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new OperatorRuntimeError("OPERATOR_RUNTIME_NOT_CONFIGURED", 503);
	const config = JSON.parse(fs.readFileSync(file, "utf8")) as OperatorRuntimeConfig;
	if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(k => !["authority","instances","signingKeyFile","customersApiUrl","whatsappApiUrl"].includes(k)) || config.authority !== "central-v1" || !Array.isArray(config.instances) || config.instances.length > 100 || config.instances.some(x => !validInstance(x)) || new Set(config.instances).size !== config.instances.length || typeof config.signingKeyFile !== "string" || !path.isAbsolute(config.signingKeyFile)) throw new OperatorRuntimeError("OPERATOR_RUNTIME_NOT_CONFIGURED", 503);
	for (const field of ["customersApiUrl","whatsappApiUrl"] as const) {
		if (config[field] === undefined) continue;
		const url = new URL(config[field]);
		if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["127.0.0.1","localhost","[::1]"].includes(url.hostname)) throw new OperatorRuntimeError("OPERATOR_RUNTIME_NOT_CONFIGURED",503);
	}
	return config;
}
/** Reads only the new dedicated server-generated key, never any existing environment file. */
export function readRuntimeKey(config: OperatorRuntimeConfig): Buffer {
	const stat = fs.lstatSync(config.signingKeyFile);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32 || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new OperatorRuntimeError("OPERATOR_RUNTIME_NOT_CONFIGURED",503);
	return fs.readFileSync(config.signingKeyFile);
}
