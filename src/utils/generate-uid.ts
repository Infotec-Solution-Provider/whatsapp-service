import { randomBytes } from "node:crypto";

const ALPHANUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomAlnum(length: number): string {
	const chars = ALPHANUM;
	const result: string[] = [];
	const base = chars.length; // 62
	const maxMultiple = Math.floor(256 / base) * base; // 248 para rejeição e evitar viés

	while (result.length < length) {
		const bytes = randomBytes(length);
		for (let i = 0; i < bytes.length && result.length < length; i++) {
			const b = bytes[i]!;
			if (b < maxMultiple) {
				result.push(chars[b % base]!);
			}
		}
	}
	return result.join("");
}

/**
 * Gera um identificador único: <timestamp_em_ms><8_alfa_num>
 * Ex.: 1696241234567AB12cdE3
 */
export default function generateUID(): string {
	const timestamp = Date.now().toString(); // apenas dígitos
	const suffix = randomAlnum(8); // 8 alfanuméricos
	return timestamp + suffix;
}
