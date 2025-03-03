// @ts-ignore
import chalk from "chalk";

class Logger {
	private static logWithDate(level: string, message: string): void {
		const date = new Date().toLocaleString();

		console.log(`${chalk.green(date)} ${level} ${message}`);
	}

	public static info(message: string): void {
		this.logWithDate(chalk.cyan("[INFO]"), `${message}`);
	}

	public static error(message: string, err?: Error): void {
		this.logWithDate(chalk.red("[ERROR]"), `${message}`);

		if (err) {
			console.error(err);
		}
	}

	public static debug(message: string, object?: any): void {
		this.logWithDate(chalk.blue("[DEBUG]"), `${message}`);

		if (object) {
			console.log(object);
		}
	}

	public static warning(message: string): void {
		this.logWithDate(chalk.yellow("[WARNING]"), `${message}`);
	}
}

export default Logger;
