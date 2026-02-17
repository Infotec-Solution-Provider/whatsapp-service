import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import "dotenv/config";
import prismaService from "../services/prisma.service";

export default class ProcessingLogger {
	constructor(
		private readonly instance: string,
		public processName: string,
		private readonly processId: string,
		private readonly input: unknown
	) { }

	private readonly logEntries: Array<string> = new Array<string>();
	private readonly startTime: Date = new Date();
	private endTime: Date | null = null;
	private output: Array<any> = [];
	private error: unknown = null;

	public log(entry: string, output?: unknown): void {
		this.logEntries.push(`${new Date().toISOString()}: ${entry}`);
		if (output !== undefined) {
			this.output.push(output);
		}
	}

	public debug(entry: string, data?: unknown): void {
		const timestamp = new Date().toISOString();
		const debugEntry = data !== undefined 
			? `${timestamp}: [DEBUG] ${entry} ${JSON.stringify(data)}`
			: `${timestamp}: [DEBUG] ${entry}`;
		this.logEntries.push(debugEntry);
		
		// Também exibe no console para debugging em tempo real
		if (data !== undefined) {
			console.log(`[DEBUG] ${entry}`, data);
		} else {
			console.log(`[DEBUG] ${entry}`);
		}
	}

	public success(result: unknown): void {
		this.output.push(result);
		this.endTime = new Date();
		this.save();
	}

	public failed(err: unknown): void {
		this.error = err;
		if (err instanceof Error) {
			this.log("Processo finalizado com erro", {
				name: err.name,
				message: err.message,
				stack: err.stack
			});
		}
		this.endTime = new Date();
		this.save();
	}

	private safeStringify(value: unknown): string {
		try {
			const seen = new WeakSet<object>();
			return JSON.stringify(value, (_key, currentValue: unknown) => {
				if (typeof currentValue === "bigint") {
					return currentValue.toString();
				}

				if (currentValue instanceof Error) {
					const base: Record<string, unknown> = {
						name: currentValue.name,
						message: currentValue.message,
						stack: currentValue.stack
					};

					const extra = Object.getOwnPropertyNames(currentValue).reduce<Record<string, unknown>>(
						(acc, key) => {
							acc[key] = (currentValue as unknown as Record<string, unknown>)[key];
							return acc;
						},
						{}
					);

					return { ...base, ...extra };
				}

				if (typeof currentValue === "object" && currentValue !== null) {
					if (seen.has(currentValue)) {
						return "[Circular]";
					}
					seen.add(currentValue);
				}

				return currentValue;
			});
		} catch {
			return JSON.stringify({ serializationError: true, valueAsString: String(value) });
		}
	}

	private async save(): Promise<void> {
		try {
			const logData = {
				instance: this.instance,
				processName: this.processName,
				processId: this.processId,
				status: this.error ? "FAILED" : "SUCCESS",
				startTime: this.startTime,
				endTime: this.endTime!,
				duration: this.endTime!.getTime() - this.startTime.getTime(),
				input: this.safeStringify(this.input),
				output: this.safeStringify(this.output),
				error: this.safeStringify(this.error),
				errorMessage: sanitizeErrorMessage(this.error),
				logEntries: this.safeStringify(this.logEntries)
			};

			await prismaService.processLog.create({
				data: logData
			});
		} catch (err) {
			Logger.error("Failed to save process log to database", err as Error);
		}
	}
}
