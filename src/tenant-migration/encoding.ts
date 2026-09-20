export type TextProfile = "utf8mb4-native-v1" | "percent-encoded-v1";

function assertUnicode(value: string): void {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Unpaired Unicode surrogate");
		} else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Unpaired Unicode surrogate");
	}
}

export function encodeTenantText(value: string | null, profile: TextProfile): string | null {
	if (value === null) return null;
	assertUnicode(value);
	if (profile === "utf8mb4-native-v1") return value;
	if (profile === "percent-encoded-v1") return encodeURIComponent(value);
	throw new Error("Unknown text storage profile");
}

export function decodeTenantText(value: string | null, profile: TextProfile): string | null {
	if (value === null) return null;
	if (profile === "utf8mb4-native-v1") { assertUnicode(value); return value; }
	if (profile === "percent-encoded-v1") {
		let decoded: string;
		try { decoded = decodeURIComponent(value); } catch { throw new Error("Invalid encoded tenant text"); }
		assertUnicode(decoded); return decoded;
	}
	throw new Error("Unknown text storage profile");
}

export function transcodeTenantText(value: string | null, source: TextProfile, destination: TextProfile): string | null {
	return encodeTenantText(decodeTenantText(value, source), destination);
}
