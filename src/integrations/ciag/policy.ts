import { createHash, createHmac, timingSafeEqual } from "crypto";
export function reject(message: string, status = 400): never {
	throw Object.assign(new Error(message), { status });
}
export function check(value: unknown, message: string, status = 400): asserts value {
	if (!value) reject(message, status);
}
export function string(value: unknown, max = 4096): string {
	check(typeof value === "string" && value.trim().length > 0 && value.length <= max, "Texto inválido.");
	return value.trim();
}
export function phone(value: unknown): string {
	const p = string(value, 20).replace(/^\+/, "");
	check(/^[1-9]\d{7,14}$/.test(p), "Número internacional inválido.");
	return p;
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function verifySignature(raw: Buffer, signature: unknown, secret: string): boolean {
	if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature) || !secret) return false;
	const expected = createHmac("sha256", secret).update(raw).digest();
	return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function openWindow(last: Date | null, now = Date.now()) {
	return Boolean(last && last.getTime() <= now && last.getTime() + 86_400_000 > now);
}
export function shouldApplyStatus(
	current: string,
	next: string,
	currentAt: number | null,
	nextAt: number | null
): boolean {
	if (currentAt !== null && nextAt !== null && nextAt < currentAt) return false;
	if (next === "ERROR") return !["RECEIVED", "READ", "DOWNLOADED", "REVOKED"].includes(current);
	if (current === "ERROR" && ["PENDING", "SENT"].includes(next)) return false;
	const rank: Record<string, number> = { PENDING: 0, SENT: 1, RECEIVED: 2, READ: 3, DOWNLOADED: 4, REVOKED: 5 };
	return (rank[next] ?? -1) >= (rank[current] ?? -1);
}
export function validateMedia(data: Buffer, mime: string) {
	const limits: Record<string, number> = {
		"image/jpeg": 5,
		"image/png": 5,
		"audio/ogg": 16,
		"audio/mpeg": 16,
		"audio/mp4": 16,
		"audio/aac": 16,
		"audio/amr": 16,
		"video/mp4": 16,
		"video/3gpp": 16,
		"application/pdf": 100,
		"text/plain": 100,
		"application/msword": 100,
		"application/vnd.ms-excel": 100,
		"application/vnd.ms-powerpoint": 100,
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": 100,
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 100,
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": 100
	};
	const max = limits[mime];
	check(max, "Formato não aceito pelo WhatsApp.");
	check(data.length > 0 && data.length <= max * 1024 * 1024, `O arquivo excede o limite de ${max} MB.`, 413);
	const start = data.subarray(0, 16),
		hex = start.toString("hex"),
		ascii = start.toString("ascii");
	const matches =
		mime === "image/png"
			? hex.startsWith("89504e470d0a1a0a")
			: mime === "image/jpeg"
				? hex.startsWith("ffd8ff")
				: mime === "application/pdf"
					? ascii.startsWith("%PDF-")
					: mime === "audio/ogg"
						? ascii.startsWith("OggS")
						: mime === "audio/mpeg"
							? ascii.startsWith("ID3") || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0)
							: mime.endsWith("/mp4") || mime === "video/3gpp"
								? ascii.slice(4, 8) === "ftyp"
								: mime === "audio/amr"
									? ascii.startsWith("#!AMR")
									: mime === "audio/aac"
										? data[0] === 0xff && ((data[1] ?? 0) & 0xf0) === 0xf0
										: mime.includes("openxmlformats")
											? ascii.startsWith("PK")
											: mime.startsWith("application/vnd.ms-") || mime === "application/msword"
												? hex.startsWith("d0cf11e0a1b11ae1")
												: !data.includes(0) &&
													!data.subarray(0, 1024).toString("utf8").includes("\ufffd");
	check(matches, "O conteúdo do arquivo não corresponde ao formato informado.");
}
