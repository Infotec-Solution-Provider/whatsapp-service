import { Logger } from "@in.pulse-crm/utils";
import remoteSessionMonitorService from "../services/remote-session-monitor.service";

const POLL_INTERVAL_MS = Number(process.env["REMOTE_SESSION_MONITOR_POLL_MS"] || 30_000);
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

class RemoteSessionMonitorRoutine {
	private polling = false;

	public start(): void {
		void this.poll();
		void this.cleanup();

		const pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
		const cleanupTimer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
		pollTimer.unref();
		cleanupTimer.unref();
	}

	private async poll(): Promise<void> {
		if (this.polling) {
			return;
		}

		this.polling = true;
		try {
			await remoteSessionMonitorService.pollAll();
		} catch (error) {
			Logger.error(`[RemoteSessionMonitor] Poll failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.polling = false;
		}
	}

	private async cleanup(): Promise<void> {
		try {
			await remoteSessionMonitorService.cleanupEvents();
		} catch (error) {
			Logger.error(`[RemoteSessionMonitor] Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export default new RemoteSessionMonitorRoutine();