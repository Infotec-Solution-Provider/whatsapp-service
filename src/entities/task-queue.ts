class TaskQueue {
	private readonly queue: Array<() => Promise<any>> = [];
	private readonly running: Array<Promise<any>> = [];
	private readonly concurrencyLimit: number;

	constructor(concurrencyLimit: number) {
		this.concurrencyLimit = concurrencyLimit;
	}

	private async run(task: () => Promise<any>) {
		console.log(
			`Tarefas rodando: ${this.running.length} | Fila: ${this.queue.length}`
		);
		await task();
		if (this.queue.length > 0) {
			await this.run(this.queue.shift()!);
		}
	}

	public add(task: () => Promise<any>) {
		if (this.running.length < this.concurrencyLimit) {
			this.running.push(this.run(task));
		} else {
			this.queue.push(task);
		}
	}

	public completion() {
		return Promise.all(this.running);
	}
}

export default TaskQueue;
