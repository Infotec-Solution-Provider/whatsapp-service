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
		this.endTime = new Date();
		this.save();
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
				input: JSON.stringify(this.input),
				output: JSON.stringify(this.output),
				error: JSON.stringify(this.error),
				errorMessage: sanitizeErrorMessage(this.error),
				logEntries: JSON.stringify(this.logEntries)
			};

			await prismaService.processLog.create({
				data: logData
			});
		} catch (err) {
			Logger.error("Failed to save process log to database", err as Error);
		}
	}
}
