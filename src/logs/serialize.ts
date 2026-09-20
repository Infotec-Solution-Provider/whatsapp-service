const SECRET_KEY = /password|passwd|senha|secret|token|authorization|cookie|api.?key|headers|config|request|socket/i;

export function redactText(text: string): string {
	return text.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/((?:password|senha|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s&,;"']+/gi, "$1[REDACTED]");
}

/** Bounded traversal, no custom toJSON/getters, preserves valid Unicode at limits. */
export function serializeLog(value: unknown, maxBytes = 32768): string {
	const seen = new WeakSet<object>();
	let nodes = 0;
	const visit = (item: unknown, depth: number): unknown => {
		if (++nodes > 500 || depth > 8) return "[TRUNCATED]";
		if (typeof item === "string") return redactText(Array.from(item.slice(0, 8000)).slice(0, 3999).join(""));
		if (typeof item === "bigint") return item.toString();
		if (item === null || typeof item === "boolean" || typeof item === "number") return item;
		if (typeof item !== "object") return null;
		if (seen.has(item)) return "[Circular]";
		seen.add(item);
		if (item instanceof Date) return Number.isNaN(item.getTime()) ? null : item.toISOString();
		if (Buffer.isBuffer(item)) return { binaryBytes: item.length };
		if (item instanceof Error) return { name: visit(item.name, depth + 1), message: visit(item.message, depth + 1), stack: visit(item.stack, depth + 1) };
		if (Array.isArray(item)) return item.slice(0, 50).map(element => visit(element, depth + 1));
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(item).slice(0, 50)) {
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Accessor]";
		}
		return output;
	};
	try {
		const encoded = JSON.stringify(visit(value, 0));
		if (Buffer.byteLength(encoded) <= maxBytes) return encoded;
		return JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(encoded) });
	} catch { return '{"serializationError":true}'; }
}
