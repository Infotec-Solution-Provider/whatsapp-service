export interface BiRateLimits { maxRequests: number; maxConcurrent: number }
export interface BiTenantRateProfile extends BiRateLimits {
	instance: string;
	night?: BiRateLimits & { start: string; end: string; timeZone: string };
}

function validLimits(value: Record<string, unknown>): boolean {
	return Number.isSafeInteger(value["maxRequests"]) && Number(value["maxRequests"]) > 0 && Number(value["maxRequests"]) <= 10_000 &&
		Number.isSafeInteger(value["maxConcurrent"]) && Number(value["maxConcurrent"]) > 0 && Number(value["maxConcurrent"]) <= 32;
}

export function parseBiTenantRateProfiles(raw: string | undefined): BiTenantRateProfile[] {
	if (!raw?.trim()) return [];
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid PUBLIC_BI_RATE_PROFILES_JSON"); }
	if (!Array.isArray(parsed) || parsed.length > 128) throw new Error("Invalid BI rate profiles");
	const instances = new Set<string>();
	for (const profile of parsed) {
		if (!profile || typeof profile !== "object" || typeof profile.instance !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile.instance) || instances.has(profile.instance) || !validLimits(profile)) {
			throw new Error("Invalid BI tenant rate profile");
		}
		instances.add(profile.instance);
		if (profile.night !== undefined) {
			const night = profile.night;
			if (!night || typeof night !== "object" || !validLimits(night) ||
				typeof night.start !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(night.start) ||
				typeof night.end !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(night.end) || night.start === night.end ||
				typeof night.timeZone !== "string") throw new Error("Invalid BI night rate profile");
			try { new Intl.DateTimeFormat("en", { timeZone: night.timeZone }).format(new Date(0)); }
			catch { throw new Error("Invalid BI night timezone"); }
		}
	}
	return parsed as BiTenantRateProfile[];
}

export function resolveBiRateLimits(profile: BiTenantRateProfile | undefined, defaults: BiRateLimits, now: Date): BiRateLimits {
	if (!profile) return defaults;
	const night = profile.night;
	if (!night) return profile;
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: night.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
	}).formatToParts(now);
	const clock = `${parts.find(part => part.type === "hour")!.value}:${parts.find(part => part.type === "minute")!.value}`;
	const inWindow = night.start < night.end
		? clock >= night.start && clock < night.end
		: clock >= night.start || clock < night.end;
	return inWindow ? night : profile;
}
