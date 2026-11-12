export const MONITOR_WAIT_WARNING_KEY = "monitor:wait_warning_minutes";
export const MONITOR_WAIT_CRITICAL_KEY = "monitor:wait_critical_minutes";
export const MONITOR_WAIT_DEFAULTS = {
	[MONITOR_WAIT_WARNING_KEY]: 30,
	[MONITOR_WAIT_CRITICAL_KEY]: 1440
} as const;
export const MONITOR_WAIT_MAX_MINUTES = 525600;

export function isMonitorWaitThreshold(key: string): boolean {
	return key === MONITOR_WAIT_WARNING_KEY || key === MONITOR_WAIT_CRITICAL_KEY;
}

/** The caller supplies effective values after its ordinary scope inheritance. */
export function monitorWaitThresholdsError(values: Record<string, unknown>): string | null {
	const number = (key: keyof typeof MONITOR_WAIT_DEFAULTS) => {
		const value = values[key] ?? MONITOR_WAIT_DEFAULTS[key];
		if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return NaN;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MONITOR_WAIT_MAX_MINUTES ? parsed : NaN;
	};
	const warning = number(MONITOR_WAIT_WARNING_KEY), critical = number(MONITOR_WAIT_CRITICAL_KEY);
	if (!Number.isFinite(warning) || !Number.isFinite(critical))
		return `Os limites de espera devem ser números inteiros de 1 a ${MONITOR_WAIT_MAX_MINUTES} minutos.`;
	return critical > warning ? null : "O limite vermelho de espera deve ser maior que o limite amarelo.";
}
