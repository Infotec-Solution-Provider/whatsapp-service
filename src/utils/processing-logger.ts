import "dotenv/config";
import processLogs, { ProcessLogRecord } from "../logs/service";
import { redactText, serializeLog } from "../logs/serialize";

/** Snapshot payloads so completed loggers cannot retain request graphs. */
export default class ProcessingLogger {
	private readonly startTime = new Date();
	private readonly logEntries: string[] = [];
	private readonly outputs: string[] = [];
	private readonly input: string;
	private finished = false;

	constructor(private readonly instance: string, public processName: string, private readonly processId: string, input: unknown) {
		this.input = serializeLog(input);
	}
	public log(entry: string, output?: unknown): void {
		if (this.finished) return;
		if (this.logEntries.length < 100) this.logEntries.push(`${new Date().toISOString()}: ${redactText(entry.slice(0, 2000))}`);
		if (output !== undefined && this.outputs.length < 50) this.outputs.push(serializeLog(output, 4096));
	}
	public debug(entry: string, data?: unknown): void { this.log(`[DEBUG] ${entry}`, data); }
	public success(result: unknown): void { this.finish("SUCCESS", result, null); }
	public failed(error: unknown): void { this.finish("FAILED", null, error); }

	private finish(status: ProcessLogRecord["status"], result: unknown, error: unknown): void {
		if (this.finished) return;
		this.log("Process completed", result);
		this.finished = true;
		const endTime = new Date();
		processLogs.save({
			instance: this.instance, processName: this.processName, processId: this.processId, status,
			startTime: this.startTime, endTime, duration: endTime.getTime() - this.startTime.getTime(),
			input: this.input, output: serializeLog(this.outputs.map(value => JSON.parse(value))),
			error: serializeLog(error), errorMessage: status === "FAILED" ? redactText(error instanceof Error ? error.message.slice(0, 2000) : "Processing failed") : "",
			logEntries: serializeLog(this.logEntries),
		});
		this.outputs.length = 0; this.logEntries.length = 0;
	}
}
