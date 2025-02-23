class Logger {
	private static logWithDate(message: string): void {
		const date = new Date().toLocaleDateString();

		console.log(`${date}: ${message}`);
	}

	public static info(message: string): void {
		this.logWithDate(`[INFO] ${message}`);
	}

	public static error(message: string, err?: Error): void {
		this.logWithDate(`[ERROR] ${message}`);

		if (err) {
			console.error(err);
		}
	}

	public static debug(message: string, object?: any): void {
		this.logWithDate(`[DEBUG] ${message}`);

		if (object) {
			console.log(object);
		}
	}
}

export default Logger;
