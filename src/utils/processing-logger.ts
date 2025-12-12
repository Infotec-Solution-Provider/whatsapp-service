import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const LOGS_PATH = process.env["LOGS_PATH"] || "./logs";

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
				startTime: this.startTime.toISOString(),
				endTime: this.endTime!.toISOString(),
				duration: this.endTime!.getTime() - this.startTime.getTime(),
				logEntries: this.logEntries,
				input: this.input,
				output: this.output,
				error: this.error,
				errorMessage: sanitizeErrorMessage(this.error)
			};

			const logDir = this.error
				? path.join(LOGS_PATH, this.instance, this.processName, "errors")
				: path.join(LOGS_PATH, this.instance, this.processName);

		// Sanitize processId to remove invalid filename characters (especially colons on Windows)
		const sanitizedProcessId = this.processId.replace(/[<>:"/\\|?*]/g, '_');
		const logFileName = `${sanitizedProcessId}.json`;
			const logFilePath = path.join(logDir, logFileName);

			await mkdir(logDir, { recursive: true });
			await writeFile(logFilePath, JSON.stringify(logData, null, 2), {
				encoding: "utf-8"
			});
		} catch (err) {
			Logger.error("Failed to save log file", err as Error);
		}
	}
}
