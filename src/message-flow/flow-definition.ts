export interface FlowStepDefinition {
	type: string;
	stepNumber: number;
	nextStepId?: number | null;
	fallbackStepId?: number | null;
	enabled?: boolean;
	config?: unknown;
	connections?: unknown;
}

export const DEFAULT_MESSAGE_FLOW_STEPS = [
	{ type: "CHECK_ONLY_ADMIN", stepNumber: 1, nextStepId: 2 },
	{ type: "CHECK_LOALTY", stepNumber: 2, nextStepId: 3 },
	{ type: "CHECK_AVAILABLE_USERS", stepNumber: 3, nextStepId: 4 },
	{ type: "SEND_TO_ADMIN", stepNumber: 4, nextStepId: null }
] as const;

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** These checks do not reject bounded/conditional cycles; the executor retains its iteration limit. */
export function validateFlowDefinition(steps: readonly FlowStepDefinition[]): string[] {
	const errors: string[] = [];
	const active = steps.filter((step) => step.enabled !== false);
	const numbers = new Set(active.map((step) => step.stepNumber));
	const edges = new Map<number, number[]>();
	if (!numbers.has(1)) errors.push("Flow must have an enabled step with stepNumber = 1");
	for (const step of active) {
		if (!positive(step.stepNumber)) errors.push("Step numbers must be positive integers");
		if (active.filter((other) => other.stepNumber === step.stepNumber).length !== 1)
			errors.push(`Duplicate step #${step.stepNumber}`);
		const target = (value: unknown, label: string) => {
			if (!positive(value) || !numbers.has(value)) errors.push(`Step #${step.stepNumber} has invalid ${label}`);
			else edges.set(step.stepNumber, [...(edges.get(step.stepNumber) ?? []), value]);
		};
		if (step.nextStepId !== undefined && step.nextStepId !== null) target(step.nextStepId, "next step");
		if (step.fallbackStepId !== undefined && step.fallbackStepId !== null) target(step.fallbackStepId, "fallback step");
		const connections = record(step.connections);
		if (step.connections !== undefined && step.connections !== null && !connections)
			errors.push(`Step #${step.stepNumber} connections must be an object`);
		if (step.type === "CONDITION" || step.type === "CHECK_USER_ONLINE") {
			for (const branch of ["onTrue", "onFalse"]) {
				target(connections?.[branch] ?? step.nextStepId, branch);
			}
		} else if (step.type === "ROUTER") {
			const routes = record(connections?.["routes"]);
			if (connections?.["routes"] !== undefined && !routes)
				errors.push(`Step #${step.stepNumber} routes must be an object`);
			for (const value of Object.values(routes ?? {})) target(value, "route");
			target(connections?.["defaultRoute"] ?? step.nextStepId, "default route");
		} else if (!["ASSIGN", "SEND_TO_ADMIN", "SEND_TO_SECTOR_USER"].includes(step.type)) {
			target(step.nextStepId, "continuation");
		}
	}
	const reachable = new Set<number>();
	const pending = [1];
	while (pending.length) {
		const number = pending.pop()!;
		if (reachable.has(number)) continue;
		reachable.add(number);
		pending.push(...(edges.get(number) ?? []));
	}
	if (!active.some((step) => reachable.has(step.stepNumber) && ["ASSIGN", "SEND_TO_ADMIN", "SEND_TO_SECTOR_USER", "CHECK_ONLY_ADMIN", "CHECK_LOALTY", "CHECK_AVAILABLE_USERS"].includes(step.type)))
		errors.push("Flow must contain a reachable assignment step");
	return [...new Set(errors)];
}

export function assertFlowDefinition(steps: readonly FlowStepDefinition[]): void {
	const errors = validateFlowDefinition(steps);
	if (errors.length) throw new Error(`Invalid message flow: ${errors.join("; ")}`);
}
