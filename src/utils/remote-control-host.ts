/** Enrol exact host base URLs, including any reverse proxy prefix. Keep credentials off redirects and unrelated origins. */
export function remoteControlBase(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
		const path = url.pathname.replace(/\/+$/, "").replace(/\/sessions\/[^/]+$/, "");
		const candidate = url.origin + path;
		const enrolled = (process.env["WWEBJS_CONTROL_HOSTS"] || "").split(",").map(host => host.trim().replace(/\/+$/, ""));
		return enrolled.includes(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

export function businessChannelUrl(value: string, instance: string, clientId: number): string {
	const base = remoteControlBase(value);
	return base ? `${base}/channels/${encodeURIComponent(instance)}/${clientId}` : value;
}
